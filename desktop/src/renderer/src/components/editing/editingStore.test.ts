import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MotionScene,
  VideoProject,
  VideoProjectResult,
} from '@emperor/core/editing'
import { createEditingWorkspace, type MotionWork } from './editingStore'

const project: VideoProject = {
  schemaVersion: 2,
  projectId: 'project-1',
  name: 'Launch film',
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assets: [
    {
      id: 'asset-1',
      kind: 'video',
      path: 'assets/a.mp4',
      displayName: 'a.mp4',
      duration: 8,
      width: 1920,
      height: 1080,
    },
  ],
  tracks: [{ id: 'main', kind: 'video', name: '主画面', index: 0 }],
  subtitles: [],
  clips: [
    {
      id: 'clip-1',
      trackId: 'main',
      assetId: 'asset-1',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 8,
      speed: 1,
      volume: 1,
      muted: false,
      transform: { scale: 1, x: 0, y: 0 },
    },
  ],
  canvas: { fit: 'contain', background: '#000000' },
}

function result(patch: Partial<VideoProjectResult> = {}): VideoProjectResult {
  return {
    project: structuredClone(project),
    sessionId: 'session-1',
    projectPath: '/tmp/edit',
    canUndo: false,
    canRedo: false,
    ...patch,
  }
}

function draft(generation: number, sourceOut = 3) {
  const copy = structuredClone(project)
  copy.clips[0]!.sourceOut = sourceOut
  return {
    runId: 'run-1',
    generation,
    state: 'rough_cut' as const,
    project: copy,
    missingAssetIds: [],
    change: { clipIds: ['clip-1'], subtitleIds: [], trackIds: [], time: 1 },
  }
}

