import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp } from './test-helpers'

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  vi.unstubAllEnvs()
})

describe('video project Core operations', () => {
  it('opens a persistent Build workspace, edits, and authorizes imported media', async () => {
    const { api, root } = await makeApi()
    apis.push(api)
    const projectPath = join(root, 'workspace')
    mkdirSync(projectPath)
    const opened = await invokeCoreOperation(api, 'videoProject.open', [
      { projectPath, initialize: true },
    ])
    expect(opened.project).toMatchObject({ revision: 0, clips: [] })
    expect(api.host.kept.sessionStore.get(opened.sessionId)).toMatchObject({
      mode: 'build',
      project_path: opened.projectPath,
    })
    const editingAgent = api.host.agentFor(opened.sessionId)
    expect(api.host.tools.get('video_project_read', editingAgent)).toBeDefined()
    expect(api.host.tools.get('read', editingAgent)).toBeUndefined()
    expect(api.host.tools.get('bash', editingAgent)).toBeUndefined()
    const chat = api.host.kept.sessionStore.create('普通对话', { mode: 'chat' })
    expect(
      api.host.tools.get('video_project_read', api.host.agentFor(chat.id)),
    ).toBeUndefined()
    const source = join(root, 'source.png')
    writeFileSync(source, 'image-fixture')
    const imported = await invokeCoreOperation(
      api,
      'videoProject.importAssets',
      [{ sessionId: opened.sessionId, sourcePaths: [source] }],
    )
    const asset = imported.project.assets[0]!
    const added = await invokeCoreOperation(api, 'videoProject.mutate', [
      {
        sessionId: opened.sessionId,
        expectedRevision: imported.project.revision,
        command: { type: 'addClip', assetId: asset.id },
      },
    ])
    expect(added.project.clips).toHaveLength(1)
    const media = await invokeCoreOperation(api, 'files.mediaUrl', [
      {
        source: 'project',
        sessionId: opened.sessionId,
        path: asset.path,
      },
    ])
    expect(media.url).toMatch(/^app:\/\/workspace-media\//)
    const reopened = await invokeCoreOperation(api, 'videoProject.open', [
      { projectPath },
    ])
    expect(reopened.sessionId).toBe(opened.sessionId)
    expect(reopened.project.clips).toHaveLength(1)
    expect(readFileSync(source, 'utf8')).toBe('image-fixture')
  })

  it('rejects forged inputs and stale revisions at the IPC boundary', async () => {
    const { api, root } = await makeApi()
    apis.push(api)
    const projectPath = join(root, 'workspace')
    mkdirSync(projectPath)
    const opened = await invokeCoreOperation(api, 'videoProject.open', [
      { projectPath, initialize: true },
    ])
    await expect(
      invokeCoreOperation(api, 'videoProject.open', [
        { projectPath, initialize: true, forged: true } as never,
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(api, 'videoProject.undo', [
        {
          sessionId: opened.sessionId,
          expectedRevision: 99,
        },
      ]),
    ).rejects.toThrow(/重新加载/)
    await expect(
      invokeCoreOperation(api, 'videoProject.importAssets', [
        {
          sessionId: 'draft:unsafe',
          sourcePaths: ['/tmp/source.png'],
        },
      ]),
    ).rejects.toThrow(/持久 Build/)
  })
})

it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
  'issues session-bound opaque handles for regenerable media and supports clearing and rebuilding it',
  async () => {
    const root = tmp('cutroom-preview-grants-')
    vi.stubEnv('CUTROOM_CACHE_DIR', join(root, 'cache-for-test'))
    const { api } = await makeApi({ root })
    apis.push(api)
    const folder = join(root, 'edit')
    const other = join(root, 'other')
    mkdirSync(folder)
    mkdirSync(other)
    const current = await api.videoProject.open({
      projectPath: folder,
      initialize: true,
    })
    const foreign = await api.videoProject.open({
      projectPath: other,
      initialize: true,
    })
    const video = join(root, 'sample.mp4')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=48x32:r=10:d=1',
      '-c:v',
      'libx264',
      video,
    ])
    const imported = await api.videoProject.importAssets({
      sessionId: current.sessionId,
      sourcePaths: [video],
    })
    const input = {
      sessionId: current.sessionId,
      assetId: imported.project.assets[0]!.id,
      kind: 'poster' as const,
    }
    const result = await invokeCoreOperation(api, 'videoProject.previewMedia', [
      input,
    ])
    expect(result.path).toMatch(/^cutroom-preview:[a-f0-9]{32}$/)
    const handle = result.path.split(':')[1]!
    await expect(
      invokeCoreOperation(api, 'videoProject.cacheMediaUrl', [
        { sessionId: foreign.sessionId, handle },
      ]),
    ).rejects.toThrow()
    const { url } = await invokeCoreOperation(
      api,
      'videoProject.cacheMediaUrl',
      [{ sessionId: current.sessionId, handle }],
    )
    const token = new URL(url).pathname.slice(1)
    const grant = api.files.mediaGrant(token)!
    expect(grant.sessionId).toBe(current.sessionId)
    expect(grant.absPath.startsWith(current.projectPath + '/')).toBe(false)
    expect(readFileSync(grant.absPath).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
    expect(
      await invokeCoreOperation(api, 'videoProject.clearMediaCache', []),
    ).toMatchObject({ removedFiles: 1, files: 0 })
    await expect(
      invokeCoreOperation(api, 'videoProject.cacheMediaUrl', [
        { sessionId: current.sessionId, handle },
      ]),
    ).rejects.toThrow()
    expect(
      (await invokeCoreOperation(api, 'videoProject.previewMedia', [input]))
        .proxy,
    ).toBe(true)
    expect(
      (await invokeCoreOperation(api, 'videoProject.mediaCacheUsage', []))
        .files,
    ).toBe(1)
    expect((await api.videoProject.inspect(input.sessionId)).project).toEqual(
      imported.project,
    )
    await invokeCoreOperation(api, 'videoProject.clearMediaCache', [])
  },
)
