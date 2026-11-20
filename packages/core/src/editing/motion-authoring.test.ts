import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as atomic from '../store/atomic-json'
import {
  VideoProjectService,
  type VideoProjectServiceOptions,
} from './project-store'
import type { VideoProjectSession } from './types'
import type { MotionObject } from './motion'
import { EditRunService } from './edit-run'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const object: MotionObject = {
  id: 'line',
  name: '请求路径',
  html: '<svg><path/></svg>',
  draw: 'root.style.opacity=String(t);',
  bounds: { x: 0, y: 0, width: 48, height: 24 },
  markers: [{ frame: 12, label: '到达' }],
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 've-motion-work-'))
  folders.push(root)
  const sessions = new Map<string, VideoProjectSession>()
  const validate = vi.fn<
    NonNullable<VideoProjectServiceOptions['validateMotionFrame']>
  >(async () => {})
  const emit = vi.fn()
  const commit = vi.fn()
  const options: VideoProjectServiceOptions = {
    getSession: (id) => sessions.get(id) ?? null,
    createBuildSession: (project_path, title) => {
      const session = { id: 'test-session', mode: 'build', project_path, title }
      sessions.set(session.id, session)
      return session
    },
    editRuns: async () => runs,
    onMotionWork: emit,
    onMotionCommit: commit,
    validateMotionFrame: validate,
  }
  const service = new VideoProjectService(options)
  const scope = 'test-route'
  const runs = new EditRunService({
    projects: service,
    stateRoot: join(root, 'state'),
    recipient: () => ({ scope, label: 'test model' }),
    ready: async () => ({ ffmpegPath: '/ffmpeg' }),
    review: async () => {
      throw new Error('unused')
    },
    turn: async () => ({ kind: 'completed', turnId: 'test', content: '' }),
    emit: () => {},
  })
  const { sessionId, project } = await service.open({
    projectPath: root,
    initialize: true,
  })
  const input = {
    sceneId: 'scene',
    name: '请求与响应',
    story: '请求发出时一条路径出现。',
    mode: 'overlay' as const,
    startFrame: 30,
    sourceInFrame: 3,
    durationFrames: 30,
    expectedVersion: 0,
    expectedRevision: project.revision,
  }
  const ctx = {
    sessionId,
    scope,
    turn: 1,
    signal: new AbortController().signal,
  }
  return {
    root,
    sessionId,
    options,
    service,
    validate,
    project,
    input,
    ctx,
    runs,
    emit,
    commit,
  }
}

it('publishes validated named objects at project frames, commits once and preserves project permission across undo and reopen', async () => {
  const {
    root,
    service,
    options,
    ctx,
    input,
    project,
    emit,
    validate,
    commit,
  } = await fixture()
  const { sessionId } = ctx
  const timelinePath = join(root, 'timeline.json')
  const before = await readFile(timelinePath, 'utf8')
  await expect(service.motion.begin(ctx, input)).rejects.toMatchObject({
    code: 'motion_disabled',
  })
  await service.setMotionEnabled({ sessionId, enabled: true })
  const started = await service.motion.begin(ctx, input)
  expect(emit.mock.lastCall?.[1]).toMatchObject({
    scene: null,
    sceneId: input.sceneId,
    status: 'preparing',
    seq: started.seq,
    frame: 30,
    endFrame: 60,
  })
  await expect(
    service.mutate({
      sessionId,
      expectedRevision: project.revision,
      command: { type: 'deleteMotionScene', sceneId: input.sceneId },
    }),
  ).rejects.toMatchObject({ code: 'motion_work_active' })
  const a = await service.motion.object(ctx, {
    workId: started.workId,
    expectedSeq: started.seq,
    object,
    endFrame: 46,
  })
  expect(a.frame).toBe(39)
  expect(emit.mock.lastCall?.[1]).toMatchObject({
    endFrame: 46,
    scene: { posterFrame: 12 },
  })
  expect(validate.mock.calls[0]?.[1]).toBe(12)
  await expect(
    service.motion.finish(ctx, { workId: a.workId, expectedSeq: started.seq }),
  ).rejects.toMatchObject({ code: 'motion_work_stale' })
  const b = await service.motion.object(ctx, {
    workId: a.workId,
    expectedSeq: a.seq,
    object: { ...object, id: 'result', name: '结果' },
    frame: 53,
  })
  expect(await readFile(timelinePath, 'utf8')).toBe(before)
  const finished = await service.motion.finish(ctx, {
    workId: b.workId,
    expectedSeq: b.seq,
  })
  expect(finished.revision).toBe(project.revision + 1)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(validate.mock.calls.slice(-3).map((c) => c[1])).toEqual([3, 17, 32])
  expect(emit.mock.calls.map((c) => [c[1].seq, c[1].status])).toEqual([
    [1, 'preparing'],
    [2, 'drawing'],
    [3, 'drawing'],
    [4, 'committed'],
  ])
  const current = await service.inspect(sessionId)
  const scene = current.project.motionScenes![0]!
  expect(scene.posterFrame).toBe(12)
  expect(scene.objects.map((o) => o.id)).toEqual(['line', 'result'])
  await expect(
    service.mutate({
      sessionId,
      expectedRevision: current.project.revision,
      command: { type: 'upsertMotionScene', scene },
    }),
  ).rejects.toMatchObject({ code: 'motion_authoring_required' })
  expect(
    (
      await service.undo({
        sessionId,
        expectedRevision: current.project.revision,
      })
    ).project.motionScenes ?? [],
  ).toEqual([])
  const reopened = new VideoProjectService(options)
  await reopened.open({ sessionId })
  expect(await reopened.motionSettings({ sessionId })).toEqual({
    enabled: true,
  })
  expect(await reopened.motionWork({ sessionId })).toBeNull()
})