function setup() {
  const core = vi.fn()
  const selectDirectory = vi.fn<
    (options?: {
      title?: string
      createDirectory?: boolean
    }) => Promise<string | null>
  >(async () => '/tmp/edit')
  const selectMediaFiles = vi.fn(async () => ['/tmp/source.mp4'])
  const confirm = vi.fn(async () => true)
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const workspace = createEditingWorkspace({
    core,
    selectDirectory,
    selectMediaFiles,
    confirm,
    storage,
  })
  return {
    core,
    selectDirectory,
    selectMediaFiles,
    confirm,
    storage,
    values,
    workspace,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('editing workspace store', () => {
  it('shows the first draft without changing the live timeline or opening live write paths', async () => {
    const { workspace, core, selectMediaFiles } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.setPlayhead(7)
    core.mockResolvedValueOnce(draft(1))
    await workspace.refreshDraft()
    expect(workspace.displayProject.value?.clips[0]?.sourceOut).toBe(3)
    expect(workspace.state.project?.clips[0]?.sourceOut).toBe(8)
    expect(workspace.state.playhead).toBe(3)
    expect(workspace.canDelete.value).toBe(false)
    await workspace.deleteSelection()
    await workspace.mutate({ type: 'deleteClip', clipId: 'clip-1' })
    await workspace.importAssets()
    await workspace.undo()
    expect(selectMediaFiles).not.toHaveBeenCalled()
    expect(core.mock.calls.map(([operation]) => operation)).toEqual([
      'videoProject.open',
      'videoProject.editRunDraft',
    ])
    workspace.seekDraftChange()
    expect(workspace.state.playhead).toBe(1)
    workspace.selectView('live')
    expect(workspace.state.playhead).toBe(7)
    core.mockResolvedValueOnce(draft(2, 2))
    await workspace.refreshDraft()
    expect(workspace.displayProject.value?.clips[0]?.sourceOut).toBe(8)
    workspace.selectView('draft')
    expect(workspace.displayProject.value?.clips[0]?.sourceOut).toBe(2)
    expect(workspace.state.playhead).toBe(1)
  })

  it('rejects superseded draft requests across generations, runs, and project sessions', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    let resolveStale!: (data: ReturnType<typeof draft>) => void
    core.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof draft>>((resolve) => {
          resolveStale = resolve
        }),
    )
    const stale = workspace.refreshDraft()
    core.mockResolvedValueOnce({ ...draft(1), runId: 'run-2' })
    await workspace.refreshDraft()
    resolveStale(draft(4))
    await stale
    expect(workspace.state.draft?.runId).toBe('run-2')

    core.mockResolvedValueOnce({ ...draft(3), runId: 'run-2' })
    await workspace.refreshDraft()
    core.mockResolvedValueOnce({ ...draft(2), runId: 'run-2' })
    await workspace.refreshDraft()
    expect(workspace.state.draft?.generation).toBe(3)

    core.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof draft>>((resolve) => {
          resolveStale = resolve
        }),
    )
    const previousSession = workspace.refreshDraft()
    core.mockResolvedValueOnce(result({ sessionId: 'session-2' }))
    await workspace.openProject({ sessionId: 'session-2' })
    resolveStale({ ...draft(4), runId: 'run-2' })
    await previousSession
    expect(workspace.state.draft).toBeNull()
    expect(workspace.state.sessionId).toBe('session-2')
  })

  it('reopens a running draft with the same explicit view selection', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(draft(1))
    await workspace.refreshDraft()
    workspace.selectView('live')
    workspace.closeProject()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(draft(2))
    await workspace.refreshDraft()
    expect(workspace.readOnly.value).toBe(false)
    expect(workspace.draftAvailable.value).toBe(true)

    core.mockResolvedValueOnce({ ...draft(1), runId: 'run-2' })
    await workspace.refreshDraft()
    expect(workspace.readOnly.value).toBe(true)
  })

  it('keeps a delivered draft visible until the committed revision loads', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(draft(1))
    await workspace.refreshDraft()
    const current = draft(1)
    const committed = { ...current.project, revision: 1 }
    core.mockResolvedValueOnce({
      ...current,
      state: 'delivered',
      revision: 1,
    })
    let resolveProject!: (data: VideoProjectResult) => void
    core.mockImplementationOnce(
      () =>
        new Promise<VideoProjectResult>((resolve) => {
          resolveProject = resolve
        }),
    )
    const delivery = workspace.refreshDraft()
    await vi.waitFor(() => expect(resolveProject).toBeTypeOf('function'))
    expect(workspace.readOnly.value).toBe(true)
    expect(workspace.displayProject.value?.clips[0]?.sourceOut).toBe(3)
    resolveProject(result({ project: committed }))
    await delivery
    expect(workspace.readOnly.value).toBe(false)
    expect(workspace.displayProject.value?.revision).toBe(1)
  })

  it('sends ripple deletion with the selected clip interval on the live timeline', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(
      result({ project: { ...project, clips: [], revision: 1 } }),
    )
    await workspace.rippleDeleteSelection()
    expect(core).toHaveBeenLastCalledWith('videoProject.mutate', {
      sessionId: 'session-1',
      expectedRevision: 0,
      command: { type: 'rippleDeleteRange', start: 0, end: 8 },
    })
    expect(workspace.displayProject.value?.clips).toEqual([])
  })

  it('does nothing when the native directory picker is cancelled', async () => {
    const context = setup()
    context.selectDirectory.mockResolvedValue(null)
    await expect(context.workspace.pickWorkspace()).resolves.toBe(false)
    expect(context.core).not.toHaveBeenCalled()
  })

  it('asks before initializing a folder and honors cancellation', async () => {
    const context = setup()
    context.core.mockRejectedValue(
      Object.assign(new Error('initialize'), {
        code: 'project_not_initialized',
      }),
    )
    context.confirm.mockResolvedValue(false)
    await expect(context.workspace.pickWorkspace()).resolves.toBe(false)
    expect(context.confirm).toHaveBeenCalledOnce()
    expect(context.core).toHaveBeenCalledTimes(1)
    context.core.mockReset()
    context.confirm.mockResolvedValue(true)
    context.core.mockRejectedValueOnce(
      Object.assign(new Error('initialize'), {
        code: 'project_not_initialized',
      }),
    )
    context.core.mockResolvedValueOnce(result())
    await context.workspace.pickWorkspace()
    expect(context.core).toHaveBeenLastCalledWith('videoProject.open', {
      projectPath: '/tmp/edit',
      initialize: true,
    })
  })

  it('creates a project in a chosen folder after confirmation', async () => {
    const context = setup()
    context.core
      .mockRejectedValueOnce(
        Object.assign(new Error('initialize'), {
          code: 'project_not_initialized',
        }),
      )
      .mockResolvedValueOnce(result())
    await expect(context.workspace.createProject()).resolves.toBe(true)
    expect(context.selectDirectory).toHaveBeenCalledWith({
      title: '选择新项目文件夹',
      createDirectory: true,
    })
    expect(context.confirm).toHaveBeenCalledOnce()
    expect(context.core).toHaveBeenLastCalledWith('videoProject.open', {
      projectPath: '/tmp/edit',
      initialize: true,
    })
  })

  it('opens only an existing project and never initializes an empty folder', async () => {
    const context = setup()
    context.core.mockRejectedValueOnce(
      Object.assign(new Error('initialize'), {
        code: 'project_not_initialized',
      }),
    )
    await expect(context.workspace.openFolder()).resolves.toBe(false)
    expect(context.confirm).not.toHaveBeenCalled()
    expect(context.core).toHaveBeenCalledOnce()
    expect(context.core).toHaveBeenCalledWith('videoProject.open', {
      projectPath: '/tmp/edit',
    })
    expect(context.workspace.state.error).toContain('还没有剪辑工程')
  })

  it('refreshes an Agent edit without resetting the current view', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.selectClip('clip-1')
    context.workspace.setPlayhead(3)
    context.workspace.state.activeTab = 'canvas'
    const edited = {
      ...project,
      revision: 4,
      clips: [{ ...project.clips[0]!, sourceOut: 5 }],
    }
    context.core.mockResolvedValueOnce(result({ project: edited }))
    await context.workspace.refreshFromDisk('session-1')
    expect(context.workspace.state.selectedClipId).toBe('clip-1')
    expect(context.workspace.state.playhead).toBe(3)
    expect(context.workspace.state.activeTab).toBe('canvas')
    expect(context.workspace.state.project?.revision).toBe(4)
    expect(context.core).toHaveBeenLastCalledWith('videoProject.open', {
      sessionId: 'session-1',
    })
  })

  it('applies an Agent focus without writing the project', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.state.activeTab = 'canvas'
    context.workspace.applyAgentFocus({ clipId: 'clip-1', time: 2.5 })
    expect(context.workspace.state.selectedClipId).toBe('clip-1')
    expect(context.workspace.state.activeTab).toBe('clip')
    expect(context.workspace.state.playhead).toBe(2.5)
    expect(context.core).toHaveBeenCalledTimes(1)
  })

  it('keeps clip and subtitle selection mutually exclusive', async () => {
    const context = setup()
    const withSubtitle = {
      ...project,
      subtitles: [{ id: 'sub-1', start: 1, end: 2, text: '你好' }],
    }
    context.core.mockResolvedValueOnce(result({ project: withSubtitle }))
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.selectSubtitle('sub-1')
    expect(context.workspace.state.selectedSubtitleId).toBe('sub-1')
    expect(context.workspace.state.selectedClipId).toBeNull()
    expect(context.workspace.state.activeTab).toBe('subtitle')
    context.workspace.selectClip('clip-1', false)
    expect(context.workspace.state.selectedSubtitleId).toBeNull()
    expect(context.workspace.state.selectedClipId).toBe('clip-1')
  })

  it('applies an Agent focus that arrives before the new clip is refreshed', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.applyAgentFocus({ clipId: 'clip-new', time: 1.5 })
    expect(context.workspace.state.selectedClipId).toBe('clip-1')
    const withNewClip = {
      ...project,
      revision: 2,
      clips: [
        ...project.clips,
        {
          id: 'clip-new',
          trackId: 'main',
          assetId: 'asset-1',
          timelineStart: 8,
          sourceIn: 0,
          sourceOut: 2,
          speed: 1,
          volume: 1,
          muted: false,
          transform: { scale: 1, x: 0, y: 0 },
        },
      ],
    }
    context.core.mockResolvedValueOnce(result({ project: withNewClip }))
    await context.workspace.refreshFromDisk('session-1')
    expect(context.workspace.state.selectedClipId).toBe('clip-new')
    expect(context.workspace.state.playhead).toBe(1.5)
  })

  it('opens and persists the unique workspace conversation', async () => {
    const context = setup()
    context.core.mockResolvedValue(result())
    await context.workspace.openProject({
      projectPath: '/tmp/edit',
      initialize: true,
    })
    expect(context.workspace.state.sessionId).toBe('session-1')
    expect(context.workspace.state.project?.name).toBe('Launch film')
  })

  it('keeps recent projects per workspace and returns home without deleting them', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    expect(context.workspace.state.recentProjects[0]).toMatchObject({
      projectPath: '/tmp/edit',
      name: 'Launch film',
      sessionId: 'session-1',
      assetCount: 1,
      clipCount: 1,
    })
    expect(context.values.get('video-edit-agent:recent-projects')).toContain(
      '/tmp/edit',
    )
    context.workspace.closeProject()
    expect(context.workspace.state.project).toBeNull()
    expect(context.workspace.state.sessionId).toBe('')
    expect(context.workspace.state.recentProjects).toHaveLength(1)
  })

  it('discovers local projects already known to Core', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce([
      {
        project_id: 'p1',
        project_path: '/tmp/existing',
        project_name: 'Existing film',
        updated_at: '2026-06-26T12:00:00.000Z',
      },
    ])
    await context.workspace.refreshRecentProjects()
    expect(context.workspace.state.recentProjects[0]).toMatchObject({
      projectPath: '/tmp/existing',
      name: 'Existing film',
      sessionId: '',
    })
    // Counts stay unknown until the project is opened: Core only lists paths.
    expect(
      context.workspace.state.recentProjects[0]?.assetCount,
    ).toBeUndefined()
    expect(context.workspace.state.recentProjects[0]?.clipCount).toBeUndefined()
  })

  it('loads only the opened project’s assets when switching projects', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    expect(context.workspace.state.project?.assets[0]?.displayName).toBe(
      'a.mp4',
    )
    const other = result({
      sessionId: 'session-2',
      projectPath: '/tmp/other',
      project: {
        ...project,
        projectId: 'project-2',
        name: 'Other film',
        assets: [
          {
            id: 'asset-2',
            kind: 'image',
            path: 'assets/b.png',
            displayName: 'b.png',
            duration: null,
            width: 100,
            height: 100,
          },
        ],
        clips: [],
      },
    })
    context.core.mockResolvedValueOnce(other)
    await context.workspace.openProject({ sessionId: 'session-2' })
    expect(context.workspace.state.project?.name).toBe('Other film')
    expect(
      context.workspace.state.project?.assets.map((asset) => asset.displayName),
    ).toEqual(['b.png'])
  })

  it('reopens a recent project by its session, then falls back to its folder', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    const recent = context.workspace.state.recentProjects[0]!
    context.workspace.closeProject()
    context.core.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'workspace_session_required' }),
    )
    context.core.mockResolvedValueOnce(result())
    await expect(context.workspace.openRecent(recent)).resolves.toBe(true)
    expect(context.core).toHaveBeenLastCalledWith('videoProject.open', {
      projectPath: '/tmp/edit',
    })
  })

  it('imports native file selections and selects the first new asset', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    const imported = result({ project: { ...project, revision: 1 } })
    context.core.mockResolvedValueOnce(imported)
    await context.workspace.importAssets()
    expect(context.core).toHaveBeenLastCalledWith('videoProject.importAssets', {
      sessionId: 'session-1',
      sourcePaths: ['/tmp/source.mp4'],
    })
    expect(context.workspace.state.selectedAssetId).toBe('asset-1')
    expect(context.workspace.state.activeTab).toBe('clip')
  })

  it('sends mutations with the current revision and migrates selection', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.core.mockResolvedValueOnce(
      result({
        project: { ...project, revision: 1 },
        selectedClipId: 'clip-1',
        canUndo: true,
      }),
    )
    await context.workspace.mutate({ type: 'deleteClip', clipId: 'clip-1' })
    expect(context.core).toHaveBeenLastCalledWith('videoProject.mutate', {
      sessionId: 'session-1',
      expectedRevision: 0,
      command: { type: 'deleteClip', clipId: 'clip-1' },
    })
    expect(context.workspace.state.selectedClipId).toBe('clip-1')
    expect(context.workspace.state.canUndo).toBe(true)
  })

  it('splits the clip under the playhead using a clip-local offset', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.setPlayhead(3)
    context.core.mockResolvedValueOnce(
      result({
        project: { ...project, revision: 1 },
        selectedClipId: 'right-clip',
      }),
    )
    await context.workspace.splitAtPlayhead()
    expect(context.core).toHaveBeenLastCalledWith('videoProject.mutate', {
      sessionId: 'session-1',
      expectedRevision: 0,
      command: { type: 'splitClip', clipId: 'clip-1', timelineOffset: 3 },
    })
    expect(context.workspace.state.selectedClipId).toBe('right-clip')
  })

  it('does not split at the end of a sped-up clip', async () => {
    const context = setup()
    const fastProject = {
      ...project,
      clips: [{ ...project.clips[0]!, speed: 2 }],
    }
    context.core.mockResolvedValueOnce(result({ project: fastProject }))
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.core.mockResolvedValueOnce(result({ project: fastProject }))
    context.workspace.setPlayhead(5)
    await context.workspace.splitAtPlayhead()
    expect(context.core).toHaveBeenCalledTimes(1)
  })

  it('serializes rapid changes instead of reusing a stale revision', async () => {
    const context = setup()
    context.core.mockResolvedValueOnce(result())
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.core
      .mockImplementationOnce(async (_op, input) => {
        await Promise.resolve()
        return result({
          project: { ...project, revision: input.expectedRevision + 1 },
        })
      })
      .mockImplementationOnce(async (_op, input) =>
        result({
          project: { ...project, revision: input.expectedRevision + 1 },
        }),
      )
    await Promise.all([
      context.workspace.mutate({ type: 'updateCanvas', fit: 'cover' }),
      context.workspace.mutate({ type: 'updateCanvas', background: '#112233' }),
    ])
    expect(
      context.core.mock.calls.slice(1).map((call) => call[1].expectedRevision),
    ).toEqual([0, 1])
  })

  it('ignores an older workspace open that finishes after a newer one', async () => {
    const context = setup()
    let resolveOld!: (value: VideoProjectResult) => void
    context.core.mockImplementationOnce(
      () =>
        new Promise<VideoProjectResult>((resolve) => {
          resolveOld = resolve
        }),
    )
    const oldOpen = context.workspace.openProject({ projectPath: '/tmp/old' })
    context.core.mockResolvedValueOnce(
      result({ projectPath: '/tmp/new', sessionId: 'new-session' }),
    )
    await context.workspace.openProject({ projectPath: '/tmp/new' })
    resolveOld(result())
    await oldOpen
    expect(context.workspace.state.projectPath).toBe('/tmp/new')
    expect(context.workspace.state.sessionId).toBe('new-session')
  })

  it('describes the explicitly cited timeline target, independently of selection', async () => {
    const context = setup()
    const withSubtitle = structuredClone(project)
    withSubtitle.subtitles = [
      { id: 'cue-2', text: '这条字幕', start: 1, end: 2 },
    ]
    context.core.mockResolvedValueOnce(result({ project: withSubtitle }))
    await context.workspace.openProject({ sessionId: 'session-1' })
    context.workspace.selectClip('clip-1')
    const clip = context.workspace.timelineReference({
      kind: 'clip',
      id: 'clip-1',
    })
    expect(clip?.timeline).toMatchObject({
      target: { id: 'clip-1' },
      assetId: 'asset-1',
      trackId: 'main',
      sourceIn: 0,
      sourceOut: 8,
      start: 0,
      end: 8,
    })
    const subtitle = context.workspace.timelineReference({
      kind: 'subtitle',
      id: 'cue-2',
    })!
    expect(subtitle.timeline).toMatchObject({
      target: { id: 'cue-2' },
      excerpt: '这条字幕',
    })
    expect(
      context.workspace.timelineReference({ kind: 'track', id: 'main' })?.label,
    ).toContain('主画面')
    expect(
      context.workspace.timelineReference({ kind: 'point', time: 4 })?.timeline,
    ).toMatchObject({ start: 4, end: 4, sourceIn: 4 })
    expect(
      context.workspace.timelineReference({ kind: 'range', start: 4, end: 6 })
        ?.timeline,
    ).toMatchObject({ start: 4, end: 6 })
    expect(
      context.workspace.timelineReference({ kind: 'clip', id: 'missing' }),
    ).toBeNull()
    context.workspace.revealTimelineReference(subtitle.timeline)
    expect(context.workspace.state.selectedSubtitleId).toBe('cue-2')
    expect(context.workspace.state.playhead).toBe(1)
    for (const invalid of [
      { ...subtitle.timeline, projectId: 'other' },
      {
        ...subtitle.timeline,
        target: { kind: 'point' as const, time: 1 },
        revision: 9,
      },
      {
        ...subtitle.timeline,
        target: { kind: 'clip' as const, id: 'deleted' },
      },
    ]) {
      expect(context.workspace.referenceUnavailable(invalid)).toBeTruthy()
      context.workspace.revealTimelineReference(invalid)
      expect(context.workspace.state.selectedSubtitleId).toBe('cue-2')
    }
    // A surviving subtitle id remains navigable after a later cut moves it.
    const loaded = context.workspace.state.project!
    loaded.revision++
    loaded.subtitles[0]!.start = 1.5
    context.workspace.revealTimelineReference(subtitle.timeline)
    expect(context.workspace.state.playhead).toBe(1.5)
    expect(context.core).toHaveBeenCalledTimes(1)
  })

  it('cites the visible draft clip bounds and generation', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(draft(2, 3))
    await workspace.refreshDraft()
    const target = { kind: 'clip' as const, id: 'clip-1' }
    const cited = workspace.timelineReference(target)!.timeline
    expect(cited).toMatchObject({
      draft: { runId: 'run-1', generation: 2 },
      start: 0,
      end: 3,
    })
    workspace.selectView('live')
    expect(workspace.timelineReference(target)!.timeline).toMatchObject({
      revision: 0,
      start: 0,
      end: 8,
    })
    workspace.revealTimelineReference(cited)
    expect(workspace.state.view).toBe('draft')
    expect(workspace.state.selectedClipId).toBe('clip-1')
    expect(
      workspace.referenceUnavailable({
        ...cited,
        draft: { runId: 'run-1', generation: 1 },
      }),
    ).toBeTruthy()
  })
})

