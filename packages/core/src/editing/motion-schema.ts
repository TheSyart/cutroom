import { z } from 'zod'

import { MAX_MOTION_FRAME } from './motion-constants'

export const motionFrameSchema = z.number().int().min(0).max(MAX_MOTION_FRAME)
const id = z.string().trim().min(1).max(128)
const name = z.string().trim().min(1).max(256)
const finite = z.number().finite()
const bounds = z
  .object({
    x: finite,
    y: finite,
    width: finite.positive(),
    height: finite.positive(),
  })
  .strict()

export const motionObjectSchema = z
  .object({
    id,
    name,
    html: z.string().max(512_000),
    draw: z.string().max(512_000),
    bounds,
    markers: z
      .array(z.object({ frame: motionFrameSchema, label: name }).strict())
      .max(2048),
  })
  .strict()

const playbackSchema = z
  .object({
    /** Local animation frames per project frame after a linked clip changes speed. */
    rate: finite.positive().optional(),
    /** Fractional part of the trimmed local frame, retained across subsequent splits. */
    phase: finite.min(0).lt(1).optional(),
    /** Exact exclusive local end before projecting onto integral timeline frames. */
    endFrame: finite.positive().optional(),
  })
  .strict()

const anchorSchema = z
  .object({
    clipId: id,
    sourceTime: finite.nonnegative().max(86_400),
    status: z.literal('lost').optional(),
    /** Distance from the source anchor to the scene start, measured in source seconds. */
    offsetSource: finite.optional(),
  })
  .strict()

export const motionSceneSchema = z
  .object({
    id,
    name,
    startFrame: motionFrameSchema,
    durationFrames: motionFrameSchema.min(1),
    sourceInFrame: motionFrameSchema,
    /** First validated preview sample on the scene's local frame clock. */
    posterFrame: z.number().int().nonnegative().optional(),
    version: z.number().int().positive(),
    mode: z.enum(['overlay', 'fullscreen']),
    objects: z.array(motionObjectSchema).min(1).max(256),
    story: z.string().max(32_768),
    anchor: anchorSchema.optional(),
    playback: playbackSchema.optional(),
  })
  .strict()
  .superRefine((scene, ctx) => {
    if (scene.startFrame + scene.durationFrames > MAX_MOTION_FRAME)
      ctx.addIssue({
        code: 'custom',
        path: ['durationFrames'],
        message: '动效超出时间线范围。',
      })
    if (
      new Set(scene.objects.map((object) => object.id)).size !==
      scene.objects.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['objects'],
        message: '动效场景内的对象 ID 必须唯一。',
      })
  })
export type MotionScene = z.infer<typeof motionSceneSchema>
export type MotionObject = z.infer<typeof motionObjectSchema>
export type MotionAnchor = z.infer<typeof anchorSchema>
