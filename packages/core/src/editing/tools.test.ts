import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentStore } from '../attachments/store'
import type { Agent } from '../harness/agent/agent'
import type { ApprovalService } from '../harness/approval/service'
import type { ToolRunContext } from '../harness/tools/definition'
import { createVideoProjectTools } from './tools'
import { VideoProjectService, type VideoProjectSession } from './index'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function seeded() {
  const root = mkdtempSync(join(tmpdir(), 'video-tools-'))
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
  const opened = await service.open({ projectPath: root, initialize: true })
  const source = join(root, 'interview.mp4')
  writeFileSync(source, 'video-bytes')
  const imported = await service.importAssets({
    sessionId: opened.sessionId,
    sourcePaths: [source],
  })
  const asset = imported.project.assets[0]!
  const withMetadata = await service.updateAssetMetadata({
    sessionId: opened.sessionId,
    expectedRevision: imported.project.revision,
    assetId: asset.id,
    duration: 10,
    width: 1920,
    height: 1080,
  })
  const added = await service.mutate({
    sessionId: opened.sessionId,
    expectedRevision: withMetadata.project.revision,
    command: { type: 'addClip', assetId: asset.id },
  })
  return {
    root,
    service,
    sessionId: opened.sessionId,
    assetId: asset.id,
    clipId: added.project.clips[0]!.id,
    result: added,
  }
}

function context(sessionId: string): ToolRunContext {
  const agent = { session: { id: sessionId } } as unknown as Agent
  return {
    callId: 'call-video',
    name: 'video',
    arguments: {},
    agent,
    signal: new AbortController().signal,
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  }
}

