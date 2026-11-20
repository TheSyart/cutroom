import { z } from 'zod'
import { motionFrameSchema, motionSceneSchema } from './motion-schema'
export type { MotionScene, MotionObject, MotionAnchor } from './motion-schema'

const id = z.string().trim().min(1).max(128)
const sessionId = z.string().trim().min(1).max(256)
const revision = z.number().int().nonnegative()
const finite = z.number().finite()
const dimensions = z.number().int().min(1).max(32_768).nullable()

const transformSchema = z
  .object({
    scale: finite.min(0.5).max(2),
    x: finite.min(-100).max(100),
    y: finite.min(-100).max(100),
  })
  .strict()

const canvasSchema = z
  .object({
    fit: z.enum(['contain', 'cover']),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict()

export const videoAssetSchema = z
  .object({
    id,
    kind: z.enum(['video', 'image', 'audio']),
    path: z.string().min(1).max(4096),
    displayName: z.string().min(1).max(512),
    duration: finite.positive().max(86_400).nullable(),
    width: dimensions,
    height: dimensions,
  })
  .strict()

export const videoTrackSchema = z
  .object({
    id,
    kind: z.enum(['video', 'audio']),
    name: z.string().trim().min(1).max(64),
    /** 0 is the main track at the bottom; higher indexes cover lower ones. */
    index: z.number().int().min(0).max(7),
  })
  .strict()

export const videoClipSchema = z
  .object({
    id,
    trackId: id,
    assetId: id,
    timelineStart: finite.nonnegative().max(86_400),
    sourceIn: finite.nonnegative().max(86_400),
    sourceOut: finite.positive().max(86_400),
    speed: finite.min(0.25).max(4),
    volume: finite.min(0).max(1),
    fadeIn: finite.nonnegative().max(86400).optional(),
    fadeOut: finite.nonnegative().max(86400).optional(),
    muted: z.boolean(),
    transform: transformSchema,
  })
  .strict()

export const subtitleCueSchema = z
  .object({
    id,
    start: finite.nonnegative().max(86_400),
    end: finite.positive().max(86_400),
    text: z.string().trim().min(1).max(500),
  })
  .strict()

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const captionStyleSchema = z
  .object({
    fontSize: finite.int().min(12).max(120),
    color,
    position: z.enum(['top', 'bottom']),
    backgroundColor: color.optional(),
    backgroundOpacity: finite.min(0).max(1).optional(),
    outlineColor: color.optional(),
    outlineWidth: finite.min(0).max(12).optional(),
  })
  .strict()
const fraction = finite.min(0).max(1)
const annotation = z
  .object({
    kind: z.enum(['box', 'zoom']),
    start: finite.nonnegative().max(86400),
    end: finite.positive().max(86400),
    x: fraction,
    y: fraction,
    width: fraction.min(0.05),
    height: fraction.min(0.05),
    color,
  })
  .strict()
export type Annotation = z.infer<typeof annotation> & { id: string }
export const videoProjectSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: id,
    name: z.string().trim().min(1).max(256),
    revision,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    assets: z.array(videoAssetSchema).max(2000),
    tracks: z.array(videoTrackSchema).min(1).max(8),
    clips: z.array(videoClipSchema).max(5000),
    motionScenes: z.array(motionSceneSchema).max(5000).optional(),
    captionStyle: captionStyleSchema.optional(),
    annotations: z.array(annotation.extend({ id })).max(5000).optional(),
    subtitles: z.array(subtitleCueSchema).max(5000),
    canvas: canvasSchema,
  })
  .strict()

/** The v1 project shape, kept only to migrate existing projects. */
export const videoClipSchemaV1 = z
  .object({
    id,
    assetId: id,
    sourceIn: finite.nonnegative().max(86_400),
    sourceOut: finite.positive().max(86_400),
    speed: finite.min(0.25).max(4),
    volume: finite.min(0).max(1),
    muted: z.boolean(),
    transform: transformSchema,
  })
  .strict()

export const videoProjectSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    projectId: id,
    name: z.string().trim().min(1).max(256),
    revision,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    assets: z.array(videoAssetSchema).max(2000),
    clips: z.array(videoClipSchemaV1).max(5000),
    canvas: canvasSchema,
  })
  .strict()

