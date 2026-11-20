import { z } from 'zod'
import { applyVideoProjectCommand } from './commands'
import { MOTION_FPS } from './motion'
import { timelineLayout } from './timeline'
import type { VideoProject, VideoProjectCommand } from './types'

const seconds = z.number().finite().nonnegative()
const epsilon = 1e-6
const visualRangeSchema = z.object({ start: seconds, end: seconds })
export type VisualRange = z.infer<typeof visualRangeSchema>
const visualAssetSchema = z.object({
  duration: seconds,
  ranges: z.array(visualRangeSchema),
  gaps: z.array(visualRangeSchema).optional(),
  scope: z.array(visualRangeSchema),
})
export const visualLedgerSchema = z.object({
  local: z.boolean(),
  source: z.record(z.string(), visualAssetSchema),
  draft: visualAssetSchema
    .extend({
      generation: z.number().int().positive(),
      fingerprint: z.string(),
    })
    .optional(),
})
export type VisualLedger = z.infer<typeof visualLedgerSchema>

export const draftChangeSchema = z.object({
  clipIds: z.array(z.string()),
  subtitleIds: z.array(z.string()),
  motionSceneIds: z.array(z.string()).optional(),
  trackIds: z.array(z.string()),
  time: seconds,
})

export function mergeRanges(ranges: readonly VisualRange[]): VisualRange[] {
  const merged: VisualRange[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.end <= range.start) continue
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end + epsilon)
      previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

function progress(
  scopeRanges: readonly VisualRange[],
  ranges: readonly VisualRange[],
) {
  const unread: VisualRange[] = []
  let readSeconds = 0
  for (const scope of scopeRanges) {
    let cursor = scope.start
    for (const range of ranges) {
      const start = Math.max(cursor, range.start)
      const end = Math.min(scope.end, range.end)
      if (end <= start) continue
      if (start > cursor + epsilon) unread.push({ start: cursor, end: start })
      readSeconds += end - start
      cursor = end
    }
    if (scope.end > cursor + epsilon)
      unread.push({ start: cursor, end: scope.end })
  }
  return { readSeconds, unread }
}

export function visualProgress(asset: z.infer<typeof visualAssetSchema>) {
  const frames = progress(asset.scope, asset.ranges)
  const gaps = asset.gaps ?? []
  const noPicture = progress(gaps, asset.ranges).unread
  const unread = gaps.length
    ? progress(asset.scope, mergeRanges([...asset.ranges, ...gaps])).unread
    : frames.unread
  return {
    duration: asset.duration,
    readSeconds: frames.readSeconds,
    unread,
    ...(noPicture.length ? { noPicture } : {}),
  }
}

export function visualCoverage(
  visual: VisualLedger,
  project: VideoProject,
  generation: number,
  review?: { duration: number; generation: number },
) {
  const source = Object.entries(visual.source).map(([assetId, ledger]) => ({
    assetId,
    name:
      project.assets.find((asset) => asset.id === assetId)?.displayName ??
      assetId,
    ...visualProgress(ledger),
  }))
  const draft =
    review?.generation === generation
      ? visualProgress(
          visual.draft?.generation === generation
            ? visual.draft
            : {
                duration: review.duration,
                ranges: [],
                scope: [{ start: 0, end: review.duration }],
              },
        )
      : undefined
  return { source, draft }
}

export function unreadSourceEdits(
  before: VideoProject,
  after: VideoProject,
  ledger: VisualLedger,
) {
  const intervals = (project: VideoProject, assetId: string) =>
    mergeRanges(
      project.clips
        .filter((clip) => clip.assetId === assetId)
        .map((clip) => ({ start: clip.sourceIn, end: clip.sourceOut })),
    )
  return after.assets
    .filter((asset) => asset.kind === 'video')
    .flatMap((asset) => {
      const prior = intervals(before, asset.id)
      const next = intervals(after, asset.id)
      const affected = mergeRanges([
        ...progress(prior, next).unread,
        ...progress(next, prior).unread,
      ])
      const source = ledger.source[asset.id]
      const checked = source
        ? mergeRanges([...source.ranges, ...(source.gaps ?? [])])
        : []
      return progress(affected, checked).unread.map((range) => ({
        assetId: asset.id,
        name: asset.displayName,
        ...range,
      }))
    })
}

function changes<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): Array<{ previous?: T; current?: T }> {
  const old = new Map(before.map((item) => [item.id, item]))
  const updated: Array<{ previous?: T; current?: T }> = []
  for (const current of after) {
    const previous = old.get(current.id)
    if (JSON.stringify(previous) !== JSON.stringify(current))
      updated.push({ previous, current })
    old.delete(current.id)
  }
  return [...updated, ...Array.from(old.values(), (previous) => ({ previous }))]
}

export function applyDraftCommands(
  base: VideoProject,
  commands: readonly VideoProjectCommand[],
) {
  let project = base
  const selected: string[] = []
  let retimeSubtitles: VisualRange[] = []
  for (const command of commands) {
    const applied = applyVideoProjectCommand(project, command)
    project = applied.project
    if (applied.selectedClipId) selected.push(applied.selectedClipId)
    if (command.type === 'rippleDeleteRange') {
      const { start, end } = command
      const map = (time: number) =>
        time <= start ? time : Math.max(start, time - (end - start))
      retimeSubtitles = retimeSubtitles.map((cue) => ({
        start: map(cue.start),
        end: map(cue.end),
      }))
    }
    retimeSubtitles.push(...(applied.retimeSubtitles ?? []))
  }
  const clips = changes(base.clips, project.clips)
  const subtitles = changes(base.subtitles, project.subtitles)
  const tracks = changes(base.tracks, project.tracks)
  const annotations = changes(base.annotations ?? [], project.annotations ?? [])
  const scenes = changes(base.motionScenes ?? [], project.motionScenes ?? [])
  const times = [
    ...scenes.map(
      ({ previous, current }) =>
        Math.min(
          previous?.startFrame ?? Infinity,
          current?.startFrame ?? Infinity,
        ) / MOTION_FPS,
    ),
    ...clips.map(({ previous, current }) =>
      Math.min(
        previous?.timelineStart ?? Infinity,
        current?.timelineStart ?? Infinity,
      ),
    ),
    ...[...subtitles, ...annotations].map(({ previous, current }) =>
      Math.min(previous?.start ?? Infinity, current?.start ?? Infinity),
    ),
  ]
  const ids = (
    items: Array<{ previous?: { id: string }; current?: { id: string } }>,
  ) =>
    items.flatMap(({ previous, current }) =>
      current ? [current.id] : previous ? [previous.id] : [],
    )
  return {
    project,
    selected,
    retimeSubtitles: mergeRanges(retimeSubtitles),
    change: {
      clipIds: ids(clips),
      ...(scenes.length ? { motionSceneIds: ids(scenes) } : {}),
      subtitleIds: ids(subtitles),
      trackIds: [
        ...new Set([
          ...ids(tracks),
          ...clips.flatMap(({ previous, current }) =>
            [previous?.trackId, current?.trackId].filter(
              (value) => value !== undefined,
            ),
          ),
        ]),
      ],
      time: times.length ? Math.min(...times) : 0,
    },
    duration: timelineLayout(project).totalDuration,
    previousDuration: timelineLayout(base).totalDuration,
  }
}
