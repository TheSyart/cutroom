import { z } from 'zod'
import { ToolError } from '../harness/tools/definition'
import { MOTION_FPS } from './motion'
import { timelineLayout } from './timeline'
import type { VideoProject } from './types'

const id = z.string().trim().min(1).max(128)
const timelineSecond = z.number().finite().nonnegative()
const offset = z.number().int().min(0).max(5000)
const DEFAULT_LIMIT = 100

export const timelineQueryFields = {
  timelineStart: timelineSecond.optional(),
  timelineEnd: timelineSecond.optional(),
  trackIds: z.array(id).min(1).max(8).optional(),
  sourceAssetIds: z.array(id).min(1).max(2000).optional(),
  clipIds: z.array(id).min(1).max(5000).optional(),
  clipOffset: offset.optional(),
  clipLimit: z.number().int().min(1).max(200).optional(),
  subtitleOffset: offset.optional(),
  annotationOffset: offset.optional(),
  motionOffset: offset.optional(),
}

type TimelineQuery = z.infer<z.ZodObject<typeof timelineQueryFields>>

function page<T>(items: readonly T[], offset: number, limit: number) {
  const entries = items.slice(offset, offset + limit)
  const nextOffset = offset + entries.length
  return { entries, nextOffset: nextOffset < items.length ? nextOffset : null }
}

/** Clip pages follow the editor's track order, then start time within each track. */
export function queryTimeline(
  project: VideoProject,
  query: TimelineQuery = {},
) {
  const start = query.timelineStart ?? 0
  const end = query.timelineEnd ?? Infinity
  if (end <= start)
    throw new ToolError(
      '时间线结束时间必须大于开始时间。',
      'invalid_timeline_range',
    )

  const layout = timelineLayout(project)
  const overlaps = (range: { start: number; end: number }) =>
    range.start < end && range.end > start
  const trackIds = query.trackIds && new Set(query.trackIds)
  const sourceAssetIds = query.sourceAssetIds && new Set(query.sourceAssetIds)
  const clipIds = query.clipIds && new Set(query.clipIds)
  const matches = layout.clips
    .map((entry, index) => ({
      entry,
      index,
      clip: project.clips[entry.index]!,
    }))
    .filter(
      ({ entry, clip }) =>
        overlaps(entry) &&
        (!trackIds || trackIds.has(entry.trackId)) &&
        (!sourceAssetIds || sourceAssetIds.has(clip.assetId)) &&
        (!clipIds || clipIds.has(clip.id)),
    )

  const clipOffset = query.clipOffset ?? 0
  const clipLimit = query.clipLimit ?? DEFAULT_LIMIT
  const clipPage = page(matches, clipOffset, clipLimit)
  const trackNames = new Map(
    layout.tracks.map(({ track }) => [track.id, track.name]),
  )
  const assetNames = new Map(
    project.assets.map((asset) => [asset.id, asset.displayName]),
  )
  const clips = clipPage.entries.map(({ entry, index, clip }) => ({
    ...clip,
    index,
    trackName: trackNames.get(entry.trackId) ?? '轨道',
    assetName: assetNames.get(clip.assetId) ?? '素材',
    duration: entry.duration,
    timelineEnd: entry.end,
    timelineRange: { start: entry.start, end: entry.end },
    sourceRange: { start: clip.sourceIn, end: clip.sourceOut },
  }))

  const subtitleMatches = layout.subtitles.filter(overlaps)
  const subtitleOffset = query.subtitleOffset ?? 0
  const subtitlePage = page(subtitleMatches, subtitleOffset, DEFAULT_LIMIT)
  const annotations = project.annotations ?? []
  const annotationMatches = annotations
    .filter(overlaps)
    .sort((a, b) => a.start - b.start)
  const annotationOffset = query.annotationOffset ?? 0
  const annotationPage = page(
    annotationMatches,
    annotationOffset,
    DEFAULT_LIMIT,
  )

  const motion = (project.motionScenes ?? []).filter((scene) =>
    overlaps({
      start: scene.startFrame / MOTION_FPS,
      end: (scene.startFrame + scene.durationFrames) / MOTION_FPS,
    }),
  )
  const motionPage = page(motion, query.motionOffset ?? 0, DEFAULT_LIMIT)

  return {
    tracks: layout.tracks.map(({ track, clips }) => ({
      ...track,
      clipCount: clips.length,
    })),
    totalDuration: layout.totalDuration,
    clips,
    clipOffset,
    clipLimit,
    totalClips: layout.clips.length,
    matchedClips: matches.length,
    truncated: clipPage.nextOffset !== null,
    nextClipOffset: clipPage.nextOffset,
    subtitles: subtitlePage.entries,
    totalSubtitles: layout.subtitles.length,
    matchedSubtitles: subtitleMatches.length,
    subtitleOffset,
    subtitlesTruncated: subtitlePage.nextOffset !== null,
    nextSubtitleOffset: subtitlePage.nextOffset,
    motionScenes: motionPage.entries.map(({ objects, ...scene }) => ({
      ...scene,
      objectCount: objects.length,
      objectIds: objects.map((object) => object.id),
    })),
    totalMotionScenes: project.motionScenes?.length ?? 0,
    nextMotionOffset: motionPage.nextOffset,
    annotations: annotationPage.entries,
    totalAnnotations: annotations.length,
    matchedAnnotations: annotationMatches.length,
    annotationOffset,
    annotationsTruncated: annotationPage.nextOffset !== null,
    nextAnnotationOffset: annotationPage.nextOffset,
  }
}