it('cancels rendering in flight on disable and suppresses late publication', async () => {
  const { ctx, service, validate, input, project, emit } = await fixture()
  await service.setMotionEnabled({ sessionId: ctx.sessionId, enabled: true })
  const work = await service.motion.begin(ctx, input)
  let unblock!: () => void
  const fence = new Promise<void>((resolve) => {
    unblock = resolve
  })
  validate.mockImplementationOnce(() => fence)
  const inflight = service.motion.object(ctx, {
    workId: work.workId,
    expectedSeq: work.seq,
    object,
  })
  await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1))
  await service.setMotionEnabled({ sessionId: ctx.sessionId, enabled: false })
  unblock()
  await expect(inflight).rejects.toThrow()
  expect(emit.mock.calls.map((c) => c[1].status)).toEqual([
    'preparing',
    'cancelled',
  ])
  expect((await service.inspect(ctx.sessionId)).project).toEqual(project)
})

it('discards stale, rerouted, explicitly cancelled and invalid scene work', async () => {
  const { ctx, service, validate, input, project } = await fixture()
  await service.setMotionEnabled({ sessionId: ctx.sessionId, enabled: true })
  let started = await service.motion.begin(ctx, input)
  const step = () => ({ workId: started.workId, expectedSeq: started.seq })
  await expect(
    service.motion.object(
      { ...ctx, scope: 'other-model' },
      { ...step(), object },
    ),
  ).rejects.toMatchObject({ code: 'motion_work_stale' })
  expect(service.motion.latest(ctx.sessionId)?.status).toBe('cancelled')
  started = await service.motion.begin(ctx, input)
  expect((await service.motion.cancel(ctx, step())).status).toBe('cancelled')
  started = await service.motion.begin(ctx, input)
  validate.mockRejectedValueOnce(new Error('draw: unknown node'))
  await expect(
    service.motion.object(ctx, { ...step(), object }),
  ).rejects.toThrow('draw: unknown node')
  expect(service.motion.latest(ctx.sessionId)).toMatchObject({
    status: 'failed',
    scene: null,
  })
  started = await service.motion.begin(ctx, input)
  await service.mutate({
    sessionId: ctx.sessionId,
    expectedRevision: project.revision,
    command: { type: 'updateCanvas', background: '#204060' },
  })
  await expect(
    service.motion.object(ctx, { ...step(), object }),
  ).rejects.toMatchObject({ code: 'motion_target_changed' })
  expect(
    (await service.inspect(ctx.sessionId)).project.motionScenes,
  ).toBeUndefined()
})

