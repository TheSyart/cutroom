import { describe, expect, it } from 'vitest'
import type { VideoAsset, VideoClip } from '@emperor/core/editing'
import {
  clampTrimDrag,
  formatTimecode,
  pointerTimelineTime,
  sourceTimeAt,
  timelineHitInsets,
} from './editingViewModel'

const asset: VideoAsset = {
  id: 'asset',
  kind: 'video',
  path: 'assets/a.mp4',
  displayName: 'a.mp4',
  duration: 10,
  width: 100,
  height: 100,
}
const clip: VideoClip = {
  id: 'clip',
  trackId: 'main',
  assetId: 'asset',
  timelineStart: 0,
  sourceIn: 2,
  sourceOut: 8,
  speed: 2,
  volume: 1,
  muted: false,
  transform: { scale: 1, x: 0, y: 0 },
}

describe('editing view math', () => {
  it('formats compact timecodes for the inspector and timeline', () => {
    expect(formatTimecode(0)).toBe('00:00.00')
    expect(formatTimecode(65.348)).toBe('01:05.35')
    expect(formatTimecode(3661.2)).toBe('01:01:01.20')
  })

  it('maps timeline-local time to the trimmed and sped source clock', () => {
    expect(sourceTimeAt(clip, 1.5)).toBe(5)
    expect(sourceTimeAt(clip, -1)).toBe(2)
    expect(sourceTimeAt(clip, 99)).toBe(8)
  })

  it('clamps left trim drags to source bounds and minimum duration', () => {
    expect(clampTrimDrag(asset, clip, 'left', -1000, 80)).toEqual({
      sourceIn: 0,
      sourceOut: 8,
    })
    expect(clampTrimDrag(asset, clip, 'left', 1000, 80)).toEqual({
      sourceIn: 7.9,
      sourceOut: 8,
    })
  })

  it('clamps right trim drags using zoom and playback speed', () => {
    expect(clampTrimDrag(asset, clip, 'right', 80, 80)).toEqual({
      sourceIn: 2,
      sourceOut: 10,
    })
    expect(clampTrimDrag(asset, clip, 'right', -1000, 80)).toEqual({
      sourceIn: 2,
      sourceOut: 2.1,
    })
  })

  it('maps pointer position through timeline scrolling and clamps to duration', () => {
    expect(
      pointerTimelineTime({
        clientX: 160,
        left: 20,
        scrollLeft: 400,
        pixelsPerSecond: 80,
        total: 10,
      }),
    ).toBe(6.75)
    expect(
      pointerTimelineTime({
        clientX: 900,
        left: 20,
        scrollLeft: 0,
        pixelsPerSecond: 80,
        total: 10,
      }),
    ).toBe(10)
  })
})

it('expands short pointer targets only into available gaps, keeping adjacent timing surfaces disjoint', () => {
  const insets = timelineHitInsets(
    [
      { id: 'a', start: 0, end: 0.05 },
      { id: 'b', start: 0.05, end: 0.1 },
      { id: 'c', start: 0.3, end: 0.35 },
    ],
    80,
  )
  expect(insets.get('a')).toEqual({ '--hit-left': '0px', '--hit-right': '0px' })
  expect(insets.get('b')!['--hit-left']).toBe('0px')
  expect(Number.parseFloat(insets.get('b')!['--hit-right'])).toBeCloseTo(-8)
  expect(Number.parseFloat(insets.get('c')!['--hit-left'])).toBeCloseTo(-8)
  expect(Number.parseFloat(insets.get('c')!['--hit-right'])).toBeCloseTo(-12)
})