export type VideoAsset = z.infer<typeof videoAssetSchema>
export type VideoTrack = z.infer<typeof videoTrackSchema>
export type VideoClip = z.infer<typeof videoClipSchema>
export type SubtitleCue = z.infer<typeof subtitleCueSchema>
export type CaptionStyle = z.infer<typeof captionStyleSchema>
export type VideoProject = z.infer<typeof videoProjectSchema>
export interface VideoProjectCommitDraftInput {
  sessionId: string
  expectedRevision: number
  draft: VideoProject
  workspaceAssetIds?: readonly string[]
  signal?: AbortSignal
}
export type VideoClipV1 = z.infer<typeof videoClipSchemaV1>
export type VideoProjectV1 = z.infer<typeof videoProjectSchemaV1>

const target = { clipId: id } as const
const addClipSchema = z
  .object({
    type: z.literal('addClip'),
    sourceIn: finite.nonnegative().max(86400).optional(),
    sourceOut: finite.positive().max(86400).optional(),
    assetId: id,
    duration: finite.min(0.1).max(3600).optional(),
    trackId: id.optional(),
    timelineStart: finite.nonnegative().max(86_400).optional(),
  })
  .strict()
const trimClipSchema = z
  .object({
    type: z.literal('trimClip'),
    ...target,
    sourceIn: finite.nonnegative().max(86_400).optional(),
    sourceOut: finite.positive().max(86_400).optional(),
    /** Which edge the user dragged; omitted for Agent edits. */
    edge: z.enum(['left', 'right']).optional(),
  })
  .strict()
  .refine(
    (value) => value.sourceIn !== undefined || value.sourceOut !== undefined,
    {
      message: 'trimClip requires sourceIn or sourceOut',
    },
  )
const updateClipSchema = z
  .object({
    type: z.literal('updateClip'),
    ...target,
    speed: finite.min(0.25).max(4).optional(),
    volume: finite.min(0).max(1).optional(),
    fadeIn: finite.nonnegative().max(86400).optional(),
    fadeOut: finite.nonnegative().max(86400).optional(),
    muted: z.boolean().optional(),
    transform: transformSchema.optional(),
  })
  .strict()