it('requires approval, checks the actual draft run and generation and stages one complete scene without touching live history', async () => {
  const { ctx, service, input, runs, root } = await fixture()
  const sourcePath = join(root, 'screen.png')
  await writeFile(sourcePath, 'fixture image')
  const { project } = await service.importAssets({
    sessionId: ctx.sessionId,
    sourcePaths: [sourcePath],
  })
  input.expectedRevision = project.revision
  await service.setMotionEnabled({ sessionId: ctx.sessionId, enabled: true })
  const { runId } = await runs.create(ctx.sessionId, '解释请求路径')
  await expect(service.motion.begin(ctx, input)).rejects.toMatchObject({
    code: 'treatment_not_approved',
  })
  await runs.propose(ctx.sessionId, ctx.scope, {
    summary: '图示请求的方向',
    picture: '动效叠加',
    mustKeep: [],
    pacing: '跟随口播',
  })
  await runs.decide(ctx.sessionId, runId, 'allowed-once')
  await expect(service.motion.begin(ctx, input)).rejects.toMatchObject({
    code: 'motion_target_changed',
  })
  const start = await service.motion.begin(ctx, {
    ...input,
    expectedRevision: undefined,
    runId,
    expectedGeneration: 0,
  })
  const step = await service.motion.object(ctx, {
    workId: start.workId,
    expectedSeq: start.seq,
    object,
  })
  expect(service.motion.latest(ctx.sessionId)).toMatchObject({
    runId,
    generation: 0,
    target: 'draft',
  })
  expect(
    (await runs.draftSnapshot(ctx.sessionId))?.project.motionScenes,
  ).toBeUndefined()
  const done = await service.motion.finish(ctx, {
    workId: step.workId,
    expectedSeq: step.seq,
  })
  expect(done.generation).toBe(1)
  const draft = await runs.draftSnapshot(ctx.sessionId, runId)
  expect(draft).toMatchObject({
    generation: 1,
    change: { motionSceneIds: ['scene'], time: 1 },
    project: { motionScenes: [{ id: 'scene' }] },
  })
  await expect(
    runs.stage(
      ctx.sessionId,
      ctx.scope,
      'fine_cut',
      [{ type: 'upsertMotionScene', scene: draft!.project.motionScenes![0]! }],
      undefined,
      1,
    ),
  ).rejects.toMatchObject({ code: 'motion_authoring_required' })
  expect((await service.inspect(ctx.sessionId)).project).toEqual(project)
})

it('rejects a staged live scene when a precision run takes over and rejects a draft scene after its run stops', async () => {
  const { service, ctx, runs, root, input } = await fixture()
  const { sessionId, scope } = ctx
  const source = join(root, 'image.png')
  await writeFile(source, 'fixture')
  const { project } = await service.importAssets({
    sessionId,
    sourcePaths: [source],
  })
  await service.setMotionEnabled({ sessionId, enabled: true })
  const live = await service.motion.begin(ctx, {
    ...input,
    expectedRevision: project.revision,
  })
  const drawing = await service.motion.object(ctx, {
    workId: live.workId,
    expectedSeq: live.seq,
    object,
  })
  const { runId } = await runs.create(sessionId, '重新剪辑')
  await runs.propose(sessionId, scope, {
    summary: '展示演示',
    mustKeep: [],
    pacing: '自然',
    picture: '叠加',
  })
  await runs.decide(sessionId, runId, 'allowed-once')
  await expect(
    service.motion.finish(ctx, {
      workId: live.workId,
      expectedSeq: drawing.seq,
    }),
  ).rejects.toMatchObject({ code: 'motion_target_changed' })
  const draft = await service.motion.begin(ctx, {
    ...input,
    expectedRevision: undefined,
    runId,
    expectedGeneration: 0,
  })
  const drawn = await service.motion.object(ctx, {
    workId: draft.workId,
    expectedSeq: draft.seq,
    object,
  })
  await runs.action(sessionId, 'cancel', runId)
  await expect(
    service.motion.finish(ctx, {
      workId: draft.workId,
      expectedSeq: drawn.seq,
    }),
  ).rejects.toMatchObject({ code: 'motion_target_changed' })
  expect((await service.inspect(sessionId)).project).toEqual(project)
})

