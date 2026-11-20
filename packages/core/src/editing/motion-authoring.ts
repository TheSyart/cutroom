import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EmperorError } from '../errors'
import { applyVideoProjectCommand } from './commands'
import {
  MAX_MOTION_FRAME,
  MOTION_FPS,
  motionFrameAt,
  motionFrameSchema,
  motionObjectSchema,
  motionSceneSchema,
  motionTimelineFrame,
  type MotionScene,
} from './motion'
import type { VideoProject } from './types'

const id = z.string().trim().min(1).max(128)
const version = z.number().int().nonnegative()
export const motionBeginSchema = z
  .object({
    sceneId: id,
    name: z.string().trim().min(1).max(256),
    story: z.string().trim().min(1).max(32_768),
    startFrame: motionFrameSchema,
    durationFrames: motionFrameSchema.min(1),
    sourceInFrame: motionFrameSchema.optional(),
    mode: z.enum(['overlay', 'fullscreen']),
    anchor: z
      .object({
        clipId: id,
        sourceTime: z.number().finite().min(0).max(86_400),
      })
      .strict()
      .nullable()
      .optional(),
    expectedVersion: version,
    expectedRevision: version.optional(),
    expectedGeneration: version.optional(),
    runId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (a) => a.startFrame + a.durationFrames <= MAX_MOTION_FRAME,
    '动效超出时间线范围。',
  )
  .refine(
    (a) =>
      a.runId
        ? a.expectedGeneration !== undefined && a.expectedRevision === undefined
        : a.expectedRevision !== undefined &&
          a.expectedGeneration === undefined,
    '请指定时间线 revision，或精剪 runId 与 generation。',
  )
export const motionStepSchema = z
  .object({ workId: z.string().uuid(), expectedSeq: version })
  .strict()
export const motionObjectStepSchema = motionStepSchema.extend({
  object: motionObjectSchema,
  frame: motionFrameSchema.optional(),
  endFrame: motionFrameSchema.optional(),
})
type Begin = z.infer<typeof motionBeginSchema>
type Step = z.infer<typeof motionStepSchema>
export type MotionContext = {
  sessionId: string
  scope: string
  turn: number
  precisionTurn?: boolean
  signal: AbortSignal
}
export type MotionWorkStatus =
  'preparing' | 'drawing' | 'committed' | 'cancelled' | 'failed'
export interface MotionWork {
  id: string
  seq: number
  status: MotionWorkStatus
  /** Identifies the candidate even before its first validated frame. */
  sceneId?: string
  scene: MotionScene | null
  objectId?: string
  frame?: number
  /** Wall-clock receipt of this object step, before queuing and rendering. */
  stepReceivedAt?: number
  /** Exclusive project frame. */
  endFrame?: number
  message: string
  target: 'draft' | 'live'
  runId?: string
  generation?: number
}
export interface MotionTarget {
  project: VideoProject
  runId?: string
  generation?: number
}
interface WorkSession {
  work: MotionWork
  candidate: MotionScene
  target: MotionTarget
  scope: string
  turn: number
  controller: AbortController
  saving?: boolean
  pendingEnd?: { status: 'cancelled' | 'failed'; message: string }
}
interface MotionAuthoringOptions {
  inspect(ctx: MotionContext): Promise<MotionTarget>
  commit(
    ctx: MotionContext,
    target: MotionTarget,
    scene: MotionScene,
  ): Promise<{ revision?: number; generation?: number }>
  validate?(
    scene: MotionScene,
    frame: number,
    signal?: AbortSignal,
  ): Promise<void>
  emit(sessionId: string, work: MotionWork): void
}
function fail(message: string, code: string): never {
  throw new EmperorError(message, code)
}
function ongoing(work?: MotionWork | null) {
  return work?.status === 'preparing' || work?.status === 'drawing'
}
function sameTarget(a: MotionTarget, b: MotionTarget) {
  return (
    a.runId === b.runId &&
    a.project.projectId === b.project.projectId &&
    (a.runId
      ? a.generation === b.generation
      : a.project.revision === b.project.revision)
  )
}
function receipt(work: MotionWork) {
  return {
    workId: work.id,
    seq: work.seq,
    status: work.status,
    target: work.target,
    runId: work.runId,
    generation: work.generation,
    frame: work.frame,
    objectId: work.objectId,
  }
}

/** Unfinished code lives in process memory. Only the final CAS crosses a persistence boundary. */
export class MotionAuthoring {
  private readonly sessions = new Map<string, WorkSession>()
  private readonly snapshots = new Map<string, MotionWork>()
  private readonly left = new Set<string>()
  private readonly abandonedThroughTurn = new Map<string, number>()
  private readonly lastAttemptTurn = new Map<string, number>()
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(private readonly options: MotionAuthoringOptions) {}

  latest(sessionId: string) {
    return this.snapshots.get(sessionId) ?? null
  }
  isEditingLiveScene(sessionId: string, sceneId: string): boolean {
    const work = this.latest(sessionId)
    return work?.target === 'live' && ongoing(work) && work.sceneId === sceneId
  }
  private async serial<T>(id: string, action: () => Promise<T>) {
    const run = Promise.resolve(this.locks.get(id))
      .catch(() => undefined)
      .then(action)
    this.locks.set(id, run)
    try {
      return await run
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id)
    }
  }
  private publish(
    sessionId: string,
    entry: WorkSession,
    changes: Partial<MotionWork>,
  ) {
    entry.work = { ...entry.work, ...changes, seq: entry.work.seq + 1 }
    if (this.sessions.get(sessionId) !== entry) return receipt(entry.work)
    this.snapshots.set(sessionId, entry.work)
    if (!ongoing(entry.work)) this.sessions.delete(sessionId)
    this.options.emit(sessionId, entry.work)
    return receipt(entry.work)
  }
  end(
    sessionId: string,
    message: string,
    status: 'cancelled' | 'failed' = 'cancelled',
  ) {
    const entry = this.sessions.get(sessionId)
    if (!entry || !ongoing(entry.work)) return
    entry.controller.abort()
    // The atomic rename can already be in flight. Its result determines which
    // terminal event agrees with the persisted project or draft.
    if (entry.saving) {
      entry.pendingEnd ??= { status, message }
      return
    }
    this.publish(sessionId, entry, entry.pendingEnd ?? { status, message })
  }
  checkRoute(sessionId: string, scope?: string) {
    const entry = this.sessions.get(sessionId)
    if (entry && entry.scope !== scope)
      this.end(sessionId, '模型已切换，动效制作已停止。')
  }
  forget(sessionId: string) {
    this.end(sessionId, '剪辑会话已关闭。')
    this.sessions.delete(sessionId)
    this.snapshots.delete(sessionId)
    this.left.delete(sessionId)
    this.lastAttemptTurn.delete(sessionId)
    this.abandonedThroughTurn.delete(sessionId)
  }
  async leave(sessionId: string, turn?: number) {
    // Fence synchronous callers before waiting for a pending validation or atomic write.
    this.left.add(sessionId)
    this.abandonedThroughTurn.set(
      sessionId,
      Math.max(
        this.abandonedThroughTurn.get(sessionId) ?? -1,
        this.lastAttemptTurn.get(sessionId) ?? -1,
        turn ?? -1,
      ),
    )
    this.end(sessionId, '已离开该工程，未完成的动效已取消。')
    await this.locks.get(sessionId)?.catch(() => undefined)
  }
  reopen(sessionId: string) {
    this.left.delete(sessionId)
  }
  private assertCurrentTurn(ctx: MotionContext) {
    if (
      this.left.has(ctx.sessionId) ||
      ctx.turn <= (this.abandonedThroughTurn.get(ctx.sessionId) ?? -1)
    )
      fail(
        '已离开原工程，请在当前工程发起新一轮动效制作。',
        'motion_workspace_left',
      )
  }
  private async sample(
    scene: MotionScene,
    projectFrame: number,
    signal: AbortSignal,
  ) {
    const local = motionFrameAt(scene, projectFrame / MOTION_FPS)
    if (local === null)
      fail('预览帧超出场景范围或原声锚点已丢失。', 'motion_frame_invalid')
    if (!this.options.validate)
      fail('当前环境未连接动效预览渲染器。', 'motion_renderer_unavailable')
    signal.throwIfAborted()
    await this.options.validate(scene, local, signal)
    signal.throwIfAborted()
  }
  async begin(ctx: MotionContext, args: Begin) {
    this.assertCurrentTurn(ctx)
    this.lastAttemptTurn.set(ctx.sessionId, ctx.turn)
    return this.serial(ctx.sessionId, async () => {
      ctx.signal.throwIfAborted()
      const target = await this.options.inspect(ctx)
      ctx.signal.throwIfAborted()
      this.assertCurrentTurn(ctx)
      if (
        args.runId !== target.runId ||
        (target.runId
          ? args.expectedGeneration !== target.generation
          : args.expectedRevision !== target.project.revision)
      )
        fail(
          '时间线或精剪版本已变化，请重新读取工程。',
          'motion_target_changed',
        )
      const prior = target.project.motionScenes?.find(
        (s) => s.id === args.sceneId,
      )
      if ((prior?.version ?? 0) !== args.expectedVersion)
        fail('动效版本已变化，请重新读取场景。', 'motion_version_conflict')
      if (ongoing(this.latest(ctx.sessionId)))
        fail('请先完成或取消当前动效制作。', 'motion_work_active')
      const candidate: MotionScene = {
        id: args.sceneId,
        name: args.name,
        story: args.story,
        mode: args.mode,
        version: args.expectedVersion + 1,
        startFrame: args.startFrame,
        durationFrames: args.durationFrames,
        sourceInFrame: args.sourceInFrame ?? prior?.sourceInFrame ?? 0,
        ...(prior?.posterFrame === undefined
          ? {}
          : { posterFrame: prior.posterFrame }),
        objects: prior?.objects ?? [],
        ...(prior?.playback ? { playback: prior.playback } : {}),
        ...(args.anchor === null
          ? {}
          : { anchor: args.anchor ?? prior?.anchor }),
      }
      const work: MotionWork = {
        id: randomUUID(),
        seq: this.latest(ctx.sessionId)?.seq ?? 0,
        sceneId: candidate.id,
        scene: null,
        status: 'preparing',
        target: target.runId ? 'draft' : 'live',
        ...(target.runId
          ? { runId: target.runId, generation: target.generation }
          : {}),
        frame: candidate.startFrame,
        endFrame: candidate.startFrame + candidate.durationFrames,
        message: '正在准备动效「' + candidate.name + '」。',
      }
      const entry = {
        work,
        candidate,
        target,
        scope: ctx.scope,
        turn: ctx.turn,
        controller: new AbortController(),
      }
      this.sessions.set(ctx.sessionId, entry)
      return this.publish(ctx.sessionId, entry, {})
    })
  }
  private entry(ctx: MotionContext, args: Step) {
    this.checkRoute(ctx.sessionId, ctx.scope)
    const item = this.sessions.get(ctx.sessionId)
    if (
      !item ||
      !ongoing(item.work) ||
      item.work.id !== args.workId ||
      item.turn !== ctx.turn ||
      item.work.seq !== args.expectedSeq
    )
      fail('制作步骤已过期，请读取当前动效进度。', 'motion_work_stale')
    return item
  }
  private async change<T>(
    ctx: MotionContext,
    step: Step,
    action: (entry: WorkSession, signal: AbortSignal) => Promise<T>,
  ) {
    return this.serial(ctx.sessionId, async () => {
      const entry = this.entry(ctx, step)
      const signal = AbortSignal.any([ctx.signal, entry.controller.signal])
      try {
        signal.throwIfAborted()
        if (!sameTarget(entry.target, await this.options.inspect(ctx)))
          fail('时间线或精剪草稿已更新。', 'motion_target_changed')
        signal.throwIfAborted()
        return await action(entry, signal)
      } catch (cause) {
        entry.saving = false
        this.end(
          ctx.sessionId,
          signal.aborted
            ? '动效制作已中断。'
            : cause instanceof Error
              ? cause.message
              : '动效制作失败。',
          signal.aborted ? 'cancelled' : 'failed',
        )
        throw cause
      }
    })
  }
  object(ctx: MotionContext, args: z.infer<typeof motionObjectStepSchema>) {
    const stepReceivedAt = Date.now()
    return this.change(ctx, args, async (entry, signal) => {
      const objects = [...entry.candidate.objects]
      const index = objects.findIndex((o) => o.id === args.object.id)
      if (index < 0) objects.push(args.object)
      else objects[index] = args.object
      const scene = this.checkedScene(entry.target.project, {
        ...entry.candidate,
        objects,
      })
      const markerFrame = args.object.markers
        .map((m) => motionTimelineFrame(scene, m.frame))
        .find((f) => f !== null)
      const frame = args.frame ?? markerFrame ?? scene.startFrame
      const endFrame = args.endFrame ?? scene.startFrame + scene.durationFrames
      if (
        endFrame <= frame ||
        endFrame > scene.startFrame + scene.durationFrames
      )
        fail('试播结束帧必须在本幕内并晚于起点。', 'motion_frame_invalid')
      await this.sample(scene, frame, signal)
      scene.posterFrame ??= motionFrameAt(scene, frame / MOTION_FPS)!
      if (
        !sameTarget(
          entry.target,
          await this.options.inspect({ ...ctx, signal }),
        )
      )
        fail('预览期间时间线已更新。', 'motion_target_changed')
      signal.throwIfAborted()
      entry.candidate = scene
      return this.publish(ctx.sessionId, entry, {
        scene,
        status: 'drawing',
        stepReceivedAt,
        objectId: args.object.id,
        frame,
        endFrame,
        message: '正在绘制「' + args.object.name + '」。',
      })
    })
  }
  private checkedScene(project: VideoProject, scene: MotionScene) {
    const checked = applyVideoProjectCommand(project, {
      type: 'upsertMotionScene',
      scene: motionSceneSchema.parse(scene),
    })
    return checked.project.motionScenes!.find((s) => s.id === scene.id)!
  }
  finish(ctx: MotionContext, args: Step) {
    return this.change(ctx, args, async (entry, signal) => {
      const scene = this.checkedScene(entry.target.project, entry.candidate)
      const last = scene.startFrame + scene.durationFrames - 1
      for (const frame of new Set([
        scene.startFrame,
        Math.floor((scene.startFrame + last) / 2),
        last,
      ]))
        await this.sample(scene, frame, signal)
      entry.saving = true
      const result = await this.options.commit(
        { ...ctx, signal },
        entry.target,
        scene,
      )
      return {
        ...this.publish(ctx.sessionId, entry, {
          scene,
          status: 'committed',
          ...(result.generation !== undefined
            ? { generation: result.generation }
            : {}),
          message: entry.target.runId
            ? '动效已加入精剪草稿。'
            : '动效已加入时间线。',
        }),
        ...result,
      }
    })
  }
  async cancel(ctx: MotionContext, args: Step) {
    const entry = this.entry(ctx, args)
    this.end(ctx.sessionId, '动效制作已取消。')
    if (entry.saving)
      await this.locks.get(ctx.sessionId)?.catch(() => undefined)
    return receipt(entry.work)
  }
}
