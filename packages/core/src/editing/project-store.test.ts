import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoProjectService, type VideoProjectSession } from './index'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'video-project-'))
  roots.push(root)
  const sessions = new Map<string, VideoProjectSession>()
  let sequence = 0
  const service = new VideoProjectService({
    getSession: (id) => sessions.get(id) ?? null,
    createBuildSession: (projectPath, title) => {
      const session = {
        id: `session-${++sequence}`,
        mode: 'build',
        project_path: projectPath,
        title,
      }
      sessions.set(session.id, session)
      return session
    },
  })
  return { root, service, sessions }
}

async function initialized() {
  const context = setup()
  const opened = await context.service.open({
    projectPath: context.root,
    initialize: true,
  })
  return { ...context, opened, sessionId: opened.sessionId }
}

describe('VideoProjectService persistence and workspace ownership', () => {
  it('initializes and reopens one project with one persistent Build session', async () => {
    const { root, service, sessions, opened } = await initialized()
    expect(opened.project).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      clips: [],
      subtitles: [],
      tracks: [{ id: 'main', kind: 'video', name: '主画面', index: 0 }],
    })
    expect(opened.sessionId).toBe('session-1')
    expect(sessions.get(opened.sessionId)?.project_path).toBe(
      opened.projectPath,
    )
    const again = await service.open({ projectPath: root })
    expect(again.sessionId).toBe(opened.sessionId)
    expect(again.project.projectId).toBe(opened.project.projectId)
    expect(sessions).toHaveProperty('size', 1)
    expect(
      JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8')),
    ).toEqual(opened.project)
    expect(existsSync(join(root, 'video-edit.json'))).toBe(false)
  })

  it('opens a folder containing only a timeline manifest', async () => {
    const source = await initialized()
    const { root, service } = setup()
    writeFileSync(
      join(root, 'timeline.json'),
      JSON.stringify(source.opened.project),
    )

    const opened = await service.open({ projectPath: root })
    expect(opened.project).toEqual(source.opened.project)
    expect(existsSync(join(root, 'video-edit.json'))).toBe(false)
  })

  it.each(['timeline.json', 'video-edit.json'])(
    'adopts and undoes a draft in the original %s manifest',
    async (filename) => {
      const source = await initialized()
      const { root, service } = setup()
      const path = join(root, filename)
      const alternate = join(
        root,
        filename === 'timeline.json' ? 'video-edit.json' : 'timeline.json',
      )
      writeFileSync(path, JSON.stringify(source.opened.project))
      const { project, sessionId } = await service.open({ projectPath: root })
      const draft = {
        ...project,
        annotations: [
          {
            id: 'box',
            kind: 'box' as const,
            start: 1,
            end: 2,
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
            color: '#ffcb46',
          },
        ],
        captionStyle: {
          fontSize: 72,
          color: '#ffffff',
          position: 'top' as const,
        },
      }
      const adopted = await service.commitEditDraft({
        sessionId,
        expectedRevision: project.revision,
        draft,
      })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(adopted.project)
      expect(adopted.project.annotations).toEqual(draft.annotations)
      expect(adopted.project.captionStyle).toEqual(draft.captionStyle)
      expect(existsSync(alternate)).toBe(false)

      const undone = await service.undo({
        sessionId,
        expectedRevision: adopted.project.revision,
      })
      expect(undone.project.annotations).toBeUndefined()
      expect(undone.project.captionStyle).toBeUndefined()
      const redone = await service.redo({
        sessionId,
        expectedRevision: undone.project.revision,
      })
      expect(redone.project.annotations).toEqual(draft.annotations)
      expect(redone.project.captionStyle).toEqual(draft.captionStyle)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(redone.project)
      expect((await service.open({ projectPath: root })).project).toEqual(
        redone.project,
      )
      expect(existsSync(alternate)).toBe(false)
    },
  )

  it('persists authored scenes, returns their selection and undoes or redoes a timeline split in one step', async () => {
    const { root, service, opened, sessionId } = await initialized()
    const scene = {
      id: 'title',
      name: '开场',
      version: 1,
      startFrame: 20,
      durationFrames: 41,
      sourceInFrame: 8,
      mode: 'overlay' as const,
      story: '片名从左侧进入',
      objects: [
        {
          id: 'heading',
          name: '标题',
          html: '<h1>开场</h1>',
          draw: 'root.style.opacity = t',
          bounds: { x: 0, y: 10, width: 900, height: 130 },
          markers: [{ frame: 10, label: '开始' }],
        },
      ],
    }
    const draft = { ...opened.project, motionScenes: [scene] }
    const saved = await service.commitEditDraft({
      sessionId,
      expectedRevision: opened.project.revision,
      draft,
    })
    const split = await service.mutate({
      sessionId,
      expectedRevision: saved.project.revision,
      command: { type: 'splitMotionScene', sceneId: scene.id, frame: 39 },
    })
    expect(split.selectedMotionSceneId).toBe(split.project.motionScenes![1]!.id)
    expect(split.project.motionScenes![1]!.sourceInFrame).toBe(27)
    const undone = await service.undo({
      sessionId,
      expectedRevision: split.project.revision,
    })
    expect(undone.project.motionScenes).toEqual([scene])
    const redone = await service.redo({
      sessionId,
      expectedRevision: undone.project.revision,
    })
    expect(redone.project.motionScenes).toEqual(split.project.motionScenes)
    expect(
      JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8'))
        .motionScenes,
    ).toEqual(redone.project.motionScenes)
    expect(
      (await service.open({ projectPath: root })).project.motionScenes,
    ).toEqual(redone.project.motionScenes)
  })

  it('writes a single object deletion as one reversible history entry without changing neighbouring scenes', async () => {
    const { service, opened, sessionId } = await initialized()
    const object = {
      id: 'one',
      name: '对象一',
      html: '',
      draw: '',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      markers: [{ frame: 0, label: '开始' }],
    }
    const scene = {
      id: 'a',
      name: '第一幕',
      mode: 'overlay' as const,
      story: '',
      startFrame: 0,
      durationFrames: 30,
      sourceInFrame: 0,
      version: 4,
      objects: [object, { ...object, id: 'two' }],
    }
    const scenes = [scene, { ...scene, id: 'b', startFrame: 30 }]
    const saved = await service.commitEditDraft({
      sessionId,
      expectedRevision: opened.project.revision,
      draft: { ...opened.project, motionScenes: scenes },
    })
    const deleted = await service.mutate({
      sessionId,
      expectedRevision: saved.project.revision,
      command: {
        type: 'deleteMotionObject',
        sceneId: 'a',
        objectId: 'one',
        expectedVersion: 4,
      },
    })
    expect(deleted.project.motionScenes).toEqual([
      { ...scene, objects: [scene.objects[1]], version: 5 },
      scenes[1],
    ])
    expect((await service.open({ sessionId })).project.motionScenes).toEqual(
      deleted.project.motionScenes,
    )
    const undone = await service.undo({
      sessionId,
      expectedRevision: deleted.project.revision,
    })
    expect(undone.project.motionScenes).toEqual(scenes)
    const redone = await service.redo({
      sessionId,
      expectedRevision: undone.project.revision,
    })
    expect(redone.project.motionScenes).toEqual(deleted.project.motionScenes)
  })

  it('keeps using its bound timeline when a legacy file also appears', async () => {
    const { root, service, sessionId, opened } = await initialized()
    const alternate = join(root, 'video-edit.json')
    const alternateBody = JSON.stringify({ ...opened.project, revision: 99 })
    writeFileSync(alternate, alternateBody)

    const reopened = await service.open({ projectPath: root })
    expect(reopened.project.revision).toBe(0)
    const changed = await service.mutate({
      sessionId,
      expectedRevision: 0,
      command: { type: 'updateCanvas', background: '#ffffff' },
    })
    expect(
      JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8')),
    ).toEqual(changed.project)
    expect(readFileSync(alternate, 'utf8')).toBe(alternateBody)
  })

  it('reports a missing bound manifest without switching to an alternate file', async () => {
    const { root, service, opened } = await initialized()
    const alternate = join(root, 'video-edit.json')
    const alternateBody = JSON.stringify({ ...opened.project, revision: 99 })
    writeFileSync(alternate, alternateBody)
    rmSync(join(root, 'timeline.json'))

    await expect(
      service.open({ projectPath: root, initialize: true }),
    ).rejects.toMatchObject({
      code: 'project_invalid',
    })
    expect(readFileSync(alternate, 'utf8')).toBe(alternateBody)
    expect(existsSync(join(root, 'timeline.json'))).toBe(false)
  })

  it('migrates a v1 project to sequential main-track clips and backs it up', async () => {
    const { root, service } = setup()
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets', 'a.mp4'), 'video')
    const v1 = {
      schemaVersion: 1,
      projectId: 'legacy-project',
      name: 'Legacy',
      revision: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      assets: [
        {
          id: 'asset-a',
          kind: 'video',
          path: 'assets/a.mp4',
          displayName: 'a.mp4',
          duration: 10,
          width: 1920,
          height: 1080,
        },
      ],
      clips: [
        {
          id: 'clip-a',
          assetId: 'asset-a',
          sourceIn: 0,
          sourceOut: 2,
          speed: 1,
          volume: 1,
          muted: false,
          transform: { scale: 1, x: 0, y: 0 },
        },
        {
          id: 'clip-b',
          assetId: 'asset-a',
          sourceIn: 2,
          sourceOut: 5,
          speed: 1,
          volume: 1,
          muted: false,
          transform: { scale: 1, x: 0, y: 0 },
        },
      ],
      canvas: { fit: 'contain', background: '#000000' },
    }
    writeFileSync(join(root, 'video-edit.json'), JSON.stringify(v1))
    const opened = await service.open({ projectPath: root })
    expect(opened.project.schemaVersion).toBe(2)
    expect(opened.project.revision).toBe(5)
    expect(opened.project.tracks).toEqual([
      { id: 'main', kind: 'video', name: '主画面', index: 0 },
    ])
    expect(opened.project.clips.map((clip) => clip.timelineStart)).toEqual([
      0, 2,
    ])
    expect(opened.project.subtitles).toEqual([])
    const saved = JSON.parse(
      readFileSync(join(root, 'video-edit.json'), 'utf8'),
    )
    expect(saved.schemaVersion).toBe(2)
    const migrations = readdirSync(join(root, '.cutroom', 'migrations'))
    expect(migrations).toHaveLength(1)
    expect(
      JSON.parse(
        readFileSync(
          join(root, '.cutroom', 'migrations', migrations[0]!),
          'utf8',
        ),
      ).schemaVersion,
    ).toBe(1)
    const again = await service.open({ projectPath: root })
    expect(again.project.revision).toBe(5)
  })

  it('requires initialization before creating files or a session', async () => {
    const { root, service, sessions } = setup()
    await expect(service.open({ projectPath: root })).rejects.toMatchObject({
      code: 'project_not_initialized',
    })
    expect(sessions.size).toBe(0)
  })

  it('repairs missing workspace metadata without replacing the project', async () => {
    const { root, service, sessions, opened } = await initialized()
    rmSync(join(root, '.cutroom'), { recursive: true })
    const recovered = await service.open({ projectPath: root })
    expect(recovered.project.projectId).toBe(opened.project.projectId)
    expect(recovered.sessionId).not.toBe(opened.sessionId)
    expect(sessions.size).toBe(2)
  })

  it('rejects chat, draft, and unknown sessions for project operations', async () => {
    const { root, service, sessions } = await initialized()
    sessions.set('chat', { id: 'chat', mode: 'chat', project_path: root })
    sessions.set('draft:1', {
      id: 'draft:1',
      mode: 'build',
      project_path: root,
    })
    for (const sessionId of ['chat', 'draft:1', 'missing']) {
      await expect(service.open({ sessionId })).rejects.toMatchObject({
        code: 'workspace_session_required',
      })
    }
  })

  it('copies imports into assets with collision-safe names and preserves originals', async () => {
    const { root, service, opened, sessionId } = await initialized()
    const source = join(root, '..', `${Date.now()}-source.mp4`)
    writeFileSync(source, 'original-video')
    roots.push(source)
    const first = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const second = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    expect(first.project.assets).toHaveLength(1)
    expect(second.project.assets).toHaveLength(2)
    expect(second.project.assets[0]?.path).not.toBe(
      second.project.assets[1]?.path,
    )
    expect(readFileSync(source, 'utf8')).toBe('original-video')
    for (const asset of second.project.assets) {
      expect(asset.path).toMatch(/^assets\/[a-f0-9-]+\.mp4$/)
      expect(readFileSync(join(root, asset.path), 'utf8')).toBe(
        'original-video',
      )
    }
    expect(opened.project.revision).toBe(0)
  })

  it('rejects unsupported imports without modifying the project', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'notes.txt')
    writeFileSync(source, 'not media')
    await expect(
      service.importAssets({ sessionId, sourcePaths: [source] }),
    ).rejects.toThrow(/不支持/)
    const current = await service.open({ sessionId })
    expect(current.project.assets).toEqual([])
  })

  it('updates validated media metadata with revision checks', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'source.mp4')
    writeFileSync(source, 'video')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const asset = imported.project.assets[0]!
    const updated = await service.updateAssetMetadata({
      sessionId,
      expectedRevision: imported.project.revision,
      assetId: asset.id,
      duration: 4.5,
      width: 1280,
      height: 720,
    })
    expect(updated.project.assets[0]).toMatchObject({
      duration: 4.5,
      width: 1280,
      height: 720,
    })
    await expect(
      service.updateAssetMetadata({
        sessionId,
        expectedRevision: imported.project.revision,
        assetId: asset.id,
        duration: 4.5,
        width: 1280,
        height: 720,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('never overwrites a newer revision on conflict', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'source.png')
    writeFileSync(source, 'image')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const assetId = imported.project.assets[0]!.id
    await expect(
      service.mutate({
        sessionId,
        expectedRevision: 0,
        command: { type: 'addClip', assetId },
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(
      JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8')).revision,
    ).toBe(1)
  })

  it('undoes and redoes edits with monotonic revisions', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'source.png')
    writeFileSync(source, 'image')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const assetId = imported.project.assets[0]!.id
    const added = await service.mutate({
      sessionId,
      expectedRevision: imported.project.revision,
      command: { type: 'addClip', assetId },
    })
    expect(added).toMatchObject({ canUndo: true, canRedo: false })
    const undone = await service.undo({
      sessionId,
      expectedRevision: added.project.revision,
    })
    expect(undone.project.clips).toEqual([])
    expect(undone.project.revision).toBeGreaterThan(added.project.revision)
    expect(undone).toMatchObject({ canUndo: false, canRedo: true })
    const redone = await service.redo({
      sessionId,
      expectedRevision: undone.project.revision,
    })
    expect(redone.project.clips).toHaveLength(1)
    expect(redone.project.revision).toBeGreaterThan(undone.project.revision)
  })

  it('fails on damaged JSON without replacing it with an empty project', async () => {
    const { root, service, sessionId } = await initialized()
    const path = join(root, 'timeline.json')
    writeFileSync(path, '{broken')
    await expect(service.open({ sessionId })).rejects.toMatchObject({
      code: 'project_invalid',
    })
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('rejects project paths and symlinked assets that escape the workspace', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'source.png')
    writeFileSync(source, 'image')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const projectPath = join(root, 'timeline.json')
    const document = JSON.parse(readFileSync(projectPath, 'utf8')) as {
      assets: Array<{ path: string }>
    }
    document.assets[0]!.path = '../outside.png'
    writeFileSync(projectPath, JSON.stringify(document))
    await expect(service.open({ sessionId })).rejects.toMatchObject({
      code: 'project_invalid',
    })
    document.assets[0]!.path = imported.project.assets[0]!.path
    writeFileSync(projectPath, JSON.stringify(document))
    const target = join(root, 'outside.png')
    writeFileSync(target, 'outside')
    rmSync(join(root, imported.project.assets[0]!.path))
    symlinkSync(target, join(root, imported.project.assets[0]!.path))
    await expect(service.open({ sessionId })).rejects.toMatchObject({
      code: 'workspace_path_escape',
    })
  })
})