it('drops queued edit, history, metadata and native selection when their project closes', async () => {
  const { core, workspace, selectMediaFiles } = setup()
  core.mockResolvedValue(result())
  await workspace.openProject({ sessionId: 'session-1' })
  let release!: (paths: string[]) => void
  selectMediaFiles.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const jobs = [
    workspace.mutate({ type: 'updateCanvas', fit: 'cover' }),
    workspace.undo(),
    workspace.redo(),
    workspace.updateAssetMetadata('asset-1', {
      duration: 4,
      width: 10,
      height: 10,
    }),
    workspace.importAssets(),
  ]
  workspace.closeProject()
  core.mockResolvedValue(
    result({ sessionId: 'session-2', project: { ...project, projectId: 'B' } }),
  )
  await workspace.openProject({ sessionId: 'session-2' })
  release(['/tmp/a.mp4'])
  await Promise.all(jobs)
  expect(core.mock.calls.map(([op]) => op)).toEqual([
    'videoProject.open',
    'videoProject.leaveMotionWorkspace',
    'videoProject.open',
  ])
})

it('refuses late captions after revision or project changes', async () => {
  const { core, workspace } = setup()
  core.mockResolvedValue(result())
  await workspace.openProject({ sessionId: 'session-1' })
  const origin = workspace.captureProject()
  core.mockResolvedValue(result({ project: { ...project, revision: 2 } }))
  await workspace.refreshFromDisk()
  await expect(
    workspace.mutateDerived({ type: 'replaceSubtitles', cues: [] }, origin),
  ).rejects.toThrow()
  workspace.closeProject()
  await workspace.openProject({ sessionId: 'session-1' })
  await expect(
    workspace.mutateDerived({ type: 'replaceSubtitles', cues: [] }, origin),
  ).rejects.toThrow()
  expect(
    core.mock.calls.every(
      ([op]) =>
        op === 'videoProject.open' ||
        op === 'videoProject.leaveMotionWorkspace',
    ),
  ).toBe(true)
})

