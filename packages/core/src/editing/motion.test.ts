import { describe, it, expect } from 'vitest'
import { applyVideoProjectCommand, assertValidVideoProject } from './commands'
import {
  motionFrameAt,
  motionSceneSchema,
  motionTimelineFrame,
  type MotionScene,
} from './motion'
import { timelineLayout } from './timeline'
import {
  videoProjectSchema,
  type VideoClip,
  type VideoProject,
  type VideoProjectCommand,
} from './types'

const scene: MotionScene = {
  id: 'scene',
  name: '公式',
  startFrame: 30,
  durationFrames: 60,
  sourceInFrame: 10,
  version: 1,
  mode: 'overlay',
  story: '用箭头指示变化',
  objects: [
    {
      id: 'arrow',
      name: '箭头',
      html: '<i>→</i>',
      draw: 'root.style.opacity = Math.min(1, t)',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      markers: [{ frame: 25, label: '出现' }],
    },
  ],
}
const clip: VideoClip = {
  id: 'first',
  assetId: 'asset',
  trackId: 'main',
  timelineStart: 0,
  sourceIn: 2,
  sourceOut: 12,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { x: 0, y: 0, scale: 1 },
}
function project(scenes?: MotionScene[]): VideoProject {
  return {
    schemaVersion: 2,
    projectId: 'p',
    name: 'Demo',
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [
      {
        id: 'asset',
        kind: 'video',
        path: 'assets/a.mp4',
        displayName: 'a.mp4',
        duration: 20,
        width: 1920,
        height: 1080,
      },
    ],
    clips: [{ ...clip }, { ...clip, id: 'repeat', timelineStart: 14 }],
    tracks: [{ id: 'main', index: 0, name: '底片', kind: 'video' }],
    subtitles: [],
    canvas: { fit: 'contain', background: '#000000' },
    ...(scenes ? { motionScenes: scenes } : {}),
  }
}
function apply(original: VideoProject, command: VideoProjectCommand) {
  let sequence = 0
  return applyVideoProjectCommand(original, command, () => `new-${++sequence}`)
}