describe('project integrity on disk', () => {
  it('serializes initialization and restricts the bound session', async () => {
    const { root, service, sessions } = setup()
    const [a, b] = await Promise.all(
      [1, 2].map(() => service.open({ projectPath: root, initialize: true })),
    )
    expect(a!.project.projectId).toBe(b!.project.projectId)
    expect(a!.sessionId).toBe(b!.sessionId)
    sessions.set('other', { id: 'other', mode: 'build', project_path: root })
    await expect(service.open({ sessionId: 'other' })).rejects.toMatchObject({
      code: 'workspace_session_required',
    })
    await expect(service.inspect('other')).rejects.toMatchObject({
      code: 'workspace_session_required',
    })
  })

  it('rejects metadata that would invalidate a clip and preserves timeline undo across imports', async () => {
    const { root, sessionId, service } = await initialized()
    const source = join(root, 'demo.mp4')
    writeFileSync(source, 'demo')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const assetId = imported.project.assets[0]!.id
    const metadata = {
      sessionId,
      assetId,
      expectedRevision: 1,
      duration: 2,
      width: 320,
      height: 240,
    }
    await service.updateAssetMetadata(metadata)
    await service.mutate({
      sessionId,
      expectedRevision: 2,
      command: { type: 'addClip', assetId },
    })
    await expect(
      service.updateAssetMetadata({
        ...metadata,
        expectedRevision: 3,
        duration: 1,
      }),
    ).rejects.toThrow()
    const two = await service.importAssets({ sessionId, sourcePaths: [source] })
    expect(two.canUndo).toBe(true)
    const undone = await service.undo({ sessionId, expectedRevision: 4 })
    expect(undone.project.clips).toHaveLength(0)
    expect(undone.project.assets).toHaveLength(2)
  })

  it('opens missing media, relinks clips and removes unavailable references', async () => {
    const { root, service, sessionId } = await initialized()
    const source = join(root, 'test.png')
    writeFileSync(source, 'image')
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const asset = imported.project.assets[0]!
    const edited = await service.mutate({
      sessionId,
      expectedRevision: 1,
      command: { type: 'addClip', assetId: asset.id },
    })
    rmSync(join(root, asset.path))
    expect((await service.inspect(sessionId)).missingAssetIds).toEqual([
      asset.id,
    ])
    const restored = await service.relinkAsset({
      sessionId,
      assetId: asset.id,
      expectedRevision: 2,
      sourcePath: source,
    })
    expect(restored.project.clips).toEqual(edited.project.clips)
    expect(restored.project.assets[0]!.path).not.toBe(asset.path)
    rmSync(join(root, restored.project.assets[0]!.path))
    const removed = await service.removeMissingAsset({
      sessionId,
      assetId: asset.id,
      expectedRevision: 3,
    })
    expect(removed.project.assets).toHaveLength(0)
    expect(removed.project.clips).toHaveLength(0)
  })

  it.skipIf(
    ['ffmpeg', 'ffprobe'].some(
      (tool) => spawnSync(tool, ['-version']).status !== 0,
    ),
  )('leaves a used asset offline if the replacement is too short', async () => {
    const { root, service, sessionId } = await initialized()
    const original = join(root, 'original.mp4')
    const replacement = join(root, 'short.mp4')
    for (const [path, duration] of [
      [original, 2],
      [replacement, 1],
    ] as const)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=black:s=16x16:d=${duration}`,
        path,
      ])
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [original],
    })
    const asset = imported.project.assets[0]!
    const measured = await service.updateAssetMetadata({
      sessionId,
      expectedRevision: 1,
      assetId: asset.id,
      duration: 2,
      width: 16,
      height: 16,
    })
    const edited = await service.mutate({
      sessionId,
      expectedRevision: measured.project.revision,
      command: { type: 'addClip', assetId: asset.id },
    })
    rmSync(join(root, asset.path))
    await expect(
      service.relinkAsset({
        sessionId,
        expectedRevision: edited.project.revision,
        assetId: asset.id,
        sourcePath: replacement,
      }),
    ).rejects.toMatchObject({ code: 'replacement_too_short' })
    expect(await service.inspect(sessionId)).toMatchObject({
      missingAssetIds: [asset.id],
      project: { revision: edited.project.revision },
    })
  })
})

it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
  'imports and relinks real narration with no picture dimensions',
  async () => {
    const { service, root, sessionId } = await initialized()
    const source = join(root, 'narration.wav')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=d=1',
      source,
    ])
    const imported = await service.importAssets({
      sessionId,
      sourcePaths: [source],
    })
    const asset = imported.project.assets[0]!
    expect(asset).toMatchObject({ kind: 'audio', width: null, height: null })
    const identified = await service.updateAssetMetadata({
      sessionId,
      expectedRevision: imported.project.revision,
      assetId: asset.id,
      duration: 1,
      width: null,
      height: null,
    })
    const placed = await service.mutate({
      sessionId,
      expectedRevision: identified.project.revision,
      command: { type: 'addClip', assetId: asset.id },
    })
    rmSync(join(root, asset.path))
    const repaired = await service.relinkAsset({
      sessionId,
      expectedRevision: placed.project.revision,
      assetId: asset.id,
      sourcePath: source,
    })
    expect(repaired.project.assets[0]).toMatchObject({
      id: asset.id,
      kind: 'audio',
      width: null,
      height: null,
      duration: 1,
    })
    expect(repaired.project.clips[0]?.sourceOut).toBe(1)
  },
)

it('exposes a read-only snapshot for conflicting roots and retries without replacing user data', async () => {
  const { root, opened, service, sessionId } = await initialized()
  renameSync(join(root, '.cutroom'), join(root, '.video-edit-agent'))
  mkdirSync(join(root, '.cutroom'))
  writeFileSync(join(root, '.cutroom/other'), 'keep')
  const readonly = await service.open({ projectPath: root })
  expect(readonly.project).toEqual(opened.project)
  expect(readonly.readOnlyReason).toContain('冲突')
  expect(readFileSync(join(root, '.cutroom/other'), 'utf8')).toBe('keep')
  await expect(service.inspect(sessionId)).rejects.toMatchObject({
    code: 'project_migration_blocked',
  })
  renameSync(join(root, '.cutroom'), join(root, 'my-conflict-backup'))
  // A prior process was stopped after copying files to its private stage.
  mkdirSync(join(root, '.cutroom-migration-v1/data'), { recursive: true })
  writeFileSync(
    join(root, '.cutroom-migration-v1/owner'),
    'Cutroom migration staging area v1\n',
  )
  writeFileSync(join(root, '.cutroom-migration-v1/data/partial'), 'interrupted')
  const retried = await service.open({ projectPath: root })
  expect(retried.readOnlyReason).toBeUndefined()
  expect(retried.sessionId).toBe(sessionId)
  expect(existsSync(join(root, '.cutroom/partial'))).toBe(false)
  expect((await service.open({ projectPath: root })).project).toEqual(
    opened.project,
  )
})

it('views a legacy project on a read-only volume without creating files or rewriting its manifest', async () => {
  const { root, opened, service } = await initialized()
  renameSync(join(root, '.cutroom'), join(root, '.video-edit-agent'))
  const before = readFileSync(join(root, 'timeline.json'))
  chmodSync(root, 0o555)
  try {
    const snapshot = await service.open({ projectPath: root })
    expect(snapshot.readOnlyReason).toBeTruthy()
    expect(snapshot.project).toEqual(opened.project)
    expect(existsSync(join(root, '.cutroom'))).toBe(false)
    expect(readFileSync(join(root, 'timeline.json'))).toEqual(before)
  } finally {
    chmodSync(root, 0o700)
  }
})

it('preserves a signed record with no matching installation key and leaves the target uncommitted', async () => {
  const { root, service, opened } = await initialized()
  renameSync(join(root, '.cutroom'), join(root, '.video-edit-agent'))
  const folder = join(
    root,
    '.video-edit-agent/precision/b00f30ca-c926-41a6-9696-8c725cca80c8',
  )
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'run.json'), 'unverified original')
  const readOnly = await service.open({ projectPath: root })
  expect(readOnly.project).toEqual(opened.project)
  expect(readOnly.readOnlyReason).toContain('密钥')
  expect(existsSync(join(root, '.cutroom'))).toBe(false)
  expect(readFileSync(join(folder, 'run.json'), 'utf8')).toBe(
    'unverified original',
  )
})
