import {
  MOTION_FPS,
  motionTimelineFrame,
  timelineLayout,
  timelineClipsAt,
  type VideoProject,
  type MotionScene,
  type TimelineReferenceTarget,
  type TimelineSnapshot,
} from '@emperor/core/editing'
import { formatTimecode, sourceTimeAt } from './editingViewModel'

type Detail = Pick<
  TimelineSnapshot,
  | 'start'
  | 'end'
  | 'assetId'
  | 'trackId'
  | 'sourceIn'
  | 'sourceOut'
  | 'excerpt'
  | 'sceneVersion'
> & { name: string }

export function timelineTargetDetail(
  project: VideoProject,
  scenes: readonly MotionScene[],
  target: TimelineReferenceTarget,
): Detail | null {
  const layout = timelineLayout(project)
  const bounds = (items: readonly { start: number; end: number }[]) => ({
    start: items[0]?.start ?? 0,
    end: items.reduce((max, item) => Math.max(max, item.end), 0),
  })
  switch (target.kind) {
    case 'clip': {
      const item = layout.clips.find((item) => item.clipId === target.id)
      if (!item) return null
      const clip = project.clips[item.index]!
      const asset = project.assets.find((asset) => asset.id === clip.assetId)
      return {
        name: asset?.displayName ?? clip.assetId,
        start: item.start,
        end: item.end,
        trackId: clip.trackId,
        assetId: clip.assetId,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
      }
    }
    case 'subtitle': {
      const cue = project.subtitles.find((cue) => cue.id === target.id)
      return cue
        ? {
            name: '字幕',
            start: cue.start,
            end: cue.end,
            excerpt: cue.text.slice(0, 240),
          }
        : null
    }
    case 'motion': {
      const scene = scenes.find((item) => item.id === target.id)
      if (!scene || scene.anchor?.status === 'lost') return null
      const object = scene.objects.find((item) => item.id === target.objectId)
      if (target.objectId !== undefined && !object) return null
      const marker = object?.markers.find(
        (item) => item.frame === target.markerFrame,
      )
      if (target.markerFrame !== undefined && !marker) return null
      const at = marker
        ? motionTimelineFrame(scene, marker.frame)
        : scene.startFrame
      if (at === null) return null
      return {
        name: marker?.label ?? object?.name ?? scene.name,
        sceneVersion: scene.version,
        start: at / MOTION_FPS,
        end: marker
          ? at / MOTION_FPS
          : (scene.startFrame + scene.durationFrames) / MOTION_FPS,
      }
    }
    case 'track': {
      const row = layout.tracks.find((row) => row.track.id === target.id)
      return row
        ? { name: row.track.name, trackId: row.track.id, ...bounds(row.clips) }
        : null
    }
    case 'subtitle-track':
      return { name: '字幕轨道', ...bounds(layout.subtitles) }
    case 'point':
    case 'range': {
      const start = target.kind === 'point' ? target.time : target.start
      const end = target.kind === 'point' ? target.time : target.end
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        end > layout.totalDuration
      )
        return null
      const hits = timelineClipsAt(project, start)
      const hit = hits.filter((item) => item.track.kind !== 'audio').at(-1)
      return {
        name: target.kind === 'point' ? '位置' : '选区',
        start,
        end,
        ...(hit
          ? {
              assetId: hit.clip.assetId,
              sourceIn: sourceTimeAt(hit.clip, hit.localTime),
            }
          : {}),
      }
    }
  }
}

export function timelineLabel(
  title: string,
  start: number,
  end: number,
): string {
  const time = formatTimecode(start)
  const range = start === end ? time : time + '–' + formatTimecode(end)
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 32)
  return name + ' · ' + range
}