it('fences a pending begin on workspace switch, including rapid reopen and subsequent calls in the same turn', async () => {
  const { ctx, service, input } = await fixture()
  await service.setMotionEnabled({ sessionId: ctx.sessionId, enabled: true })
  let release!: () => void
  const fence = new Promise<void>((resolve) => {
    release = resolve
  })
  const target = service.motionTarget.bind(service)
  const spy = vi
    .spyOn(service, 'motionTarget')
    .mockImplementationOnce(async (caller) => {
      await fence
      return target(caller)
    })
  const begin = service.motion.begin(ctx, input)
  await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
  const leaving = service.leaveMotionWorkspace({ sessionId: ctx.sessionId })
  await service.open({ sessionId: ctx.sessionId })
  const rejected = expect(begin).rejects.toMatchObject({
    code: 'motion_workspace_left',
  })
  release()
  await Promise.all([leaving, rejected])
  await expect(service.motion.begin(ctx, input)).rejects.toMatchObject({
    code: 'motion_workspace_left',
  })
  expect(service.motion.latest(ctx.sessionId)).toBeNull()
  expect(
    (await service.motion.begin({ ...ctx, turn: ctx.turn + 1 }, input)).status,
  ).toBe('preparing')
})

it.each([
  ['live', 'before'],
  ['live', 'after'],
  ['draft', 'before'],
  ['draft', 'after'],
] as const)(
  'reports a single durable outcome for %s cancellation %s atomic replacement',
  async (target, when) => {
    const { service, ctx, runs, root, input, emit } = await fixture()
    const { sessionId, scope } = ctx
    await service.setMotionEnabled({ sessionId, enabled: true })
    let runId: string | undefined
    if (target === 'draft') {
      const source = join(root, 'screen.png')
      await writeFile(source, 'fixture image')
      await service.importAssets({ sessionId, sourcePaths: [source] })
      runId = (await runs.create(sessionId, '绘制解释图')).runId
      await runs.propose(sessionId, scope, {
        summary: '解释请求',
        picture: '保留原片',
        mustKeep: [],
        pacing: '跟随口播',
      })
      await runs.decide(sessionId, runId, 'allowed-once')
    }
    const original = (await service.inspect(sessionId)).project
    const start = await service.motion.begin(ctx, {
      ...input,
      runId,
      expectedRevision: runId ? undefined : original.revision,
      expectedGeneration: runId ? 0 : undefined,
    })
    const step = await service.motion.object(ctx, {
      workId: start.workId,
      expectedSeq: start.seq,
      object,
    })
    const write = atomic.writeJsonAtomic
    let cancellation: ReturnType<typeof service.motion.cancel> | undefined
    const stop = () => {
      cancellation = service.motion.cancel(ctx, {
        workId: step.workId,
        expectedSeq: step.seq,
      })
    }
    const spy = vi
      .spyOn(atomic, 'writeJsonAtomic')
      .mockImplementation(async (path, data, opts) => {
        if (!path.endsWith(runId ? '/run.json' : '/timeline.json'))
          return write(path, data, opts)
        if (when === 'before')
          return atomic.writeTextAtomic(path, JSON.stringify(data), {
            ...opts,
            beforeCommit: async () => stop(),
          })
        await write(path, data, opts)
        stop()
      })
    try {
      const finish = service.motion.finish(ctx, {
        workId: step.workId,
        expectedSeq: step.seq,
      })
      if (when === 'before') await expect(finish).rejects.toThrow()
      else await expect(finish).resolves.toMatchObject({ status: 'committed' })
    } finally {
      spy.mockRestore()
    }
    await expect(cancellation).resolves.toMatchObject({
      status: when === 'before' ? 'cancelled' : 'committed',
    })
    expect(emit.mock.calls.map((call) => call[1].status)).toEqual([
      'preparing',
      'drawing',
      when === 'before' ? 'cancelled' : 'committed',
    ])
    const live = (await service.inspect(sessionId)).project
    if (runId) {
      expect(live).toEqual(original)
      const draft = await runs.draftSnapshot(sessionId, runId)
      expect(draft?.generation).toBe(when === 'before' ? 0 : 1)
      expect(draft?.project.motionScenes?.length ?? 0).toBe(
        when === 'before' ? 0 : 1,
      )
    } else {
      expect(live.revision).toBe(
        original.revision + (when === 'before' ? 0 : 1),
      )
      expect(live.motionScenes?.length ?? 0).toBe(when === 'before' ? 0 : 1)
    }
  },
)
