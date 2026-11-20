import type { VideoAsset, VideoClip } from '@emperor/core/editing'

export function formatTimecode(value: number): string {
  const cents = Math.round(
    Math.max(0, Number.isFinite(value) ? value : 0) * 100,
  )
  const hours = Math.floor(cents / 360_000)
  const minutes = Math.floor((cents % 360_000) / 6_000)
  const seconds = Math.floor((cents % 6_000) / 100)
  const hundredths = cents % 100
  const prefix = hours ? `${String(hours).padStart(2, '0')}:` : ''
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

export function sourceTimeAt(clip: VideoClip, localTime: number): number {
  return Math.max(
    clip.sourceIn,
    Math.min(clip.sourceOut, clip.sourceIn + localTime * clip.speed),
  )
}

export function clampTrimDrag(
  asset: VideoAsset,
  clip: VideoClip,
  edge: 'left' | 'right',
  deltaX: number,
  pixelsPerSecond: number,
): { sourceIn: number; sourceOut: number } {
  const sourceDelta = (deltaX / pixelsPerSecond) * clip.speed
  if (edge === 'left') {
    return {
      sourceIn: Math.max(
        0,
        Math.min(clip.sourceOut - 0.1, clip.sourceIn + sourceDelta),
      ),
      sourceOut: clip.sourceOut,
    }
  }
  return {
    sourceIn: clip.sourceIn,
    sourceOut: Math.max(
      clip.sourceIn + 0.1,
      Math.min(asset.duration ?? 86_400, clip.sourceOut + sourceDelta),
    ),
  }
}

export function pointerTimelineTime(input: {
  clientX: number
  left: number
  scrollLeft: number
  pixelsPerSecond: number
  total: number
}): number {
  const value =
    (input.clientX - input.left + input.scrollLeft) / input.pixelsPerSecond
  return Math.max(0, Math.min(input.total, value))
}

/** An invisible pointer target may use half of either adjacent gap, never a neighbour's time. */
export function timelineHitInsets(
  items: { id: string; start: number; end: number }[],
  scale: number,
) {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  return new Map(
    sorted.map((item, i) => {
      const missing = Math.max(0, 24 - (item.end - item.start) * scale)
      const leftRoom = i
        ? Math.max(0, ((item.start - sorted[i - 1]!.end) * scale) / 2)
        : item.start * scale
      const rightRoom = sorted[i + 1]
        ? Math.max(0, ((sorted[i + 1]!.start - item.end) * scale) / 2)
        : Infinity
      const right = Math.min(
        rightRoom,
        missing - Math.min(leftRoom, missing / 2),
      )
      const left = Math.min(leftRoom, missing - right)
      return [
        item.id,
        { '--hit-left': -left + 'px', '--hit-right': -right + 'px' },
      ] as const
    }),
  )
}
