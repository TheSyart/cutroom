import { z } from 'zod'
import { currentTurnSource } from '../harness/host/turn-source'
import type { Agent } from '../harness/agent/agent'
import {
  defineTool,
  ToolError,
  type ToolRunContext,
} from '../harness/tools/definition'
import {
  motionBeginSchema,
  motionObjectStepSchema,
  motionStepSchema,
} from './motion-authoring'
import type { VideoProjectService } from './project-store'

export function createMotionTools(
  service: VideoProjectService,
  requestScope: (agent: Agent) => string | undefined,
) {
  function context(call: ToolRunContext) {
    const agent = call.agent
    if (!agent || agent.owner !== undefined)
      throw new ToolError(
        '动效制作需要当前工程会话。',
        'workspace_session_required',
      )
    const scope = requestScope(agent)
    if (!scope)
      throw new ToolError('无法确认当前模型。', 'motion_model_missing')
    return {
      sessionId: agent.id,
      scope,
      turn: agent.position.turn,
      precisionTurn:
        currentTurnSource(agent.session.events) === 'video-precision-edit',
      signal: call.signal,
    }
  }
  return [
    defineTool({
      name: 'video_motion_read',
      category: 'editing',
      description:
        'Read a saved scene by sceneId and one object by objectId to revise its HTML and JavaScript. Omit sceneId for the current versioned authoring work receipt and a page of scene summaries; follow nextSceneOffset. Returns the approved draft during precision editing.',
      input: z
        .object({
          sceneId: z.string().max(128).optional(),
          objectId: z.string().max(128).optional(),
          sceneOffset: z.number().int().min(0).max(5000).default(0),
        })
        .strict(),
      isConcurrencySafe: () => true,
      execute: async (args, call) => {
        const ctx = context(call)
        const target = await service.motionTarget(ctx)
        const scenes = target.project.motionScenes ?? []
        const scene = scenes.find((s) => s.id === args.sceneId)
        if (args.sceneId && !scene)
          throw new ToolError('找不到指定动效场景。', 'motion_scene_missing')
        const object = scene?.objects.find((o) => o.id === args.objectId)
        if (args.objectId && !object)
          throw new ToolError('找不到指定动效对象。', 'motion_object_missing')
        const work = service.motion.latest(ctx.sessionId)
        return JSON.stringify({
          revision: target.project.revision,
          generation: target.generation,
          runId: target.runId,
          work: work && {
            workId: work.id,
            seq: work.seq,
            status: work.status,
            target: work.target,
            message: work.message,
          },
          nextSceneOffset:
            !scene && args.sceneOffset + 30 < scenes.length
              ? args.sceneOffset + 30
              : null,
          scenes: (scene
            ? [scene]
            : scenes.slice(args.sceneOffset, args.sceneOffset + 30)
          ).map((s) => ({
            ...s,
            objects: s.objects.map(({ id, name, bounds, markers }) => ({
              id,
              name,
              bounds,
              markerCount: markers.length,
            })),
          })),
          object,
        })
      },
    }),
    defineTool({
      name: 'video_motion_begin',
      category: 'editing',
      description:
        'Start a transactional animation scene. Supply the live expectedRevision or approved draft runId and expectedGeneration; expectedVersion is 0 to create, or the current scene version to revise. Existing objects carry forward. All timing uses 30 fps. Story records the actual narration cue, subject, action, and visual continuity.',
      input: motionBeginSchema,
      execute: async (args, call) =>
        JSON.stringify(await service.motion.begin(context(call), args)),
    }),
    defineTool({
      name: 'video_motion_object',
      category: 'editing',
      description:
        'Draw one named object in the open scene, or replace it by ID. Send an HTML/SVG/canvas fragment, deterministic draw(root,t,frame,gsap) function BODY, bounds in 1920×1080 pixels and local frame markers. Optional frame and exclusive endFrame restrict the audition to the affected project frames. Each validated object appears immediately. Pass the latest seq from the receipt.',
      input: motionObjectStepSchema,
      execute: async (args, call) =>
        JSON.stringify(await service.motion.object(context(call), args)),
    }),
    defineTool({
      name: 'video_motion_finish',
      category: 'editing',
      description:
        'Preflight the start, middle and last frames, then save one undoable revision or stage once in the approved precision draft. Supply the latest workId and expectedSeq.',
      input: motionStepSchema,
      execute: async (args, call) =>
        JSON.stringify(await service.motion.finish(context(call), args)),
    }),
    defineTool({
      name: 'video_motion_cancel',
      category: 'editing',
      description:
        'Discard the current unfinished drawing without changing saved animation or the timeline.',
      input: motionStepSchema,
      execute: async (args, call) =>
        JSON.stringify(await service.motion.cancel(context(call), args)),
    }),
  ]
}
