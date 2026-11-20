export type {
  TimelineChip,
  TimelineSnapshot,
  TimelineReferenceTarget,
} from './timeline-reference'
export type * from './types'
export {
  clipContainsAnchor,
  motionFrameAt,
  motionTimelineFrame,
} from './motion-time'
import { MOTION_FPS } from './motion-constants'
export { MOTION_FPS }
import type { SubtitleCue, VideoClip, VideoProject, VideoTrack } from './types'

export const MIN_CLIP_SECONDS = 0.1
export function minSplitTimelineOffset(speed: number): number {
  return MIN_CLIP_SECONDS / speed
}

const EPSILON = 1e-6

export function clipTimelineDuration(clip: VideoClip): number {
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

export interface TimelineClipLayout {
  clipId: string
  /** Index in the project's flat clips array. */
  index: number
  trackId: string
  start: number
  end: number
  duration: number
}

export interface TimelineTrackLayout {
  track: VideoTrack
  clips: TimelineClipLayout[]
}

export interface TimelineLayout {
  tracks: TimelineTrackLayout[]
  /** All clips, ordered bottom track first and by start time. */
  clips: TimelineClipLayout[]
  subtitles: SubtitleCue[]
  totalDuration: number
}

function sortedTracks(tracks: VideoTrack[]): VideoTrack[] {
  return [...tracks].sort((a, b) => a.index - b.index)
}

export function timelineLayout(
  project: Pick<
    VideoProject,
    'tracks' | 'clips' | 'subtitles' | 'annotations' | 'motionScenes'
  >,
): TimelineLayout {
  const tracks = sortedTracks(project.tracks)
  const layouts = new Map<string, TimelineClipLayout[]>()
  for (const track of tracks) layouts.set(track.id, [])
  project.clips.forEach((clip, index) => {
    const duration = clipTimelineDuration(clip)
    const layout: TimelineClipLayout = {
      clipId: clip.id,
      index,
      trackId: clip.trackId,
      start: clip.timelineStart,
      end: clip.timelineStart + duration,
      duration,
    }
    layouts.get(clip.trackId)?.push(layout)
  })
  const trackLayouts = tracks.map((track) => ({
    track,
    clips: (layouts.get(track.id) ?? []).sort((a, b) => a.start - b.start),
  }))
  const clips = trackLayouts.flatMap((item) => item.clips)
  const subtitles = [...project.subtitles].sort((a, b) => a.start - b.start)
  let totalDuration = 0
  for (const item of clips) totalDuration = Math.max(totalDuration, item.end)
  for (const a of project.annotations ?? [])
    totalDuration = Math.max(totalDuration, a.end)
  for (const scene of project.motionScenes ?? [])
    if (scene.anchor?.status !== 'lost')
      totalDuration = Math.max(
        totalDuration,
        (scene.startFrame + scene.durationFrames) / MOTION_FPS,
      )
  for (const cue of subtitles) totalDuration = Math.max(totalDuration, cue.end)
  return { tracks: trackLayouts, clips, subtitles, totalDuration }
}

export function findClipLayout(
  project: Pick<
    VideoProject,
    'tracks' | 'clips' | 'subtitles' | 'annotations' | 'motionScenes'
  >,
  clipId: string,
): TimelineClipLayout | null {
  return (
    timelineLayout(project).clips.find((item) => item.clipId === clipId) ?? null
  )
}

export interface TimelineClipHit {
  clip: VideoClip
  /** Index in the project's flat clips array. */
  index: number
  track: VideoTrack
  start: number
  end: number
  localTime: number
}

/** Every clip covering `time`, bottom track first (higher tracks paint later). */
export function timelineClipsAt(
  project: Pick<
    VideoProject,
    'tracks' | 'clips' | 'subtitles' | 'annotations' | 'motionScenes'
  >,
  time: number,
): TimelineClipHit[] {
  const layout = timelineLayout(project)
  const hits: TimelineClipHit[] = []
  for (const item of layout.tracks) {
    for (const entry of item.clips) {
      if (time + EPSILON < entry.start || time >= entry.end - EPSILON) continue
      const index = project.clips.findIndex((clip) => clip.id === entry.clipId)
      if (index < 0) continue
      hits.push({
        clip: project.clips[index]!,
        index,
        track: item.track,
        start: entry.start,
        end: entry.end,
        localTime: Math.max(0, Math.min(entry.duration, time - entry.start)),
      })
    }
  }
  return hits
}

/** The top-most clip at `time`, or a specific clip when `clipId` is given. */
export function timelineClipAt(
  project: Pick<
    VideoProject,
    'tracks' | 'clips' | 'subtitles' | 'annotations' | 'motionScenes'
  >,
  time: number,
  clipId?: string,
): TimelineClipHit | null {
  if (clipId !== undefined) {
    const layout = timelineLayout(project)
    const entry = layout.clips.find((item) => item.clipId === clipId)
    if (!entry) return null
    const index = project.clips.findIndex((clip) => clip.id === clipId)
    const track = project.tracks.find((item) => item.id === entry.trackId)
    if (index < 0 || !track) return null
    return {
      clip: project.clips[index]!,
      index,
      track,
      start: entry.start,
      end: entry.end,
      localTime: Math.max(0, Math.min(entry.duration, time - entry.start)),
    }
  }
  const hits = timelineClipsAt(project, time)
  return (
    hits.filter((hit) => hit.track.kind === 'video').at(-1) ??
    hits.at(-1) ??
    null
  )
}

export function subtitleCueAt(
  project: Pick<VideoProject, 'subtitles'>,
  time: number,
): SubtitleCue | null {
  const cue = project.subtitles.find(
    (item) => time + EPSILON >= item.start && time < item.end - EPSILON,
  )
  return cue ?? null
}

export * from './analysis/captions'

/** A target remains centered unless that would expose space outside the canvas. */
export function zoomViewport(target: {
  x: number
  y: number
  width: number
  height: number
}) {
  const size = Math.max(target.width, target.height)
  return {
    size,
    x: Math.min(1 - size, Math.max(0, target.x + (target.width - size) / 2)),
    y: Math.min(1 - size, Math.max(0, target.y + (target.height - size) / 2)),
  }
}
// The initial exported stroke color is project data, independent of editor theme.
export const defaultAnnotationColor = '#ffcb46'

export * from './caption-layout'
