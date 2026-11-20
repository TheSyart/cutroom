import { describe, expect, it } from 'vitest'
import {
  applyVideoProjectCommand,
  clipTimelineDuration,
  subtitleCueAt,
  timelineClipAt,
  timelineClipsAt,
  timelineLayout,
  type SubtitleCue,
  type VideoAsset,
  type VideoClip,
  type VideoProject,
  type VideoTrack,
} from './index'

const video: VideoAsset = {
  id: 'asset-video',
  kind: 'video',
  path: 'assets/source.mp4',
  displayName: 'source.mp4',
  duration: 12,
  width: 1920,
  height: 1080,
}
const image: VideoAsset = {
  id: 'asset-image',
  kind: 'image',
  path: 'assets/still.png',
  displayName: 'still.png',
  duration: null,
  width: 1200,
  height: 800,
}
const main: VideoTrack = {
  id: 'main',
  kind: 'video',
  name: '主画面',
  index: 0,
}
const overlay: VideoTrack = {
  id: 'track-1',
  kind: 'video',
  name: '叠加 1',
  index: 1,
}
const clip: VideoClip = {
  id: 'clip-a',
  trackId: 'main',
  assetId: video.id,
  timelineStart: 0,
  sourceIn: 1,
  sourceOut: 9,
  speed: 2,
  volume: 0.8,
  muted: false,
  transform: { scale: 1, x: 0, y: 0 },
}

function project(
  clips: VideoClip[] = [clip],
  tracks: VideoTrack[] = [main],
  subtitles: SubtitleCue[] = [],
): VideoProject {
  return {
    schemaVersion: 2,
    projectId: 'project-1',
    name: 'Demo',
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [video, image],
    tracks,
    clips,
    subtitles,
    canvas: { fit: 'contain', background: '#000000' },
  }
}

function ids(prefix = 'generated') {
  let n = 0
  return () => `${prefix}-${++n}`
}