const scene: MotionScene = {
  id: 'flow',
  name: '工具调用',
  startFrame: 60,
  durationFrames: 240,
  sourceInFrame: 10,
  version: 1,
  mode: 'overlay',
  story: '先发出请求，再显示结果。',
  objects: [
    {
      id: 'request',
      name: '请求箭头',
      html: '<span>调用</span>',
      draw: 'ctx.fillRect(0,0,frame,5)',
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      markers: [{ frame: 15, label: '发出' }],
    },
  ],
}
const work = (seq: number, changes: Partial<MotionWork> = {}): MotionWork => ({
  id: 'job',
  seq,
  status: 'drawing',
  scene,
  target: 'live',
  frame: 65,
  endFrame: 75,
  objectId: 'request',
  message: '正在绘制请求箭头',
  ...changes,
})

describe('motion work and timeline ownership', () => {
  it('deletes only the selected object and keeps markers, stale versions and actively drawn scenes safe', async () => {
    const { workspace, core, confirm } = setup()
    const both = {
      ...scene,
      objects: [...scene.objects, { ...scene.objects[0]!, id: 'second' }],
    }
    core.mockResolvedValueOnce(
      result({ project: { ...project, motionScenes: [both] } }),
    )
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.selectMotion(both, 'request', 15)
    expect(workspace.canDelete.value).toBe(false)
    expect(workspace.selectedRange.value).toBeNull()
    await workspace.deleteSelection()
    workspace.selectMotion(both, 'request')
    expect(workspace.deleteLabel.value).toBe('删除对象')
    const stale = workspace.deleteSelection()
    workspace.selectMotion(both, 'second')
    await stale
    expect(core).toHaveBeenCalledTimes(1)
    workspace.selectMotion(both, 'request')
    workspace.state.project!.motionScenes![0]!.version++
    expect(workspace.canDelete.value).toBe(false)
    await workspace.deleteSelection()
    const current = workspace.motionScenes.value[0]!
    workspace.selectMotion(current, 'request')
    workspace.applyMotionWork(
      work(1, { status: 'preparing', scene: null, sceneId: scene.id }),
      false,
    )
    expect(workspace.canDelete.value).toBe(false)
    await workspace.deleteSelection()
    workspace.applyMotionWork(work(2, { scene: current }), false)
    expect(workspace.canDelete.value).toBe(false)
    await workspace.deleteSelection()
    workspace.interruptMotion()
    workspace.selectMotion(current, 'request')
    core.mockResolvedValueOnce(
      result({
        project: {
          ...project,
          revision: 1,
          motionScenes: [{ ...both, version: 3, objects: [both.objects[1]!] }],
        },
        selectedMotionSceneId: null,
      }),
    )
    await workspace.deleteSelection()
    expect(core).toHaveBeenLastCalledWith('videoProject.mutate', {
      sessionId: 'session-1',
      expectedRevision: 0,
      command: {
        type: 'deleteMotionObject',
        sceneId: 'flow',
        objectId: 'request',
        expectedVersion: 2,
      },
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(workspace.canDelete.value).toBe(false)
    expect(workspace.state.selectedClipId).toBeNull()
  })

  it('requires explicit confirmation for the last object and expires that confirmation on a project switch', async () => {
    const { workspace, core, confirm } = setup()
    const source = result({ project: { ...project, motionScenes: [scene] } })
    core.mockResolvedValueOnce(source)
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.selectMotion(scene, 'request')
    expect(workspace.deleteLabel.value).toBe('删除整幕')
    confirm.mockResolvedValueOnce(false)
    await workspace.deleteSelection()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: '删除整幕',
        body: expect.stringContaining('最后一个对象'),
      }),
    )
    expect(core).toHaveBeenCalledTimes(1)
    let answer!: (value: boolean) => void
    confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const pending = workspace.deleteSelection()
    core.mockResolvedValueOnce({ ...source, sessionId: 'session-2' })
    await workspace.openProject({ sessionId: 'session-2' })
    workspace.selectMotion(scene, 'request')
    answer(true)
    await pending
    expect(
      core.mock.calls.filter(([op]) => op === 'videoProject.mutate'),
    ).toHaveLength(0)
    core.mockResolvedValueOnce({
      ...source,
      sessionId: 'session-2',
      project: { ...project, revision: 1 },
      selectedMotionSceneId: null,
    })
    await workspace.deleteSelection()
    expect(core).toHaveBeenLastCalledWith('videoProject.mutate', {
      sessionId: 'session-2',
      expectedRevision: 0,
      command: {
        type: 'deleteMotionScene',
        sceneId: 'flow',
        expectedVersion: 1,
      },
    })
  })

  it('previews the working scene without writing, supports takeover, and restores the latest step without restarting playback', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.applyMotionWork(work(1, { status: 'preparing', scene: null }))
    expect(workspace.activeMotion.value?.status).toBe('preparing')
    expect(workspace.motionScenes.value).toEqual([])
    workspace.applyMotionWork(work(2))
    expect(workspace.layout.value.totalDuration).toBe(10)
    expect(workspace.state.project?.motionScenes).toBeUndefined()
    expect(workspace.state.playhead).toBe(65 / 30)
    expect(workspace.state.motionCue?.objectId).toBe('request')
    expect(workspace.state.playing).toBe(true)
    workspace.setPlayhead(1)
    workspace.applyMotionWork(work(3, { frame: 89, endFrame: 99 }))
    expect(workspace.state.playhead).toBe(1)
    expect(workspace.state.motionFollow).toBe(false)
    expect(workspace.state.playing).toBe(false)
    workspace.resumeMotionFollow()
    expect(workspace.state.playhead).toBe(89 / 30)
    expect(workspace.state.playing).toBe(false)
    workspace.selectMotion(scene, 'request', 15)
    expect(workspace.state.selectedMotionObjectId).toBe('request')
    expect(workspace.state.playhead).toBe(65 / 30)
    const text = workspace.timelineReference({
      kind: 'motion',
      id: 'flow',
      objectId: 'request',
      markerFrame: 15,
    })
    expect(text?.timeline).toMatchObject({
      target: {
        kind: 'motion',
        id: 'flow',
        objectId: 'request',
        markerFrame: 15,
      },
      sceneVersion: 1,
      start: 65 / 30,
    })
    expect(text?.label).toContain('发出')
    workspace.interruptMotion()
    workspace.applyMotionWork(work(4))
    expect(workspace.motionScenes.value).toEqual([])
    expect(workspace.state.motionWork?.status).toBe('cancelled')
    expect(workspace.state.selectedMotionSceneId).toBeNull()
    expect(core).toHaveBeenCalledTimes(1)
  })

  it('accepts an authoritative commit that crossed Stop after the atomic save', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.applyMotionWork(work(1))
    workspace.interruptMotion()
    workspace.applyMotionWork(work(2))
    expect(workspace.state.motionWork?.status).toBe('cancelled')
    core.mockResolvedValueOnce(
      result({ project: { ...project, revision: 1, motionScenes: [scene] } }),
    )
    workspace.applyMotionWork(work(3, { status: 'committed' }))
    await vi.waitFor(() =>
      expect(workspace.state.project?.motionScenes?.[0]?.id).toBe(scene.id),
    )
    expect(workspace.state.motionWork?.status).toBe('committed')
    expect(workspace.state.playing).toBe(false)
  })

  it('never takes over user playback or resurrects a cancelled job after retry', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    workspace.state.playing = true
    workspace.setPlayhead(3)
    workspace.applyMotionWork(work(1))
    expect(workspace.state.playhead).toBe(3)
    expect(workspace.state.motionFollow).toBe(false)
    workspace.resumeMotionFollow()
    expect(workspace.state.playhead).toBe(3)
    workspace.applyMotionWork(work(2, { status: 'failed' }))
    expect(workspace.state.playing).toBe(true)
    workspace.state.playing = false
    workspace.applyMotionWork(work(3, { id: 'retry', frame: 90, endFrame: 94 }))
    workspace.applyMotionWork(work(4, { frame: 82 }))
    expect(workspace.state.playhead).toBe(3)
    expect(workspace.state.motionWork?.id).toBe('retry')
    workspace.applyMotionWork(work(5, { id: 'retry', status: 'cancelled' }))
    expect(workspace.state.selectedClipId).toBe('clip-1')
    expect(workspace.state.playing).toBe(false)
  })

  it('does not show working draft objects on the live timeline, including generation zero and after a switch', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    core.mockResolvedValueOnce(draft(0))
    await workspace.refreshDraft()
    const stage = { target: 'draft' as const, runId: 'run-1', generation: 0 }
    workspace.applyMotionWork(
      work(1, { ...stage, status: 'preparing', scene: null }),
    )
    expect(workspace.state.view).toBe('draft')
    workspace.applyMotionWork(work(2, stage))
    expect(workspace.visibleMotionWork.value?.seq).toBe(2)
    workspace.selectView('live')
    expect(workspace.motionScenes.value).toEqual([])
    expect(workspace.state.playhead).toBe(0)
    workspace.applyMotionWork(work(3, { ...stage, frame: 80 }))
    expect(workspace.state.view).toBe('live')
    workspace.selectView('draft')
    expect(workspace.motionScenes.value.at(0)?.id).toBe('flow')
    workspace.resumeMotionFollow()
    expect(workspace.state.playhead).toBe(80 / 30)
    core.mockResolvedValueOnce(draft(1))
    await workspace.refreshDraft()
    expect(workspace.visibleMotionWork.value).toBeNull()
    expect(workspace.motionScenes.value).toEqual([])
    workspace.closeProject()
    expect(workspace.state.motionWork).toBeNull()
  })

  it('ignores stale settings and work hydration after opening another project', async () => {
    const { workspace, core } = setup()
    core.mockResolvedValueOnce(result())
    await workspace.openProject({ sessionId: 'session-1' })
    let finishWork!: (job: MotionWork) => void
    let finishSettings!: (result: { enabled: boolean }) => void
    core
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSettings = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishWork = resolve
          }),
      )
    const pending = workspace.refreshMotion()
    core.mockResolvedValueOnce(result({ sessionId: 'session-2' }))
    await workspace.openProject({ sessionId: 'session-2' })
    finishWork(work(1))
    finishSettings({ enabled: true })
    await pending
    expect(workspace.state.motionEnabled).toBe(false)
    expect(workspace.state.motionWork).toBeNull()
    core.mockResolvedValueOnce({ enabled: true })
    await workspace.setMotionEnabled(true)
    expect(core).toHaveBeenLastCalledWith('videoProject.setMotionEnabled', {
      sessionId: 'session-2',
      enabled: true,
    })
    expect(workspace.state.motionEnabled).toBe(true)
  })
})
