import { MOTION_FPS } from './motion-constants'
import type { MotionScene } from './motion-schema'
import type { VideoClip } from './types'

const EPS = 1e-8
export function localMotionPosition(
  scene: MotionScene,
  projectFrame: number,
): number {
  return (
    scene.sourceInFrame +
    (scene.playback?.phase ?? 0) +
    (projectFrame - scene.startFrame) * (scene.playback?.rate ?? 1)
  )
}

/** Half-open project interval. Playback, scrubbing and export sample the same local frame. */
export function motionFrameAt(
  scene: MotionScene,
  projectTimeSeconds: number,
): number | null {
  if (
    !Number.isFinite(projectTimeSeconds) ||
    projectTimeSeconds < 0 ||
    scene.anchor?.status === 'lost'
  )
    return null
  const frame = Math.floor(projectTimeSeconds * MOTION_FPS + EPS)
  if (
    frame < scene.startFrame ||
    frame >= scene.startFrame + scene.durationFrames
  )
    return null
  return Math.floor(localMotionPosition(scene, frame) + EPS)
}

/** Project frame at which the playhead first reaches a marker, including skipped frames at high speeds. */
export function motionTimelineFrame(
  scene: MotionScene,
  localFrame: number,
): number | null {
  const start = scene.sourceInFrame + (scene.playback?.phase ?? 0)
  if (
    !Number.isFinite(localFrame) ||
    scene.anchor?.status === 'lost' ||
    localFrame < Math.floor(start + EPS)
  )
    return null
  const offset = Math.max(
    0,
    Math.ceil((localFrame - start) / (scene.playback?.rate ?? 1) - EPS),
  )
  return offset < scene.durationFrames ? scene.startFrame + offset : null
}

export function anchorSourceAt(clip: VideoClip, frame: number): number {
  return clip.sourceIn + (frame / MOTION_FPS - clip.timelineStart) * clip.speed
}

export function clipContainsAnchor(clip: VideoClip, source: number): boolean {
  return source >= clip.sourceIn - EPS && source < clip.sourceOut - EPS
}

/** A kept piece may reset its source clock to zero (image holds). */
export interface MotionClipFragment {
  clip: VideoClip
  oldSourceIn: number
}
export type MotionLineage = Map<string, MotionClipFragment[]>

/** An author may resize a scene while reusing its playback clock. Keep the subframe tail only for its matching interval. */
function localEnd(scene: MotionScene): number {
  const start = localMotionPosition(scene, scene.startFrame)
  const rate = scene.playback?.rate ?? 1
  const saved = scene.playback?.endFrame
  if (
    saved !== undefined &&
    Math.ceil((saved - start) / rate - EPS) === scene.durationFrames
  )
    return saved
  return start + scene.durationFrames * rate
}

/** Keep the anchor on the same clip instance, or on a known descendant of that instance. */
export function reconcileMotionAnchor(
  scene: MotionScene,
  oldClip: VideoClip,
  pieces: MotionClipFragment[],
): MotionScene {
  const anchor = scene.anchor!
  if (anchor.status === 'lost') return scene
  const fragment = pieces.find(
    ({ clip, oldSourceIn }) =>
      anchor.sourceTime >= oldSourceIn - EPS &&
      anchor.sourceTime < oldSourceIn + clip.sourceOut - clip.sourceIn - EPS,
  )
  if (!fragment) return { ...scene, anchor: { ...anchor, status: 'lost' } }
  const next = fragment.clip
  const sourceTime = Math.max(
    next.sourceIn,
    next.sourceIn + (anchor.sourceTime - fragment.oldSourceIn),
  )
  const offset =
    anchor.offsetSource ??
    anchorSourceAt(oldClip, scene.startFrame) - anchor.sourceTime
  const previousRate = scene.playback?.rate ?? 1
  const rate = (previousRate * next.speed) / oldClip.speed
  const localStart = scene.sourceInFrame + (scene.playback?.phase ?? 0)
  const endFrame = localEnd(scene)
  const startFrame = Math.max(
    0,
    Math.round(
      (next.timelineStart +
        (sourceTime + offset - next.sourceIn) / next.speed) *
        MOTION_FPS,
    ),
  )
  const durationFrames = Math.max(
    1,
    Math.ceil((endFrame - localStart) / rate - EPS),
  )
  return {
    ...scene,
    startFrame,
    durationFrames,
    ...(rate !== previousRate
      ? { playback: { ...scene.playback, rate, endFrame } }
      : {}),
    anchor: {
      ...anchor,
      clipId: next.id,
      sourceTime,
      ...(Math.abs(offset) > EPS ? { offsetSource: offset } : {}),
    },
  }
}

/** Set the in-point of a retained interval, preserving its exact source phase. */
export function sliceMotionScene(
  scene: MotionScene,
  start: number,
  end: number,
  clip?: VideoClip,
): MotionScene {
  const position = localMotionPosition(scene, start)
  const sourceInFrame = Math.floor(position + EPS)
  const next = {
    ...scene,
    startFrame: start,
    durationFrames: end - start,
    sourceInFrame,
  }
  if (scene.playback) {
    next.playback = {
      ...scene.playback,
      phase: Math.max(0, position - sourceInFrame),
      endFrame:
        end === scene.startFrame + scene.durationFrames
          ? localEnd(scene)
          : localMotionPosition(scene, end),
    }
  }
  if (
    scene.anchor &&
    clip &&
    start !== scene.startFrame &&
    !scene.anchor.status
  ) {
    next.anchor = { ...scene.anchor }
    const source = anchorSourceAt(clip, start)
    if (clipContainsAnchor(clip, source)) {
      next.anchor.sourceTime = Math.max(clip.sourceIn, source)
      delete next.anchor.offsetSource
    } else next.anchor.offsetSource = source - next.anchor.sourceTime
  }
  return next
}