describe('video project commands', () => {
  it('adds a full-length video and a three-second image to the main track', () => {
    const create = ids()
    const withVideo = applyVideoProjectCommand(
      project([]),
      { type: 'addClip', assetId: video.id },
      create,
    )
    expect(withVideo.project.clips[0]).toMatchObject({
      id: 'generated-1',
      trackId: 'main',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 12,
      speed: 1,
    })
    const withImage = applyVideoProjectCommand(
      withVideo.project,
      { type: 'addClip', assetId: image.id },
      create,
    )
    expect(withImage.project.clips[1]).toMatchObject({
      id: 'generated-2',
      trackId: 'main',
      timelineStart: 12,
      sourceIn: 0,
      sourceOut: 3,
      speed: 1,
      volume: 1,
    })
    expect(withImage.selectedClipId).toBe('generated-2')
  })

  it('adds a clip at an explicit track and time and rejects overlaps', () => {
    const created = applyVideoProjectCommand(
      project([clip], [main, overlay]),
      {
        type: 'addClip',
        assetId: image.id,
        trackId: 'track-1',
        timelineStart: 2,
      },
      ids(),
    )
    const added = created.project.clips[1]!
    expect(added).toMatchObject({ trackId: 'track-1', timelineStart: 2 })
    expect(() =>
      applyVideoProjectCommand(created.project, {
        type: 'addClip',
        assetId: image.id,
        trackId: 'track-1',
        timelineStart: 3,
      }),
    ).toThrow(/不能重叠/)
  })

  it('requires video metadata before adding a clip', () => {
    const draft = project([])
    draft.assets[0] = { ...video, duration: null }
    expect(() =>
      applyVideoProjectCommand(draft, { type: 'addClip', assetId: video.id }),
    ).toThrow(/时长/)
  })

  it('trims the right edge in place and the left edge with a fixed end', () => {
    const right = applyVideoProjectCommand(project(), {
      type: 'trimClip',
      clipId: clip.id,
      sourceOut: 8,
      edge: 'right',
    })
    expect(right.project.clips[0]).toMatchObject({
      sourceIn: 1,
      sourceOut: 8,
      timelineStart: 0,
    })
    const left = applyVideoProjectCommand(project(), {
      type: 'trimClip',
      clipId: clip.id,
      sourceIn: 2,
      sourceOut: 9,
      edge: 'left',
    })
    expect(left.project.clips[0]).toMatchObject({
      sourceIn: 2,
      timelineStart: 0.5,
    })
    expect(
      left.project.clips[0]!.timelineStart +
        clipTimelineDuration(left.project.clips[0]!),
    ).toBe(4)
    expect(() =>
      applyVideoProjectCommand(project(), {
        type: 'trimClip',
        clipId: clip.id,
        sourceIn: 8.95,
        sourceOut: 9,
      }),
    ).toThrow(/0.1/)
    expect(() =>
      applyVideoProjectCommand(project(), {
        type: 'trimClip',
        clipId: clip.id,
        sourceOut: 13,
      }),
    ).toThrow(/素材/)
  })

  it('does not trim a clip over its same-track neighbour', () => {
    const neighbour: VideoClip = {
      ...clip,
      id: 'clip-b',
      timelineStart: 4,
      sourceIn: 0,
      sourceOut: 2,
      speed: 1,
    }
    expect(() =>
      applyVideoProjectCommand(project([clip, neighbour]), {
        type: 'trimClip',
        clipId: clip.id,
        sourceOut: 10,
        edge: 'right',
      }),
    ).toThrow(/不能重叠/)
  })

  it('moves a clip across tracks without changing source ranges', () => {
    const moved = applyVideoProjectCommand(project([clip], [main, overlay]), {
      type: 'moveClip',
      clipId: clip.id,
      trackId: 'track-1',
      timelineStart: 2,
    })
    expect(moved.project.clips[0]).toMatchObject({
      trackId: 'track-1',
      timelineStart: 2,
      sourceIn: 1,
      sourceOut: 9,
    })
    expect(() =>
      applyVideoProjectCommand(project([clip], [main, overlay]), {
        type: 'moveClip',
        clipId: clip.id,
        trackId: 'track-1',
        timelineStart: -1,
      }),
    ).toThrow()
  })

  it('splits at timeline time and gives the right half a new start', () => {
    const result = applyVideoProjectCommand(
      project(),
      { type: 'splitClip', clipId: clip.id, timelineOffset: 2 },
      ids('split'),
    )
    expect(result.project.clips).toHaveLength(2)
    expect(result.project.clips[0]).toMatchObject({ sourceIn: 1, sourceOut: 5 })
    expect(result.project.clips[1]).toMatchObject({
      timelineStart: 2,
      sourceIn: 5,
      sourceOut: 9,
      speed: 2,
      volume: 0.8,
    })
    expect(result.selectedClipId).toBe('split-1')
  })

  it('rejects a split outside the clip or too close to an edge', () => {
    for (const timelineOffset of [0, 4, 0.01]) {
      expect(() =>
        applyVideoProjectCommand(project(), {
          type: 'splitClip',
          clipId: clip.id,
          timelineOffset,
        }),
      ).toThrow()
    }
  })

  it('ripple-deletes only the clip’s own track', () => {
    const second: VideoClip = {
      ...clip,
      id: 'clip-b',
      timelineStart: 4,
      sourceIn: 0,
      sourceOut: 2,
      speed: 1,
    }
    const third: VideoClip = {
      ...second,
      id: 'clip-c',
      timelineStart: 6,
    }
    const other: VideoClip = {
      ...second,
      id: 'clip-other',
      trackId: 'track-1',
      timelineStart: 4,
    }
    const result = applyVideoProjectCommand(
      project([clip, second, third, other], [main, overlay]),
      { type: 'deleteClip', clipId: second.id },
    )
    expect(result.project.clips.map((item) => item.id)).toEqual([
      'clip-a',
      'clip-c',
      'clip-other',
    ])
    expect(
      result.project.clips.find((item) => item.id === 'clip-c')?.timelineStart,
    ).toBe(4)
    expect(
      result.project.clips.find((item) => item.id === 'clip-other')
        ?.timelineStart,
    ).toBe(4)
    expect(result.selectedClipId).toBe('clip-c')
    expect(timelineLayout(result.project).totalDuration).toBe(6)
  })

  it('ripples a timeline range across video, image and independent audio tracks', () => {
    const audio = {
      ...video,
      id: 'audio',
      kind: 'audio' as const,
      width: null,
      height: null,
    }
    const audioTrack: VideoTrack = {
      id: 'sound',
      name: '声音',
      index: 2,
      kind: 'audio',
    }
    const faded = { ...clip, fadeIn: 0.2, fadeOut: 0.3 }
    const still: VideoClip = {
      ...faded,
      id: 'still',
      trackId: overlay.id,
      assetId: image.id,
      timelineStart: 2,
      sourceIn: 0,
      sourceOut: 2.5,
      speed: 1,
    }
    const original = project(
      [
        faded,
        { ...faded, id: 'tail', timelineStart: 4 },
        { ...still, id: 'lead', timelineStart: 0, sourceOut: 1 },
        { ...still, id: 'inside', timelineStart: 1.25, sourceOut: 0.5 },
        still,
        {
          ...faded,
          id: 'narration',
          trackId: audioTrack.id,
          assetId: audio.id,
          timelineStart: 0.5,
          sourceIn: 2,
          sourceOut: 3,
          speed: 0.5,
        },
      ],
      [main, overlay, audioTrack],
    )
    original.assets.push(audio)
    const before = structuredClone(original)

    const result = applyVideoProjectCommand(
      original,
      { type: 'rippleDeleteRange', start: 1, end: 3 },
      ids('split'),
    )

    expect(result.project.clips).toEqual([
      { ...clip, fadeIn: 0.2, sourceOut: 3 },
      { ...clip, id: 'split-1', fadeOut: 0.3, timelineStart: 1, sourceIn: 7 },
      { ...faded, id: 'tail', timelineStart: 2 },
      { ...still, id: 'lead', timelineStart: 0, sourceOut: 1 },
      {
        ...clip,
        id: still.id,
        trackId: overlay.id,
        assetId: image.id,
        timelineStart: 1,
        sourceIn: 0,
        sourceOut: 1.5,
        speed: 1,
        fadeOut: 0.3,
      },
      {
        ...clip,
        id: 'narration',
        trackId: audioTrack.id,
        assetId: audio.id,
        timelineStart: 0.5,
        sourceIn: 2,
        sourceOut: 2.25,
        speed: 0.5,
        fadeIn: 0.2,
      },
    ])
    expect(timelineLayout(result.project).totalDuration).toBe(6)
    expect(original).toEqual(before)
  })

  it('preserves cues at the cut bounds and identifies intersecting cues for regeneration', () => {
    const original = project(
      [{ ...clip, sourceOut: 11 }],
      [main],
      [
        { id: 'before', start: 0.25, end: 0.5, text: '保留前' },
        { id: 'left', start: 0.5, end: 1.5, text: '部分删除' },
        { id: 'inside', start: 1.5, end: 2, text: '全部删除' },
        { id: 'right', start: 2.5, end: 3.5, text: '部分删除' },
        { id: 'after', start: 3.5, end: 4, text: '保留后' },
      ],
    )

    const result = applyVideoProjectCommand(original, {
      type: 'rippleDeleteRange',
      start: 1,
      end: 3,
    })

    expect(result.project.subtitles).toEqual([
      { id: 'before', start: 0.25, end: 0.5, text: '保留前' },
      { id: 'after', start: 1.5, end: 2, text: '保留后' },
    ])
    expect(result.removedSubtitleIds).toEqual(['left', 'inside', 'right'])
    expect(result.retimeSubtitles).toEqual([
      { start: 0.5, end: 1 },
      { start: 1, end: 1.5 },
    ])

    const touching = project(
      [clip],
      [main],
      [
        { id: 'ends-at-cut', start: 0.5, end: 1, text: '保留' },
        { id: 'starts-at-cut-end', start: 3, end: 3.5, text: '也保留' },
      ],
    )
    const boundary = applyVideoProjectCommand(touching, {
      type: 'rippleDeleteRange',
      start: 1,
      end: 3,
    })
    expect(boundary.project.subtitles).toEqual([
      { id: 'ends-at-cut', start: 0.5, end: 1, text: '保留' },
      { id: 'starts-at-cut-end', start: 1, end: 1.5, text: '也保留' },
    ])
    expect(boundary.removedSubtitleIds).toEqual([])
  })

  it('retimes the surviving portions of annotations through the seam', () => {
    const original = project()
    const box = {
      kind: 'box' as const,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      color: '#ffcc00',
    }
    original.annotations = [
      { ...box, id: 'spans', start: 0.25, end: 3.75 },
      { ...box, id: 'left', start: 0.5, end: 1.5 },
      { ...box, id: 'inside', start: 1, end: 3 },
      { ...box, id: 'right', start: 2.5, end: 3.5 },
      { ...box, id: 'after', start: 3.5, end: 4 },
    ]
    const result = applyVideoProjectCommand(original, {
      type: 'rippleDeleteRange',
      start: 1,
      end: 3,
    })
    expect(result.project.annotations).toEqual([
      { ...box, id: 'spans', start: 0.25, end: 1.75 },
      { ...box, id: 'left', start: 0.5, end: 1 },
      { ...box, id: 'right', start: 1, end: 1.5 },
      { ...box, id: 'after', start: 1.5, end: 2 },
    ])
  })

  it.each([
    [-1, 2],
    [2, 2],
    [2, 1],
    [2, 5],
    [Number.NaN, 2],
    [2, Number.POSITIVE_INFINITY],
  ])(
    'rejects a malformed ripple range %s–%s without mutating the project',
    (start, end) => {
      const original = project()
      const before = structuredClone(original)
      expect(() =>
        applyVideoProjectCommand(original, {
          type: 'rippleDeleteRange',
          start,
          end,
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_edit' }))
      expect(original).toEqual(before)
    },
  )

  it('rejects a ripple range that leaves less than 0.1 seconds of source in any fragment', () => {
    const original = project(
      [clip, { ...clip, id: 'slow', trackId: overlay.id, speed: 0.25 }],
      [main, overlay],
    )
    const before = structuredClone(original)
    expect(() =>
      applyVideoProjectCommand(original, {
        type: 'rippleDeleteRange',
        start: 0.25,
        end: 3,
      }),
    ).toThrow(/0.1/)
    expect(original).toEqual(before)
  })

  it('closes a timeline gap even when the cut contains no clips', () => {
    const original = project([
      clip,
      { ...clip, id: 'after-gap', timelineStart: 6 },
    ])

    const result = applyVideoProjectCommand(original, {
      type: 'rippleDeleteRange',
      start: 4,
      end: 6,
    })

    expect(result.project.clips).toEqual([
      clip,
      { ...clip, id: 'after-gap', timelineStart: 4 },
    ])
  })

  it('adds an overlay track and refuses to remove a non-empty or main track', () => {
    const added = applyVideoProjectCommand(
      project(),
      { type: 'addTrack' },
      ids('track'),
    )
    expect(added.project.tracks.map((track) => track.index)).toEqual([0, 1])
    expect(added.project.tracks[1]?.name).toBe('叠加 1')
    const withClip = applyVideoProjectCommand(added.project, {
      type: 'addClip',
      assetId: image.id,
      trackId: 'track-1',
      timelineStart: 0,
    })
    expect(() =>
      applyVideoProjectCommand(withClip.project, {
        type: 'removeTrack',
        trackId: 'track-1',
      }),
    ).toThrow(/片段/)
    expect(() =>
      applyVideoProjectCommand(project(), {
        type: 'removeTrack',
        trackId: 'main',
      }),
    ).toThrow(/主画面/)
    const empty = { ...added.project, clips: [] }
    const removed = applyVideoProjectCommand(empty, {
      type: 'removeTrack',
      trackId: 'track-1',
    })
    expect(removed.project.tracks).toHaveLength(1)
  })

  it('adds, updates, replaces and deletes subtitles in time order', () => {
    const create = ids('sub')
    const added = applyVideoProjectCommand(
      project([], [main], []),
      { type: 'addSubtitle', start: 3, end: 5, text: '第二句' },
      create,
    )
    expect(added.project.subtitles).toHaveLength(1)
    expect(added.selectedSubtitleId).toBe('sub-1')
    const earlier = applyVideoProjectCommand(
      added.project,
      { type: 'addSubtitle', start: 1, end: 2, text: '第一句' },
      create,
    )
    expect(earlier.project.subtitles.map((cue) => cue.text)).toEqual([
      '第一句',
      '第二句',
    ])
    expect(() =>
      applyVideoProjectCommand(earlier.project, {
        type: 'addSubtitle',
        start: 1.5,
        end: 2.5,
        text: '重叠',
      }),
    ).toThrow(/重叠/)
    const updated = applyVideoProjectCommand(earlier.project, {
      type: 'updateSubtitle',
      subtitleId: 'sub-1',
      text: '改过的第二句',
      start: 4,
      end: 6,
    })
    expect(updated.project.subtitles[1]).toMatchObject({
      text: '改过的第二句',
      start: 4,
      end: 6,
    })
    const replaced = applyVideoProjectCommand(
      updated.project,
      {
        type: 'replaceSubtitles',
        cues: [
          { start: 0, end: 1, text: 'A' },
          { start: 2, end: 3, text: 'B' },
        ],
      },
      create,
    )
    expect(replaced.project.subtitles.map((cue) => cue.text)).toEqual([
      'A',
      'B',
    ])
    const deleted = applyVideoProjectCommand(replaced.project, {
      type: 'deleteSubtitle',
      subtitleId: replaced.project.subtitles[0]!.id,
    })
    expect(deleted.project.subtitles).toHaveLength(1)
  })

  it('updates speed, audio, and transform with bounded values', () => {
    const result = applyVideoProjectCommand(project(), {
      type: 'updateClip',
      clipId: clip.id,
      speed: 1,
      volume: 0.25,
      muted: true,
      transform: { scale: 1.4, x: 12, y: -8 },
    })
    expect(result.project.clips[0]).toMatchObject({
      speed: 1,
      volume: 0.25,
      muted: true,
      transform: { scale: 1.4, x: 12, y: -8 },
    })
    expect(clipTimelineDuration(result.project.clips[0]!)).toBe(8)
  })

  it('does not give an image speed controls', () => {
    const imageClip: VideoClip = {
      ...clip,
      id: 'image-clip',
      trackId: 'main',
      assetId: image.id,
      sourceIn: 0,
      sourceOut: 3,
      speed: 1,
    }
    expect(() =>
      applyVideoProjectCommand(project([imageClip]), {
        type: 'updateClip',
        clipId: imageClip.id,
        speed: 2,
      }),
    ).toThrow(/图片/)
  })

  it('updates the canvas fit and background', () => {
    const result = applyVideoProjectCommand(project(), {
      type: 'updateCanvas',
      fit: 'cover',
      background: '#112233',
    })
    expect(result.project.canvas).toEqual({
      fit: 'cover',
      background: '#112233',
    })
  })

  it('lays out tracks bottom-up, returns active clips and subtitle cues', () => {
    const second: VideoClip = {
      ...clip,
      id: 'clip-b',
      timelineStart: 4,
      sourceIn: 0,
      sourceOut: 2,
      speed: 1,
    }
    const top: VideoClip = {
      ...clip,
      id: 'clip-top',
      trackId: 'track-1',
      timelineStart: 1,
      sourceIn: 0,
      sourceOut: 2,
      speed: 1,
    }
    const cues: SubtitleCue[] = [
      { id: 'cue-1', start: 1, end: 2, text: '你好' },
    ]
    const layout = timelineLayout(
      project([clip, second, top], [main, overlay], cues),
    )
    expect(layout.tracks.map((item) => item.track.id)).toEqual([
      'main',
      'track-1',
    ])
    expect(layout.clips.map((item) => item.clipId)).toEqual([
      'clip-a',
      'clip-b',
      'clip-top',
    ])
    expect(layout.totalDuration).toBe(6)
    expect(
      timelineClipsAt(
        project([clip, second, top], [main, overlay], cues),
        1.5,
      ).map((hit) => hit.clip.id),
    ).toEqual(['clip-a', 'clip-top'])
    expect(
      timelineClipAt(project([clip, second, top], [main, overlay], cues), 1.5)
        ?.clip.id,
    ).toBe('clip-top')
    expect(subtitleCueAt({ subtitles: cues }, 1.4)?.text).toBe('你好')
  })
})

describe('command candidate integrity', () => {
  it('splits stills into independent image holds', () => {
    const added = applyVideoProjectCommand(
      project([]),
      { type: 'addClip', assetId: image.id },
      ids(),
    )
    const split = applyVideoProjectCommand(
      added.project,
      {
        type: 'splitClip',
        clipId: added.selectedClipId!,
        timelineOffset: 1,
      },
      ids('right'),
    )
    expect(
      split.project.clips.map((c) => [
        c.sourceIn,
        c.sourceOut,
        c.timelineStart,
      ]),
    ).toEqual([
      [0, 1, 0],
      [0, 2, 1],
    ])
  })

  it('rejects a retime across the next clip', () => {
    expect(() =>
      applyVideoProjectCommand(
        project([clip, { ...clip, id: 'b', timelineStart: 4 }]),
        {
          type: 'updateClip',
          clipId: clip.id,
          speed: 1,
        },
      ),
    ).toThrow(/重叠/)
  })

  it('enforces the same minimum source range when splitting slowed or sped-up clips', () => {
    expect(() =>
      applyVideoProjectCommand(project([{ ...clip, speed: 0.25 }]), {
        type: 'splitClip',
        clipId: clip.id,
        timelineOffset: 0.2,
      }),
    ).toThrow(/0.1/)
    expect(
      applyVideoProjectCommand(project(), {
        type: 'splitClip',
        clipId: clip.id,
        timelineOffset: 0.05,
      }).project.clips,
    ).toHaveLength(2)
  })
})

it('places an absolute excerpt before another clip and remaps main-track cues through removed footage', () => {
  const original = project(
    [{ ...clip, timelineStart: 3 }],
    [main],
    [{ id: 'cue', text: '完整说明', start: 0.25, end: 1.75 }],
  )
  const factory = ids()
  const added = applyVideoProjectCommand(
    original,
    {
      type: 'addClip',
      assetId: video.id,
      timelineStart: 0,
      sourceIn: 7,
      sourceOut: 9,
    },
    factory,
  )
  const result = applyVideoProjectCommand(
    added.project,
    {
      type: 'replaceClipRanges',
      clipId: added.selectedClipId!,
      ranges: [
        { sourceIn: 7.5, sourceOut: 8 },
        { sourceIn: 8.5, sourceOut: 9 },
      ],
    },
    factory,
  )
  expect(result.project.clips.map((c) => [c.id, c.timelineStart])).toEqual([
    ['clip-a', 2],
    ['generated-2', 0],
    ['generated-3', 0.5],
  ])
  expect(result.project.subtitles[0]).toMatchObject({ start: 0, end: 0.75 })
  expect(original.clips).toHaveLength(1)
})

it('creates an independent sound track for a narration asset and validates emphasis bounds', () => {
  const p = project()
  p.assets.push({
    ...video,
    id: 'narration',
    kind: 'audio',
    width: null,
    height: null,
  })
  const added = applyVideoProjectCommand(
    p,
    { type: 'addClip', assetId: 'narration', sourceIn: 4, sourceOut: 5 },
    ids(),
  )
  expect(added.project.tracks[1]?.kind).toBe('audio')
  expect(added.project.clips[1]?.timelineStart).toBe(0)
  const styled = applyVideoProjectCommand(added.project, {
    type: 'updateClip',
    clipId: added.selectedClipId!,
    volume: 0.5,
    fadeIn: 0.2,
    fadeOut: 0.1,
  })
  expect(styled.project.clips[1]).toMatchObject({
    volume: 0.5,
    fadeIn: 0.2,
    fadeOut: 0.1,
  })
  expect(() =>
    applyVideoProjectCommand(p, {
      type: 'addAnnotation',
      annotation: {
        kind: 'box',
        x: 0.85,
        y: 0,
        width: 0.2,
        height: 0.2,
        start: 0,
        end: 1,
        color: '#ffcc00',
      },
    }),
  ).toThrow()
})