describe('motion schema and editing', () => {
  it('reads historical v2 without modifying it, keeps author data strict and reports duplicate ids', () => {
    const old = project()
    expect(videoProjectSchema.parse(old)).toEqual(old)
    expect(
      motionSceneSchema.safeParse({ ...scene, durationFrames: 0 }).success,
    ).toBe(false)
    expect(
      motionSceneSchema.safeParse({ ...scene, startFrame: 1.2 }).success,
    ).toBe(false)
    expect(motionSceneSchema.safeParse({ ...scene, unknown: 1 }).success).toBe(
      false,
    )
    expect(
      motionSceneSchema.safeParse({
        ...scene,
        objects: [...scene.objects, ...scene.objects],
      }).success,
    ).toBe(false)
    expect(() => assertValidVideoProject(project([scene, scene]))).toThrow(
      /重复/,
    )
    expect(() =>
      assertValidVideoProject(
        project([{ ...scene, anchor: { clipId: 'missing', sourceTime: 2 } }]),
      ),
    ).toThrow(/锚点/)
    const pending = {
      ...scene,
      anchor: { clipId: 'missing', sourceTime: 2, status: 'lost' as const },
    }
    expect(() => assertValidVideoProject(project([pending]))).not.toThrow()
  })
  it('removes one object, increments its scene version and refuses stale or last-object deletion', () => {
    const original = project([
      {
        ...scene,
        objects: [...scene.objects, { ...scene.objects[0]!, id: 'label' }],
      },
    ])
    const command = {
      type: 'deleteMotionObject' as const,
      sceneId: scene.id,
      expectedVersion: scene.version,
      objectId: 'arrow',
    }
    const edited = apply(original, command)
    expect(edited.project.motionScenes![0]).toEqual({
      ...original.motionScenes![0],
      objects: [original.motionScenes![0]!.objects[1]],
      version: 2,
    })
    expect(original.motionScenes![0]!.objects).toHaveLength(2)
    expect(() =>
      apply(edited.project, { ...command, objectId: 'label' }),
    ).toThrow(/版本/)
    expect(() =>
      apply(edited.project, {
        ...command,
        expectedVersion: 2,
        objectId: 'label',
      }),
    ).toThrow(/最后一个对象/)
    expect(() => apply(original, { ...command, objectId: 'missing' })).toThrow(
      /找不到/,
    )
  })

  it('supports independent placement, in-point trims, absolute-frame splits, stable selection and half-open playback', () => {
    const p = project()
    p.clips = []
    const put = apply(p, { type: 'upsertMotionScene', scene })
    expect(put.selectedMotionSceneId).toBe(scene.id)
    expect(p.motionScenes).toBeUndefined()
    expect(timelineLayout(put.project).totalDuration).toBe(3)
    const move = apply(put.project, {
      type: 'moveMotionScene',
      sceneId: scene.id,
      startFrame: 60,
    }).project
    const trim = apply(move, {
      type: 'trimMotionScene',
      sceneId: scene.id,
      startFrame: 70,
      sourceInFrame: 20,
      durationFrames: 50,
    }).project
    const split = apply(trim, {
      type: 'splitMotionScene',
      sceneId: scene.id,
      frame: 80,
    })
    const [left, right] = split.project.motionScenes!
    expect(split.selectedMotionSceneId).toBe(right!.id)
    expect(motionFrameAt(left!, 79 / 30)).toBe(29)
    expect(motionFrameAt(left!, 80 / 30)).toBeNull()
    expect(motionFrameAt(right!, 80 / 30)).toBe(30)
    expect(motionFrameAt(right!, 120 / 30)).toBeNull()
    expect(motionFrameAt(right!, Number.NaN)).toBeNull()
    expect(motionTimelineFrame(left!, 25)).toBe(75)
    expect(motionTimelineFrame(right!, 25)).toBeNull()
    expect(() =>
      apply(trim, { type: 'splitMotionScene', sceneId: scene.id, frame: 70 }),
    ).toThrow(/内部/)
    const removed = apply(split.project, {
      type: 'deleteMotionScene',
      sceneId: right!.id,
    })
    expect(removed.selectedMotionSceneId).toBe(null)
    expect(timelineLayout(removed.project).totalDuration).toBe(80 / 30)
  })
  it('retains non-integral source phase and original duration across repeated clip speed edits', () => {
    const p = project([
      {
        ...scene,
        durationFrames: 59,
        anchor: { clipId: clip.id, sourceTime: 3 },
      },
    ])
    p.clips = [{ ...clip, timelineStart: 0 }]
    const fast = apply(p, {
      type: 'updateClip',
      clipId: clip.id,
      speed: 1.5,
    }).project
    const sc = fast.motionScenes![0]!
    expect(sc).toMatchObject({
      startFrame: 20,
      durationFrames: 40,
      playback: { rate: 1.5 },
    })
    expect(motionFrameAt(sc, 21 / 30)).toBe(11)
    expect(motionTimelineFrame(sc, 12)).toBe(22)
    const split = apply(fast, {
      type: 'splitMotionScene',
      sceneId: scene.id,
      frame: 21,
    }).project
    const second = split.motionScenes![1]!
    expect(second.playback?.phase).toBe(0.5)
    for (let i = 21; i < 60; i++)
      expect(motionFrameAt(second, i / 30)).toBe(motionFrameAt(sc, i / 30))
    const restored = apply(fast, {
      type: 'updateClip',
      clipId: clip.id,
      speed: 1,
    }).project.motionScenes![0]!
    expect(restored).toMatchObject({ startFrame: 30, durationFrames: 59 })
  })
  it('retimes the revised authored span when an agent changes the duration of an already-retimed scene', () => {
    const p = project([
      {
        ...scene,
        durationFrames: 59,
        anchor: { clipId: 'first', sourceTime: 3 },
      },
    ])
    const fast = apply(p, {
      type: 'updateClip',
      clipId: 'first',
      speed: 1.5,
    }).project
    const revised = apply(fast, {
      type: 'upsertMotionScene',
      scene: { ...fast.motionScenes![0]!, version: 2, durationFrames: 20 },
    }).project
    const restored = apply(revised, {
      type: 'updateClip',
      clipId: 'first',
      speed: 1,
    }).project.motionScenes![0]!
    expect(restored.durationFrames).toBe(30)
  })
  it('releases and rebinds an anchor without changing the retimed clock, including its fractional trim phase', () => {
    const p = project([
      { ...scene, anchor: { clipId: 'first', sourceTime: 3 } },
    ])
    const fast = apply(p, {
      type: 'updateClip',
      clipId: 'first',
      speed: 1.5,
    }).project
    const split = apply(fast, {
      type: 'splitMotionScene',
      sceneId: 'scene',
      frame: 21,
    }).project
    const right = split.motionScenes![1]!
    const detached = apply(split, {
      type: 'setMotionAnchor',
      sceneId: right.id,
      anchor: null,
    }).project
    const free = detached.motionScenes![1]!
    expect(free.anchor).toBeUndefined()
    expect(free.playback?.phase).toBe(0.5)
    for (let i = 0; i < right.durationFrames; i++)
      expect(motionFrameAt(free, (right.startFrame + i) / 30)).toBe(
        motionFrameAt(right, (right.startFrame + i) / 30),
      )
    const bound = apply(detached, {
      type: 'setMotionAnchor',
      sceneId: free.id,
      anchor: { clipId: 'repeat', sourceTime: 3 },
    }).project.motionScenes![1]!
    expect(bound.startFrame).toBe(450)
    expect(bound.playback).toEqual(free.playback)
    expect(() =>
      apply(detached, {
        type: 'setMotionAnchor',
        sceneId: free.id,
        anchor: { clipId: 'repeat', sourceTime: 12 },
      }),
    ).toThrow(/范围/)
  })
  it('follows an exact clip occurrence across splits and moves, never a repeated material', () => {
    const p = project([
      { ...scene, startFrame: 90, anchor: { clipId: 'first', sourceTime: 5 } },
    ])
    const split = apply(p, {
      type: 'splitClip',
      clipId: 'first',
      timelineOffset: 3,
    })
    const right = split.selectedClipId!
    expect(split.project.motionScenes![0]).toMatchObject({
      startFrame: 90,
      anchor: { clipId: right, sourceTime: 5 },
    })
    const moved = apply(split.project, {
      type: 'moveClip',
      clipId: right,
      trackId: 'main',
      timelineStart: 5,
    }).project
    expect(moved.motionScenes![0]!.startFrame).toBe(150)
    const removed = apply(moved, { type: 'deleteClip', clipId: right }).project
    expect(removed.motionScenes![0]!.anchor).toMatchObject({
      clipId: right,
      status: 'lost',
    })
    expect(motionFrameAt(removed.motionScenes![0]!, 5)).toBeNull()
  })
  it('keeps an anchor on the actual retained range after batch replacement, marks trimmed-away anchors lost', () => {
    const p = project([
      { ...scene, startFrame: 120, anchor: { clipId: 'first', sourceTime: 6 } },
      { ...scene, id: 'removed', anchor: { clipId: 'first', sourceTime: 3 } },
    ])
    const r = apply(p, {
      type: 'replaceClipRanges',
      clipId: 'first',
      ranges: [
        { sourceIn: 2, sourceOut: 2.5 },
        { sourceIn: 5, sourceOut: 7 },
      ],
    }).project
    expect(r.motionScenes![0]).toMatchObject({
      startFrame: 45,
      anchor: { clipId: 'new-2', sourceTime: 6 },
    })
    expect(r.motionScenes![1]!.anchor?.status).toBe('lost')
    const trimmed = apply(r, {
      type: 'trimClip',
      clipId: 'new-2',
      sourceIn: 6.5,
    }).project
    expect(trimmed.motionScenes![0]!.anchor?.status).toBe('lost')
  })
  it('remaps image-hold anchors to the new zero-based right hold', () => {
    const p = project([
      { ...scene, startFrame: 120, anchor: { clipId: 'first', sourceTime: 4 } },
    ])
    p.assets = [{ ...p.assets[0]!, kind: 'image', duration: null }]
    p.clips = [{ ...clip, sourceIn: 0, sourceOut: 6 }]
    const split = apply(p, {
      type: 'splitClip',
      clipId: 'first',
      timelineOffset: 2,
    }).project.motionScenes![0]!
    expect(split).toMatchObject({
      startFrame: 120,
      anchor: { clipId: 'new-1', sourceTime: 2 },
    })
    const cut = apply(p, { type: 'rippleDeleteRange', start: 1, end: 3 })
      .project.motionScenes![0]!
    expect(cut).toMatchObject({
      startFrame: 60,
      anchor: { clipId: 'new-1', sourceTime: 1 },
    })
  })
  it('splices a global ripple on motion-only and linked layers without replaying the removed frames', () => {
    const anchored = {
      ...scene,
      id: 'linked',
      anchor: { clipId: 'first', sourceTime: 3 },
    }
    const p = project([
      { ...scene },
      anchored,
      { ...scene, id: 'in-cut', startFrame: 45, durationFrames: 15 },
      { ...scene, id: 'tail', startFrame: 100 },
    ])
    const cut = apply(p, {
      type: 'rippleDeleteRange',
      start: 1.5,
      end: 2,
    }).project
    expect(
      cut.motionScenes!.map((s) => [
        s.id,
        s.startFrame,
        s.durationFrames,
        s.sourceInFrame,
      ]),
    ).toEqual([
      ['scene', 30, 15, 10],
      ['new-2', 45, 30, 40],
      ['linked', 30, 15, 10],
      ['new-3', 45, 30, 40],
      ['tail', 85, 60, 10],
    ])
    expect(cut.motionScenes![3]!.anchor).toMatchObject({
      clipId: 'new-1',
      sourceTime: 4,
    })
    expect(motionFrameAt(cut.motionScenes![3]!, 1.5)).toBe(40)
    expect(p.motionScenes).toHaveLength(4)
  })
})