const subtitleInputSchema = z
  .object({
    start: finite.nonnegative().max(86_400),
    end: finite.positive().max(86_400),
    text: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((value) => value.end - value.start >= 0.05, {
    message: 'subtitle must be at least 0.05s',
  })

const updateSubtitleSchema = z
  .object({
    type: z.literal('updateSubtitle'),
    subtitleId: id,
    start: finite.nonnegative().max(86_400).optional(),
    end: finite.positive().max(86_400).optional(),
    text: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.start !== undefined ||
      value.end !== undefined ||
      value.text !== undefined,
    { message: 'updateSubtitle requires a change' },
  )

export const videoProjectCommandSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('upsertMotionScene'), scene: motionSceneSchema })
    .strict(),
  z
    .object({
      type: z.literal('deleteMotionScene'),
      sceneId: id,
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('deleteMotionObject'),
      sceneId: id,
      objectId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('setMotionAnchor'),
      sceneId: id,
      expectedVersion: z.number().int().positive().optional(),
      anchor: z
        .object({ clipId: id, sourceTime: finite.min(0).max(86_400) })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('moveMotionScene'),
      sceneId: id,
      startFrame: motionFrameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('trimMotionScene'),
      sceneId: id,
      startFrame: motionFrameSchema,
      sourceInFrame: motionFrameSchema,
      durationFrames: motionFrameSchema.min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('splitMotionScene'),
      sceneId: id,
      frame: motionFrameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('replaceClipRanges'),
      ...target,
      ranges: z
        .array(
          z
            .object({
              sourceIn: finite.nonnegative(),
              sourceOut: finite.positive(),
            })
            .strict(),
        )
        .min(1)
        .max(5000),
    })
    .strict(),
  z
    .object({ type: z.literal('setCaptionStyle'), style: captionStyleSchema })
    .strict(),
  z.object({ type: z.literal('addAnnotation'), annotation }).strict(),
  z
    .object({
      type: z.literal('updateAnnotation'),
      annotationId: id,
      annotation,
    })
    .strict(),
  z.object({ type: z.literal('deleteAnnotation'), annotationId: id }).strict(),
  addClipSchema,
  trimClipSchema,
  z
    .object({
      type: z.literal('splitClip'),
      ...target,
      timelineOffset: finite.positive().max(86_400),
    })
    .strict(),
  z.object({ type: z.literal('deleteClip'), ...target }).strict(),
  z
    .object({
      type: z.literal('rippleDeleteRange'),
      start: finite.nonnegative(),
      end: finite.positive(),
    })
    .strict()
    .refine(({ start, end }) => end > start, {
      message: 'rippleDeleteRange requires end > start',
    }),
  z
    .object({
      type: z.literal('moveClip'),
      ...target,
      trackId: id,
      timelineStart: finite.nonnegative().max(86_400),
    })
    .strict(),
  updateClipSchema,
  z
    .object({
      type: z.literal('addTrack'),
      kind: z.enum(['video', 'audio']).optional(),
      name: z.string().trim().min(1).max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal('removeTrack'), trackId: id }).strict(),
  z
    .object({ type: z.literal('addSubtitle'), ...subtitleInputSchema.shape })
    .strict(),
  updateSubtitleSchema,
  z.object({ type: z.literal('deleteSubtitle'), subtitleId: id }).strict(),
  z
    .object({
      type: z.literal('replaceSubtitles'),
      replaceIds: z.array(id).max(5000).optional(),
      cues: z.array(subtitleInputSchema).max(5000),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateCanvas'),
      fit: z.enum(['contain', 'cover']).optional(),
      background: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict(),
])

export type VideoProjectCommand = z.infer<typeof videoProjectCommandSchema>

export const videoProjectOpenInputSchema = z.union([
  z
    .object({
      projectPath: z.string().trim().min(1).max(4096),
      initialize: z.boolean().optional(),
    })
    .strict(),
  z.object({ sessionId, initialize: z.boolean().optional() }).strict(),
])
export const videoProjectImportInputSchema = z
  .object({
    sessionId,
    sourcePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(64),
  })
  .strict()
export const videoProjectRemoveMissingAssetInputSchema = z
  .object({
    sessionId,
    expectedRevision: revision,
    assetId: id,
  })
  .strict()
export const videoProjectRelinkInputSchema =
  videoProjectRemoveMissingAssetInputSchema.extend({
    sourcePath: z.string().trim().min(1).max(4096),
  })
export type VideoProjectRemoveMissingAssetInput = z.infer<
  typeof videoProjectRemoveMissingAssetInputSchema
>
export type VideoProjectRelinkInput = z.infer<
  typeof videoProjectRelinkInputSchema
>

export const videoProjectMetadataInputSchema = z
  .object({
    sessionId,
    expectedRevision: revision,
    assetId: id,
    duration: finite.positive().max(86_400).nullable(),
    width: dimensions,
    height: dimensions,
  })
  .strict()
export const videoProjectMutateInputSchema = z
  .object({
    sessionId,
    expectedRevision: revision,
    command: videoProjectCommandSchema,
  })
  .strict()
export const videoProjectRevisionInputSchema = z
  .object({
    sessionId,
    expectedRevision: revision,
  })
  .strict()

export const videoProjectTranscribeInputSchema = z
  .object({
    sessionId,
    assetId: id,
    language: z.enum(['auto', 'zh', 'en']).optional(),
    force: z.boolean().optional(),
  })
  .strict()

export const videoProjectTranscriptInputSchema = z
  .object({ sessionId, assetId: id })
  .strict()

export const videoProjectFramesInputSchema = z
  .object({
    sessionId,
    assetId: id,
    times: z.array(finite.nonnegative().max(86_400)).min(1).max(6),
  })
  .strict()

export interface VideoProjectSession {
  id: string
  mode?: string | null
  project_path?: string | null
  title?: string | null
  archived_at?: string | null
}

export interface VideoProjectResult {
  readOnlyReason?: string
  editRunRecovery?: string
  project: VideoProject
  sessionId: string
  projectPath: string
  selectedClipId?: string | null
  selectedSubtitleId?: string | null
  selectedMotionSceneId?: string | null
  missingAssetIds?: string[]
  canUndo: boolean
  canRedo: boolean
}

export interface DraftReviewIssue {
  code: string
  start: number
  end: number
  severity: 'warning' | 'error'
  message: string
}

export type VideoProjectOpenInput = z.infer<typeof videoProjectOpenInputSchema>
export type VideoProjectImportInput = z.infer<
  typeof videoProjectImportInputSchema
>
export type VideoProjectMetadataInput = z.infer<
  typeof videoProjectMetadataInputSchema
>
export type VideoProjectMutateInput = z.infer<
  typeof videoProjectMutateInputSchema
>
export type VideoProjectRevisionInput = z.infer<
  typeof videoProjectRevisionInputSchema
>
export type VideoProjectTranscribeInput = z.infer<
  typeof videoProjectTranscribeInputSchema
>
export type VideoProjectTranscriptInput = z.infer<
  typeof videoProjectTranscriptInputSchema
>
export type VideoProjectFramesInput = z.infer<
  typeof videoProjectFramesInputSchema
>
