import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VideoProjectResult } from './types'
import * as workspace from './workspace-inputs'

let root: string
let snapshot: VideoProjectResult
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'video-workspace-media-')))
  const now = new Date().toISOString()
  snapshot = {
    projectPath: root,
    sessionId: 'thread',
    canUndo: false,
    canRedo: false,
    project: {
      schemaVersion: 2,
      projectId: 'project',
      name: 'test',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      assets: [
        {
          id: 'original',
          kind: 'video',
          path: 'TAKE_001.MOV',
          displayName: 'TAKE_001.MOV',
          duration: 12,
          width: 720,
          height: 1280,
        },
      ],
      tracks: [{ id: 'main', name: 'Main', index: 0, kind: 'video' }],
      clips: [],
      subtitles: [],
      canvas: { fit: 'contain', background: '#000000' },
    },
  }
  await writeFile(join(root, 'TAKE_001.MOV'), 'original source data')
})
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('workspace source inventory', () => {
  it('uses byte equality for legacy render copies and leaves lookalike names unresolved', async () => {
    const review = join(
      root,
      '.cutroom/precision/2579889b-757b-470c-8cbd-4407513322e8',
    )
    await mkdir(review, { recursive: true })
    await writeFile(join(review, 'review-9.mp4'), 'previous review file')
    await copyFile(join(review, 'review-9.mp4'), join(root, 'legacy.mp4'))
    await writeFile(join(root, 'TAKE_001-最终.mp4'), 'not a previous file!')
    const inventory = await workspace.workspaceMediaInventory(snapshot)
    expect(inventory.sources.map((entry) => entry.path)).toEqual([
      'TAKE_001.MOV',
    ])
    expect(inventory.outputs.map((entry) => entry.path)).toEqual(['legacy.mp4'])
    expect(inventory.unresolved.map((entry) => entry.path)).toEqual([
      'TAKE_001-最终.mp4',
    ])
    await expect(
      workspace.discoverWorkspaceMedia(snapshot, 'unused'),
    ).resolves.toEqual([])
    await expect(
      workspace.discoverWorkspaceMedia(snapshot, 'unused', ['legacy.mp4']),
    ).rejects.toMatchObject({ code: 'invalid_workspace_source_selection' })
  })

  it('records renamed exports and stops trusting a receipt when the file at that path changes', async () => {
    const output = join(root, 'delivered.mp4')
    await writeFile(output, 'published copy')
    await workspace.recordWorkspaceOutput(snapshot, output)
    expect(
      (await workspace.workspaceMediaInventory(snapshot)).outputs.map(
        (entry) => entry.path,
      ),
    ).toEqual(['delivered.mp4'])
    await writeFile(output, 'replacement')
    const inventory = await workspace.workspaceMediaInventory(snapshot)
    expect(inventory.outputs).toEqual([])
    expect(inventory.unresolved.map((entry) => entry.path)).toEqual([
      'delivered.mp4',
    ])
  })
})