function toolsFor(
  service: VideoProjectService,
  outcome: Awaited<ReturnType<ApprovalService['request']>> = 'allowed-once',
) {
  const approval = {
    request: vi.fn(
      async (_request: { toolName?: string; reason?: string; risk?: string }) =>
        outcome,
    ),
  }
  const emit = vi.fn()
  const attachmentRoot = mkdtempSync(join(tmpdir(), 'video-tools-state-'))
  roots.push(attachmentRoot)
  const tools = createVideoProjectTools({
    service,
    approval: approval as unknown as ApprovalService,
    attachments: new AttachmentStore(attachmentRoot),
    visionRecipient: () => ({ label: '测试模型', scope: 'test-scope' }),
    emit,
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { tools, byName, approval, emit }
}

async function run(
  tool: NonNullable<
    ReturnType<typeof toolsFor>['byName'] extends Map<string, infer T>
      ? T
      : never
  >,
  args: unknown,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const parsed = tool.parse(args)
  const result = await tool.execute(parsed, context(sessionId))
  return JSON.parse(String(result)) as Record<string, unknown>
}

describe('video project agent tools', () => {
  it('lists the seven editing tools', async () => {
    const { service } = await seeded()
    const { tools } = toolsFor(service)
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'video_edit_apply',
      'video_edit_history',
      'video_edit_preview',
      'video_inspect_frames',
      'video_project_focus',
      'video_project_read',
      'video_transcribe',
    ])
    expect(tools.every((tool) => tool.category === 'editing')).toBe(true)
  })

  it('reads a compact project view with computed timeline positions', async () => {
    const { service, sessionId, clipId, assetId } = await seeded()
    const { byName } = toolsFor(service)
    const view = await run(byName.get('video_project_read')!, {}, sessionId)
    expect(view).toMatchObject({
      project: { revision: 3, totalDuration: 10 },
      assets: [{ id: assetId, displayName: 'interview.mp4', usedByClips: 1 }],
      clips: [
        {
          id: clipId,
          index: 0,
          assetId,
          timelineStart: 0,
          timelineEnd: 10,
        },
      ],
      truncated: false,
    })
  })

  it('filters the current timeline before paging and reports source and timeline spans', async () => {
    const { root, service, sessionId, assetId } = await seeded()
    const image = join(root, 'overlay.png')
    writeFileSync(image, 'image-bytes')
    const { project } = await service.importAssets({
      sessionId,
      sourcePaths: [image],
    })
    const clip = project.clips[0]!
    const first = {
      ...clip,
      id: 'first',
      timelineStart: 4,
      sourceIn: 2,
      sourceOut: 6,
      speed: 2,
      fadeIn: 0.25,
    }
    const second = { ...clip, id: 'second', timelineStart: 8, sourceOut: 1 }
    await service.commitEditDraft({
      sessionId,
      expectedRevision: project.revision,
      draft: {
        ...project,
        tracks: [
          { id: 'upper', name: 'Upper', index: 1, kind: 'video' },
          ...project.tracks,
        ],
        clips: [
          second,
          {
            ...clip,
            id: 'overlay',
            trackId: 'upper',
            timelineStart: 5,
            sourceOut: 1,
          },
          {
            ...clip,
            id: 'other-source',
            assetId: project.assets[1]!.id,
            timelineStart: 6,
            sourceOut: 1,
          },
          { ...clip, id: 'other-id', timelineStart: 7, sourceOut: 1 },
          { ...clip, id: 'before', timelineStart: 2, sourceOut: 2 },
          first,
          { ...clip, id: 'after', timelineStart: 9, sourceOut: 1 },
        ],
        subtitles: [
          { id: 'old-cue', start: 1, end: 4, text: '早' },
          { id: 'cue', start: 5, end: 6, text: '中' },
        ],
        annotations: [
          {
            id: 'box',
            kind: 'box',
            start: 8,
            end: 9,
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
            color: '#ffcb46',
          },
          {
            id: 'old-box',
            kind: 'box',
            start: 1,
            end: 4,
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
            color: '#ffcb46',
          },
        ],
      },
    })
    const { byName } = toolsFor(service)
    const read = byName.get('video_project_read')!
    const filters = {
      timelineStart: 4,
      timelineEnd: 9,
      trackIds: ['main'],
      sourceAssetIds: [assetId],
      clipIds: [
        'after',
        'overlay',
        'second',
        'other-source',
        'first',
        'before',
      ],
      clipLimit: 1,
    }
    const page = await run(read, filters, sessionId)
    expect(page).toMatchObject({
      project: {
        revision: 5,
        totalDuration: 10,
        tracks: [
          { id: 'main', kind: 'video', clipCount: 6 },
          { id: 'upper', kind: 'video', clipCount: 1 },
        ],
      },
      totalClips: 7,
      matchedClips: 2,
      clipOffset: 0,
      clipLimit: 1,
      nextClipOffset: 1,
      truncated: true,
      clips: [
        {
          id: 'first',
          index: 1,
          speed: 2,
          duration: 2,
          timelineRange: { start: 4, end: 6 },
          sourceRange: { start: 2, end: 6 },
          timelineStart: 4,
          timelineEnd: 6,
          sourceIn: 2,
          sourceOut: 6,
          fadeIn: 0.25,
        },
      ],
      subtitles: [{ id: 'cue' }],
      annotations: [{ id: 'box' }],
    })
    const last = await run(
      read,
      { ...filters, clipOffset: page.nextClipOffset },
      sessionId,
    )
    expect(last).toMatchObject({
      clips: [{ id: 'second', index: 4 }],
      truncated: false,
      nextClipOffset: null,
    })
  })

  it('rejects an empty or reversed timeline range', async () => {
    const { service, sessionId } = await seeded()
    const { byName } = toolsFor(service)
    const read = byName.get('video_project_read')!
    await expect(
      run(read, { timelineStart: 5, timelineEnd: 5 }, sessionId),
    ).rejects.toMatchObject({
      code: 'invalid_timeline_range',
    })
  })

  it('previews a valid command without writing or asking for approval', async () => {
    const { service, sessionId, clipId, result } = await seeded()
    const { byName, approval, emit } = toolsFor(service)
    const preview = await run(
      byName.get('video_edit_preview')!,
      { command: { type: 'trimClip', clipId, sourceOut: 4 } },
      sessionId,
    )
    expect(preview).toMatchObject({ valid: true })
    expect(String(preview.summary)).toContain('修剪')
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project.revision).toBe(
      result.project.revision,
    )
  })

  it('previews an invalid command as a recoverable result', async () => {
    const { service, sessionId, clipId } = await seeded()
    const { byName, approval } = toolsFor(service)
    const preview = await run(
      byName.get('video_edit_preview')!,
      { command: { type: 'trimClip', clipId, sourceOut: 99 } },
      sessionId,
    )
    expect(preview).toMatchObject({ valid: false })
    expect(String(preview.error)).toContain('剪切范围')
    expect(approval.request).not.toHaveBeenCalled()
  })

  it('reports the subtitle impact in a ripple preview and direct edit', async () => {
    const { service, sessionId, result } = await seeded()
    const captioned = await service.mutate({
      sessionId,
      expectedRevision: result.project.revision,
      command: { type: 'addSubtitle', start: 1, end: 2, text: '待重做' },
    })
    const { byName, approval } = toolsFor(service)
    const args = { command: { type: 'rippleDeleteRange', start: 1.5, end: 3 } }
    const impact = {
      removedSubtitleIds: [captioned.project.subtitles[0]!.id],
      retimeSubtitles: [{ start: 1, end: 1.5 }],
    }

    const preview = await run(
      byName.get('video_edit_preview')!,
      args,
      sessionId,
    )
    expect(preview).toMatchObject({ valid: true, ...impact })
    expect(String(preview.summary)).toContain('1 条')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project).toEqual(
      captioned.project,
    )

    const applied = await run(byName.get('video_edit_apply')!, args, sessionId)
    expect(applied).toMatchObject({
      applied: true,
      ...impact,
      totalDuration: 8.5,
    })
    expect(String(applied.summary)).toContain('1 条')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project.subtitles).toEqual([])
  })

  it('applies one command directly with the server revision and emits an event', async () => {
    const { service, sessionId, clipId, result } = await seeded()
    const { byName, approval, emit } = toolsFor(service, 'rejected')
    const applied = await run(
      byName.get('video_edit_apply')!,
      { command: { type: 'trimClip', clipId, sourceOut: 4 } },
      sessionId,
    )
    expect(applied).toMatchObject({
      applied: true,
      revision: result.project.revision + 1,
      totalDuration: 4,
    })
    expect(applied).not.toHaveProperty('approved')
    expect(String(applied.summary)).toContain('interview.mp4')
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'video_project_changed',
        session_id: sessionId,
        revision: result.project.revision + 1,
      }),
    )
    expect((await service.inspect(sessionId)).project.clips[0]!.sourceOut).toBe(
      4,
    )
  })

  it('writes nothing when the editing command is invalid', async () => {
    const { service, sessionId, clipId, result } = await seeded()
    const { byName, approval, emit } = toolsFor(service)
    const apply = byName.get('video_edit_apply')!
    await expect(
      apply.execute(
        apply.parse({ command: { type: 'trimClip', clipId, sourceOut: 99 } }),
        context(sessionId),
      ),
    ).rejects.toMatchObject({ code: 'invalid_edit' })
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project).toEqual(result.project)
  })

  it('returns a revision conflict instead of overwriting a newer project', async () => {
    const { service, sessionId, clipId, result } = await seeded()
    const mutate = service.mutate.bind(service)
    vi.spyOn(service, 'mutate').mockImplementationOnce(async (input) => {
      await mutate({
        sessionId,
        expectedRevision: result.project.revision,
        command: { type: 'updateCanvas', background: '#112233' },
      })
      return mutate(input)
    })
    const { byName, emit } = toolsFor(service)
    const apply = byName.get('video_edit_apply')!
    const parsed = apply.parse({
      command: { type: 'trimClip', clipId, sourceOut: 4 },
    })
    await expect(
      apply.execute(parsed, context(sessionId)),
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      message: expect.stringContaining('已在别处修改'),
    })
    expect(emit).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project).toMatchObject({
      revision: result.project.revision + 1,
      canvas: { background: '#112233' },
      clips: [{ sourceOut: 10 }],
    })
  })

  it('skips approval and revision for a no-op command', async () => {
    const { service, sessionId, result } = await seeded()
    const { byName, approval, emit } = toolsFor(service)
    const applied = await run(
      byName.get('video_edit_apply')!,
      { command: { type: 'updateCanvas', fit: 'contain' } },
      sessionId,
    )
    expect(applied).toMatchObject({ applied: false, noChange: true })
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect((await service.inspect(sessionId)).project.revision).toBe(
      result.project.revision,
    )
  })

  it('undoes and redoes the latest edit directly and emits both revisions', async () => {
    const { service, sessionId, result } = await seeded()
    const { byName, approval, emit } = toolsFor(service, 'rejected')
    const history = byName.get('video_edit_history')!
    const undo = await run(history, { action: 'undo' }, sessionId)
    expect(undo).toMatchObject({
      applied: true,
      action: 'undo',
      revision: result.project.revision + 1,
    })
    expect((await service.inspect(sessionId)).project.clips).toHaveLength(0)

    const redo = await run(history, { action: 'redo' }, sessionId)
    expect(redo).toMatchObject({
      applied: true,
      action: 'redo',
      revision: result.project.revision + 2,
    })
    expect((await service.inspect(sessionId)).project.clips).toEqual(
      result.project.clips,
    )
    expect(undo).not.toHaveProperty('approved')
    expect(redo).not.toHaveProperty('approved')
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: 'video_project_changed',
        revision: result.project.revision + 1,
      }),
    )
    expect(emit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: 'video_project_changed',
        revision: result.project.revision + 2,
      }),
    )
  })

  it('returns an unchanged revision when history is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'video-tools-empty-'))
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
    const opened = await service.open({ projectPath: root, initialize: true })
    const { byName, approval, emit } = toolsFor(service)
    const undo = await run(
      byName.get('video_edit_history')!,
      { action: 'undo' },
      opened.sessionId,
    )
    expect(undo).toMatchObject({ applied: false, noHistory: true, revision: 0 })
    expect(approval.request).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports missing analysis configuration instead of inventing a transcript', async () => {
    const { service, sessionId, assetId } = await seeded()
    const { byName } = toolsFor(service)
    const transcribe = byName.get('video_transcribe')!
    await expect(
      transcribe.execute(transcribe.parse({ assetId }), context(sessionId)),
    ).rejects.toMatchObject({ code: 'analysis_unavailable' })
  })

  it('returns transcript pages and image blocks when analysis and vision are available', async () => {
    const { service, sessionId, assetId } = await seeded()
    const inspected = await service.inspect(sessionId)
    const asset = inspected.project.assets.find((item) => item.id === assetId)!
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Lf//Z',
      'base64',
    )
    const fake = {
      inspect: service.inspect.bind(service),
      motionSettings: service.motionSettings.bind(service),
      mutate: service.mutate.bind(service),
      undo: service.undo.bind(service),
      redo: service.redo.bind(service),
      analysisStatus: async () => ({
        ffmpegPath: '/fake/ffmpeg',
        whisperPath: '/fake/whisper',
        modelPath: '/fake/model.bin',
        ready: true,
        language: 'zh' as const,
        autoTranscribe: false,
        transcriptionProvider: 'whisper' as const,
        funAsrConfigured: false,
      }),
      transcribe: async () => ({
        asset,
        transcript: {
          assetId,
          language: 'zh',
          cached: true,
          model: '/fake/model.bin',
          peaks: [],
          segments: [
            { start: 0, end: 1, text: '第一句' },
            { start: 1, end: 2, text: '第二句' },
          ],
        },
      }),
      transcripts: async () => new Map(),
      inspectFrames: async () => ({
        asset,
        frames: [{ time: 0.5, bytes: jpeg }],
      }),
    }
    const attachmentRoot = mkdtempSync(join(tmpdir(), 'video-tools-state-'))
    roots.push(attachmentRoot)
    const tools = createVideoProjectTools({
      service: fake,
      approval: {
        request: vi.fn(async () => 'allowed-once'),
      } as unknown as ApprovalService,
      attachments: new AttachmentStore(attachmentRoot),
      visionRecipient: () => ({ label: '测试模型', scope: 'test-scope' }),
      emit: vi.fn(),
    })
    const transcribe = tools.find((tool) => tool.name === 'video_transcribe')!
    const transcript = JSON.parse(
      String(
        await transcribe.execute(
          transcribe.parse({ assetId, offset: 1, limit: 1 }),
          context(sessionId),
        ),
      ),
    ) as { segments: Array<{ text: string }>; truncated: boolean }
    expect(transcript.segments.map((segment) => segment.text)).toEqual([
      '第二句',
    ])
    expect(transcript.truncated).toBe(false)

    const frames = tools.find((tool) => tool.name === 'video_inspect_frames')!
    const result = (await frames.execute(
      frames.parse({ assetId, count: 1 }),
      context(sessionId),
    )) as {
      content: Array<{ type: string; attachment?: { mediaType: string } }>
      meta: { videoFrames: { times: number[] } }
    }
    expect(result.content.some((block) => block.type === 'image')).toBe(true)
    expect(result.content[0]?.attachment?.mediaType).toBe('image/jpeg')
    expect(result.meta.videoFrames.times).toEqual([0.5])
  })

  it('refuses frames when the active model has no vision', async () => {
    const { service, sessionId, assetId } = await seeded()
    const approval = { request: vi.fn() }
    const attachmentRoot = mkdtempSync(join(tmpdir(), 'video-tools-state-'))
    roots.push(attachmentRoot)
    const tools = createVideoProjectTools({
      service,
      approval: approval as unknown as ApprovalService,
      attachments: new AttachmentStore(attachmentRoot),
      visionRecipient: () => null,
      emit: vi.fn(),
    })
    const frames = tools.find((tool) => tool.name === 'video_inspect_frames')!
    await expect(
      frames.execute(frames.parse({ assetId }), context(sessionId)),
    ).rejects.toMatchObject({ code: 'vision_unavailable' })
  })

  it('does not extract or attach frames when the user denies model disclosure', async () => {
    const { service, sessionId, assetId } = await seeded()
    const extraction = vi.spyOn(service, 'inspectFrames')
    const { byName, approval } = toolsFor(service, 'rejected')
    const frames = byName.get('video_inspect_frames')!
    await expect(
      frames.execute(frames.parse({ assetId, times: [1] }), context(sessionId)),
    ).rejects.toMatchObject({ code: 'frame_disclosure_denied' })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        risk: 'disclosure',
        toolName: 'video_inspect_frames',
      }),
    )
    expect(extraction).not.toHaveBeenCalled()
  })

  it('focuses a clip without writing the project', async () => {
    const { service, sessionId, clipId, result } = await seeded()
    const { byName, emit } = toolsFor(service)
    const focused = await run(
      byName.get('video_project_focus')!,
      { clipId, time: 2.5 },
      sessionId,
    )
    expect(focused).toMatchObject({ focused: true, clipId, time: 2.5 })
    expect(emit).toHaveBeenCalledWith({
      event: 'video_project_focus',
      session_id: sessionId,
      clipId,
      time: 2.5,
    })
    expect((await service.inspect(sessionId)).project.revision).toBe(
      result.project.revision,
    )
  })

  it('rejects a focus on an unknown clip', async () => {
    const { service, sessionId } = await seeded()
    const { byName } = toolsFor(service)
    const focus = byName.get('video_project_focus')!
    const parsed = focus.parse({ clipId: 'missing' })
    await expect(focus.execute(parsed, context(sessionId))).rejects.toThrow(
      /找不到/,
    )
  })

  it('validates command arguments through the shared schema', async () => {
    const { service } = await seeded()
    const { byName } = toolsFor(service)
    expect(() =>
      byName.get('video_edit_apply')!.parse({
        command: { type: 'trimClip', clipId: 'x', sourceOut: 0 },
      }),
    ).toThrow()
  })
})
