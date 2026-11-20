import { z } from 'zod'

const id = z.string().min(1).max(512)
const time = z.number().nonnegative()
const frame = z.number().int().nonnegative()
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clip'), id }).strict(),
  z.object({ kind: z.literal('subtitle'), id }).strict(),
  z.object({ kind: z.literal('track'), id }).strict(),
  z.object({ kind: z.literal('subtitle-track') }).strict(),
  z.object({ kind: z.literal('point'), time }).strict(),
  z.object({ kind: z.literal('range'), start: time, end: time }).strict(),
  z
    .object({
      kind: z.literal('motion'),
      id,
      objectId: id.optional(),
      markerFrame: frame.optional(),
    })
    .strict(),
])

/** Coordinates are seconds in the cited timeline, including for a draft. */
export const timelineSnapshotSchema = z
  .object({
    sessionId: id,
    projectId: id,
    projectName: z.string().max(512),
    revision: frame,
    draft: z.object({ runId: id, generation: frame }).strict().optional(),
    target,
    start: time,
    end: time,
    trackId: id.optional(),
    assetId: id.optional(),
    sourceIn: time.optional(),
    sourceOut: time.optional(),
    excerpt: z.string().max(240).optional(),
    sceneVersion: frame.optional(),
  })
  .strict()
  .refine((entry) => entry.start <= entry.end)

export type TimelineSnapshot = z.infer<typeof timelineSnapshotSchema>
export type TimelineReferenceTarget = TimelineSnapshot['target']
export interface TimelineChip {
  kind: 'timeline'
  id: string
  label: string
  timeline: TimelineSnapshot
}
