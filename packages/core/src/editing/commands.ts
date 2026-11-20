import { randomUUID } from 'node:crypto'
import { EmperorError } from '../errors'
import {
  MOTION_FPS,
  anchorSourceAt,
  clipContainsAnchor,
  reconcileMotionAnchor,
  sliceMotionScene,
  type MotionClipFragment,
  type MotionLineage,
  type MotionScene,
} from './motion'
import {
  clipTimelineDuration,
  MIN_CLIP_SECONDS,
  minSplitTimelineOffset,
  timelineLayout,
} from './timeline'
import { videoProjectSchema, videoProjectCommandSchema } from './types'
import type {
  SubtitleCue,
  VideoAsset,
  VideoClip,
  VideoProject,
  VideoProjectCommand,
  VideoTrack,
} from './types'

export interface VideoProjectCommandResult {
  project: VideoProject
  selectedClipId?: string | null
  selectedSubtitleId?: string | null
  selectedMotionSceneId?: string | null
  /** Intersected cues are removed even when none of their duration survives. */
  removedSubtitleIds?: string[]
  /** Surviving post-edit time intervals of removed cues. */
  retimeSubtitles?: { start: number; end: number }[]
}

type IdFactory = () => string
const EPSILON = 1e-6

function invalid(message: string): never {
  throw new EmperorError(message, 'invalid_edit')
}

function assetFor(project: VideoProject, assetId: string): VideoAsset {
  const asset = project.assets.find((item) => item.id === assetId)
  if (!asset) invalid('找不到这个素材。')
  return asset
}

function clipIndex(project: VideoProject, clipId: string): number {
  const index = project.clips.findIndex((item) => item.id === clipId)
  if (index < 0) invalid('找不到这个时间线片段。')
  return index
}

function trackFor(project: VideoProject, trackId: string): VideoTrack {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) invalid('找不到这条轨道。')
  return track
}

function mainTrack(project: VideoProject): VideoTrack {
  const track = project.tracks.find((item) => item.index === 0)
  if (!track) invalid('工程缺少主画面轨道。')
  return track
}

function clipInterval(clip: VideoClip): {
  start: number
  end: number
  duration: number
} {
  const duration = clipTimelineDuration(clip)
  return {
    start: clip.timelineStart,
    end: clip.timelineStart + duration,
    duration,
  }
}

function trackEnd(project: VideoProject, trackId: string): number {
  let end = 0
  for (const clip of project.clips) {
    if (clip.trackId !== trackId) continue
    end = Math.max(end, clipInterval(clip).end)
  }
  return end
}

function assertPlacement(
  project: VideoProject,
  trackId: string,
  start: number,
  duration: number,
  ignoreClipId?: string,
): void {
  if (!Number.isFinite(start) || start < 0) invalid('片段开始时间无效。')
  const end = start + duration
  for (const other of project.clips) {
    if (other.id === ignoreClipId || other.trackId !== trackId) continue
    const item = clipInterval(other)
    if (start < item.end - EPSILON && end > item.start + EPSILON)
      invalid('同一轨道的片段不能重叠，请换一条轨道或移动位置。')
  }
}

function newClip(
  asset: VideoAsset,
  duration: number | undefined,
  trackId: string,
  timelineStart: number,
  id: string,
): VideoClip {
  if (asset.kind !== 'image') {
    if (asset.duration === null) invalid('请先读取媒体时长，再添加到时间线。')
    return {
      id,
      trackId,
      assetId: asset.id,
      timelineStart,
      sourceIn: 0,
      sourceOut: asset.duration,
      speed: 1,
      volume: 1,
      muted: false,
      transform: { scale: 1, x: 0, y: 0 },
    }
  }
  return {
    id,
    trackId,
    assetId: asset.id,
    timelineStart,
    sourceIn: 0,
    sourceOut: duration ?? 3,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { scale: 1, x: 0, y: 0 },
  }
}

function normalizeSubtitle(cue: { start: number; end: number; text: string }): {
  start: number
  end: number
  text: string
} {
  const text = cue.text.trim()
  if (!text) invalid('字幕文本不能为空。')
  if (text.length > 500) invalid('单条字幕不能超过 500 个字符。')
  if (!Number.isFinite(cue.start) || cue.start < 0)
    invalid('字幕开始时间无效。')
  if (!Number.isFinite(cue.end) || cue.end <= cue.start + 0.05 - EPSILON)
    invalid('字幕结束时间必须晚于开始时间至少 0.05 秒。')
  return { start: cue.start, end: cue.end, text }
}

function sortAndValidateSubtitles(subtitles: SubtitleCue[]): SubtitleCue[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start)
  let previousEnd = 0
  for (const cue of sorted) {
    if (cue.start < previousEnd - EPSILON) invalid('字幕时间不能重叠。')
    previousEnd = cue.end
  }
  return sorted
}

function rippleDeleteRange(
  project: VideoProject,
  command: Extract<VideoProjectCommand, { type: 'rippleDeleteRange' }>,
  createId: IdFactory,
  lineage: MotionLineage,
): VideoProjectCommandResult {
  const { start, end } = command
  const { totalDuration } = timelineLayout(project)
  // Computed clip endpoints can differ from equivalent input times by a few ULPs.
  const timeTolerance = 8 * Number.EPSILON * Math.max(1, totalDuration)
  if (end > totalDuration + timeTolerance || start >= totalDuration)
    invalid('删除区间必须在时间线内。')

  const removed = end - start
  const mapTime = (time: number): number => {
    if (time <= start) return time
    return time <= end ? start : time - removed
  }

  const imageIds = new Set(
    project.assets
      .filter((asset) => asset.kind === 'image')
      .map((asset) => asset.id),
  )
  project.clips = project.clips.flatMap((clip) => {
    const interval = clipInterval(clip)
    if (interval.end <= start + timeTolerance) return [clip]
    if (interval.start >= end - timeTolerance)
      return [{ ...clip, timelineStart: mapTime(interval.start) }]

    const fragments: VideoClip[] = []
    if (interval.start < start - timeTolerance) {
      const sourceOut = clip.sourceIn + (start - interval.start) * clip.speed
      const left = { ...clip, sourceOut }
      delete left.fadeOut
      fragments.push(left)
    }
    if (interval.end > end + timeTolerance) {
      const image = imageIds.has(clip.assetId)
      const right: VideoClip = {
        ...clip,
        id: fragments.length ? createId() : clip.id,
        timelineStart: start,
        sourceIn: image
          ? 0
          : clip.sourceIn + (end - interval.start) * clip.speed,
        sourceOut: image ? interval.end - end : clip.sourceOut,
      }
      delete right.fadeIn
      fragments.push(right)
    }
    lineage.set(
      clip.id,
      fragments.map((part) => ({
        clip: part,
        oldSourceIn:
          imageIds.has(clip.assetId) && part.timelineStart === start
            ? clip.sourceIn + (end - interval.start) * clip.speed
            : part.sourceIn,
      })),
    )
    return fragments
  })

  const removedSubtitleIds: string[] = []
  const retimeSubtitles: { start: number; end: number }[] = []
  project.subtitles = project.subtitles.flatMap((cue) => {
    if (cue.end <= start) return [cue]
    const mapped = { start: mapTime(cue.start), end: mapTime(cue.end) }
    if (cue.start >= end) return [{ ...cue, ...mapped }]
    removedSubtitleIds.push(cue.id)
    if (mapped.end > mapped.start) retimeSubtitles.push(mapped)
    return []
  })

  if (project.annotations)
    project.annotations = project.annotations
      .map((item) => ({
        ...item,
        start: mapTime(item.start),
        end: mapTime(item.end),
      }))
      .filter((item) => item.end > item.start)

  return { project, removedSubtitleIds, retimeSubtitles }
}

export function assertValidVideoProject(
  project: VideoProject,
  code = 'project_invalid',
): void {
  function fail(message: string): never {
    throw new EmperorError(message, code)
  }
  if (!videoProjectSchema.safeParse(project).success)
    fail('剪辑工程格式或数量超出允许范围。')
  const assets = new Map<string, VideoAsset>()
  for (const asset of project.assets) {
    if (assets.has(asset.id)) fail('素材 ID 重复。')
    assets.set(asset.id, asset)
    if (asset.kind === 'image' && asset.duration !== null)
      fail('图片素材没有媒体时长。')
  }
  const trackIds = new Set<string>()
  const trackIndexes = new Set<number>()
  for (const track of project.tracks) {
    if (trackIds.has(track.id)) fail('轨道 ID 重复。')
    if (trackIndexes.has(track.index)) fail('轨道层级重复。')
    trackIds.add(track.id)
    trackIndexes.add(track.index)
  }
  if (
    !project.tracks.some((track) => track.index === 0 && track.kind === 'video')
  )
    fail('工程缺少主画面轨道。')
  const clipIds = new Set<string>()
  for (const clip of project.clips) {
    if (clipIds.has(clip.id)) fail('片段 ID 重复。')
    clipIds.add(clip.id)
    if (!trackIds.has(clip.trackId)) fail('片段引用了不存在的轨道。')
    const asset = assets.get(clip.assetId)
    if (!asset) fail('片段引用了不存在的素材。')
    const track = project.tracks.find((t) => t.id === clip.trackId)!
    if ((track.kind === 'audio') !== (asset.kind === 'audio'))
      fail('音频素材需要独立音轨。')
    if (clip.sourceOut - clip.sourceIn < MIN_CLIP_SECONDS - EPSILON)
      fail('片段时长小于 0.1 秒。')
    if (asset.kind !== 'image') {
      if (asset.duration === null || clip.sourceOut > asset.duration + 1e-6)
        fail('片段超出素材时长。')
    } else if (clip.sourceIn !== 0 || clip.speed !== 1) {
      fail('图片片段的时间参数无效。')
    }
  }
  for (const track of project.tracks) {
    const clips = project.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.timelineStart - b.timelineStart)
    let previousEnd = 0
    for (const clip of clips) {
      if (clip.timelineStart < previousEnd - 1e-6)
        fail('同一轨道的片段不能重叠。')
      previousEnd =
        clip.timelineStart + (clip.sourceOut - clip.sourceIn) / clip.speed
    }
  }
  const motionIds = new Set<string>()
  const clipsById = new Map(project.clips.map((clip) => [clip.id, clip]))
  for (const scene of project.motionScenes ?? []) {
    if (motionIds.has(scene.id)) fail('动效场景 ID 重复。')
    motionIds.add(scene.id)
    if (scene.anchor && !scene.anchor.status) {
      const clip = clipsById.get(scene.anchor.clipId)
      if (!clip || !clipContainsAnchor(clip, scene.anchor.sourceTime))
        fail('动效锚点必须属于对应片段的源时间范围。')
    }
  }
  const annotationIds = new Set<string>()
  for (const a of project.annotations ?? []) {
    if (
      annotationIds.has(a.id) ||
      a.end <= a.start ||
      a.x + a.width > 1 + EPSILON ||
      a.y + a.height > 1 + EPSILON
    )
      fail('标注范围无效。')
    annotationIds.add(a.id)
  }
  const zooms = (project.annotations ?? [])
    .filter((a) => a.kind === 'zoom')
    .sort((a, b) => a.start - b.start)
  if (zooms.some((a, i) => i > 0 && a.start < zooms[i - 1]!.end))
    fail('同一时刻只能有一个放大区域。')
  const subtitleIds = new Set<string>()
  let previousEnd = 0
  for (const cue of project.subtitles) {
    if (subtitleIds.has(cue.id)) fail('字幕 ID 重复。')
    subtitleIds.add(cue.id)
    if (cue.end <= cue.start + 0.05 - 1e-6) fail('字幕结束时间无效。')
    if (cue.start < previousEnd - 1e-6) fail('字幕时间不能重叠。')
    previousEnd = cue.end
  }
}

export function applyVideoProjectCommand(
  current: VideoProject,
  command: VideoProjectCommand,
  createId: IdFactory = randomUUID,
): VideoProjectCommandResult {
  const parsed = videoProjectCommandSchema.safeParse(command)
  if (!parsed.success) invalid('剪辑命令的参数无效。')
  const lineage: MotionLineage = new Map()
  const result = applyCommand(current, parsed.data, createId, lineage)
  if (current.motionScenes?.length)
    retimeMotionScenes(current, result.project, parsed.data, lineage, createId)
  assertValidVideoProject(result.project, 'invalid_edit')
  return result
}

function applyCommand(
  current: VideoProject,
  command: VideoProjectCommand,
  createId: IdFactory,
  lineage: MotionLineage,
): VideoProjectCommandResult {
  const project = structuredClone(current)
  if (command.type === 'rippleDeleteRange')
    return rippleDeleteRange(project, command, createId, lineage)
  if (command.type === 'upsertMotionScene') {
    const scenes = (project.motionScenes ??= [])
    const index = scenes.findIndex((s) => s.id === command.scene.id)
    if (index < 0) scenes.push(command.scene)
    else scenes[index] = command.scene
    return { project, selectedMotionSceneId: command.scene.id }
  }
  if ('sceneId' in command) return editMotionScene(project, command, createId)
  if (command.type === 'setCaptionStyle') {
    project.captionStyle = command.style
    return { project }
  }
  if (command.type === 'addAnnotation') {
    ;(project.annotations ??= []).push({
      ...command.annotation,
      id: createId(),
    })
    return { project }
  }
  if (
    command.type === 'updateAnnotation' ||
    command.type === 'deleteAnnotation'
  ) {
    const index =
      project.annotations?.findIndex((a) => a.id === command.annotationId) ?? -1
    if (index < 0) invalid('找不到这条标注。')
    if (command.type === 'deleteAnnotation')
      project.annotations!.splice(index, 1)
    else
      project.annotations![index] = {
        ...command.annotation,
        id: command.annotationId,
      }
    return { project }
  }
  if (command.type === 'updateCanvas') {
    if (command.fit !== undefined) project.canvas.fit = command.fit
    if (command.background !== undefined)
      project.canvas.background = command.background
    return { project }
  }
  if (command.type === 'addClip') {
    const asset = assetFor(project, command.assetId)
    let track = command.trackId
      ? trackFor(project, command.trackId)
      : asset.kind === 'audio'
        ? project.tracks.find((t) => t.kind === 'audio')
        : mainTrack(project)
    if (!track) {
      if (project.tracks.length >= 8) invalid('轨道数量已达上限。')
      track = {
        id: createId(),
        kind: 'audio',
        index: Math.max(...project.tracks.map((t) => t.index)) + 1,
        name: '音频',
      }
      project.tracks.push(track)
    }
    const clip = newClip(
      asset,
      command.duration,
      track.id,
      command.timelineStart ?? trackEnd(project, track.id),
      createId(),
    )
    if (command.sourceIn !== undefined) clip.sourceIn = command.sourceIn
    if (command.sourceOut !== undefined) clip.sourceOut = command.sourceOut
    assertPlacement(
      project,
      track.id,
      clip.timelineStart,
      clipTimelineDuration(clip),
    )
    project.clips.push(clip)
    return { project, selectedClipId: clip.id }
  }
  if (command.type === 'addTrack') {
    if (project.tracks.length >= 8) invalid('最多只能有 8 条轨道。')
    const index = Math.max(...project.tracks.map((track) => track.index)) + 1
    const track: VideoTrack = {
      id: createId(),
      kind: command.kind ?? 'video',
      name:
        command.name?.trim() ||
        (command.kind === 'audio' ? `音频 ${index}` : `叠加 ${index}`),
      index,
    }
    project.tracks.push(track)
    return { project }
  }
  if (command.type === 'removeTrack') {
    const track = trackFor(project, command.trackId)
    if (track.index === 0) invalid('主画面轨道不能删除。')
    if (project.clips.some((clip) => clip.trackId === track.id))
      invalid('请先删除这条轨道上的片段。')
    project.tracks = project.tracks
      .filter((item) => item.id !== track.id)
      .sort((a, b) => a.index - b.index)
      .map((item, index) => ({ ...item, index }))
    return { project }
  }
  if (command.type === 'addSubtitle') {
    const cue = normalizeSubtitle(command)
    const subtitle: SubtitleCue = { id: createId(), ...cue }
    project.subtitles = sortAndValidateSubtitles([
      ...project.subtitles,
      subtitle,
    ])
    return { project, selectedSubtitleId: subtitle.id }
  }
  if (command.type === 'replaceSubtitles') {
    const ids = new Set(command.replaceIds)
    const retained = command.replaceIds
      ? project.subtitles.filter((cue) => !ids.has(cue.id))
      : []
    if (
      command.replaceIds &&
      project.subtitles.length - retained.length !== ids.size
    )
      invalid('找不到要替换的字幕。')
    project.subtitles = sortAndValidateSubtitles([
      ...retained,
      ...command.cues.map((cue) => ({
        id: createId(),
        ...normalizeSubtitle(cue),
      })),
    ])
    return { project }
  }
  if (command.type === 'updateSubtitle') {
    const index = project.subtitles.findIndex(
      (cue) => cue.id === command.subtitleId,
    )
    if (index < 0) invalid('找不到这条字幕。')
    const cue = project.subtitles[index]!
    const next = normalizeSubtitle({
      start: command.start ?? cue.start,
      end: command.end ?? cue.end,
      text: command.text ?? cue.text,
    })
    cue.start = next.start
    cue.end = next.end
    cue.text = next.text
    project.subtitles = sortAndValidateSubtitles(project.subtitles)
    return { project, selectedSubtitleId: cue.id }
  }
  if (command.type === 'deleteSubtitle') {
    const index = project.subtitles.findIndex(
      (cue) => cue.id === command.subtitleId,
    )
    if (index < 0) invalid('找不到这条字幕。')
    project.subtitles.splice(index, 1)
    return { project, selectedSubtitleId: null }
  }

  const index = clipIndex(project, command.clipId)
  const clip = project.clips[index]!
  const asset = assetFor(project, clip.assetId)

  switch (command.type) {
    case 'replaceClipRanges': {
      if (asset.kind === 'image') invalid('批量剪切需要有时长的素材。')
      let previous = clip.sourceIn
      let cursor = clip.timelineStart
      const kept = command.ranges.map(({ sourceIn, sourceOut }, rangeIndex) => {
        if (
          sourceIn < previous ||
          sourceOut > clip.sourceOut ||
          sourceOut - sourceIn < MIN_CLIP_SECONDS - EPSILON
        )
          invalid('保留区间必须按源时间排序、互不重叠，并在片段内。')
        previous = sourceOut
        const next = {
          ...clip,
          id: createId(),
          sourceIn,
          sourceOut,
          timelineStart: cursor,
        }
        if (rangeIndex > 0) delete next.fadeIn
        if (rangeIndex < command.ranges.length - 1) delete next.fadeOut
        cursor += clipTimelineDuration(next)
        return next
      })
      const oldEnd = clip.timelineStart + clipTimelineDuration(clip)
      const removed = oldEnd - cursor
      for (const other of project.clips)
        if (
          other.trackId === clip.trackId &&
          other.timelineStart >= oldEnd - EPSILON
        )
          other.timelineStart -= removed
      project.clips.splice(index, 1, ...kept)
      lineage.set(
        clip.id,
        kept.map((part) => ({ clip: part, oldSourceIn: part.sourceIn })),
      )
      if (trackFor(project, clip.trackId).index === 0) {
        const mapTime = (time: number) => {
          if (time <= clip.timelineStart) return time
          if (time >= oldEnd) return time - removed
          const source =
            clip.sourceIn + (time - clip.timelineStart) * clip.speed
          let low = 0
          let high = kept.length
          while (low < high) {
            const mid = Math.floor((low + high) / 2)
            if (kept[mid]!.sourceIn <= source) low = mid + 1
            else high = mid
          }
          const range = kept[low - 1]
          return range
            ? range.timelineStart +
                (Math.min(source, range.sourceOut) - range.sourceIn) /
                  clip.speed
            : clip.timelineStart
        }
        project.subtitles = project.subtitles
          .map((c) => ({ ...c, start: mapTime(c.start), end: mapTime(c.end) }))
          .filter((c) => c.end - c.start >= 0.05 - EPSILON)
        if (project.annotations)
          project.annotations = project.annotations
            .map((a) => ({
              ...a,
              start: mapTime(a.start),
              end: mapTime(a.end),
            }))
            .filter((a) => a.end > a.start)
      }
      return { project, selectedClipId: kept[0]!.id }
    }
    case 'trimClip': {
      const before = clipInterval(clip)
      const sourceIn = command.sourceIn ?? clip.sourceIn
      const sourceOut = command.sourceOut ?? clip.sourceOut
      if (asset.kind === 'image' && sourceIn !== 0)
        invalid('图片片段的源入点必须为 0。')
      if (sourceOut - sourceIn < MIN_CLIP_SECONDS - EPSILON)
        invalid('片段至少需要保留 0.1 秒素材。')
      if (
        sourceIn < 0 ||
        (asset.duration !== null && sourceOut > asset.duration + 1e-6)
      )
        invalid('剪切范围不能超出素材时长。')
      const nextDuration = (sourceOut - sourceIn) / clip.speed
      const leftEdge =
        command.edge === 'left' ||
        (command.edge === undefined &&
          command.sourceIn !== undefined &&
          command.sourceOut === undefined)
      const nextStart =
        leftEdge && asset.kind !== 'image'
          ? before.end - nextDuration
          : before.start
      if (nextStart < -EPSILON) invalid('修剪后片段开始时间不能小于 0。')
      assertPlacement(
        project,
        clip.trackId,
        Math.max(0, nextStart),
        nextDuration,
        clip.id,
      )
      clip.sourceIn = sourceIn
      clip.sourceOut = sourceOut
      clip.timelineStart = Math.max(0, nextStart)
      return { project, selectedClipId: clip.id }
    }
    case 'splitClip': {
      const duration = clipTimelineDuration(clip)
      const minimum = minSplitTimelineOffset(clip.speed)
      if (
        command.timelineOffset < minimum - EPSILON ||
        duration - command.timelineOffset < minimum - EPSILON
      )
        invalid('播放头必须位于片段内部，并为两侧各保留至少 0.1 秒素材。')
      const sourceCut = clip.sourceIn + command.timelineOffset * clip.speed
      const right: VideoClip = {
        ...structuredClone(clip),
        id: createId(),
        timelineStart: clip.timelineStart + command.timelineOffset,
        sourceIn: asset.kind === 'image' ? 0 : sourceCut,
        sourceOut:
          asset.kind === 'image' ? clip.sourceOut - sourceCut : clip.sourceOut,
      }
      delete right.fadeIn
      delete clip.fadeOut
      clip.sourceOut = sourceCut
      project.clips.splice(index + 1, 0, right)
      lineage.set(clip.id, [
        { clip, oldSourceIn: clip.sourceIn },
        { clip: right, oldSourceIn: sourceCut },
      ])
      return { project, selectedClipId: right.id }
    }
    case 'deleteClip': {
      const before = clipInterval(clip)
      project.clips.splice(index, 1)
      for (const other of project.clips) {
        if (other.trackId !== clip.trackId) continue
        if (other.timelineStart >= before.end - EPSILON)
          other.timelineStart = Math.max(
            0,
            other.timelineStart - before.duration,
          )
      }
      const sameTrack = project.clips
        .filter((item) => item.trackId === clip.trackId)
        .sort((a, b) => a.timelineStart - b.timelineStart)
      const next =
        sameTrack.find(
          (item) => item.timelineStart >= before.start - EPSILON,
        ) ??
        sameTrack.at(-1) ??
        null
      return { project, selectedClipId: next?.id ?? null }
    }
    case 'moveClip': {
      const track = trackFor(project, command.trackId)
      const duration = clipTimelineDuration(clip)
      assertPlacement(
        project,
        track.id,
        command.timelineStart,
        duration,
        clip.id,
      )
      clip.trackId = track.id
      clip.timelineStart = command.timelineStart
      return { project, selectedClipId: clip.id }
    }
    case 'updateClip': {
      if (
        asset.kind === 'image' &&
        command.speed !== undefined &&
        command.speed !== 1
      )
        invalid('图片片段不能调整播放速度。')
      if (command.speed !== undefined) clip.speed = command.speed
      if (command.fadeIn !== undefined) clip.fadeIn = command.fadeIn
      if (command.fadeOut !== undefined) clip.fadeOut = command.fadeOut
      if (command.volume !== undefined) clip.volume = command.volume
      if (command.muted !== undefined) clip.muted = command.muted
      if (command.transform !== undefined)
        clip.transform = structuredClone(command.transform)
      return { project, selectedClipId: clip.id }
    }
  }
}

function editMotionScene(
  project: VideoProject,
  command: Extract<VideoProjectCommand, { sceneId: string }>,
  createId: IdFactory,
): VideoProjectCommandResult {
  const scenes = project.motionScenes ?? []
  const index = scenes.findIndex((scene) => scene.id === command.sceneId)
  const scene = scenes[index]
  if (!scene) invalid('找不到这个动效场景。')
  if (
    'expectedVersion' in command &&
    command.expectedVersion !== undefined &&
    command.expectedVersion !== scene.version
  )
    invalid('动效版本已变化，请重新选择场景。')
  const clip =
    scene.anchor && project.clips.find((c) => c.id === scene.anchor!.clipId)
  switch (command.type) {
    case 'setMotionAnchor': {
      if (command.anchor) {
        const target = project.clips[clipIndex(project, command.anchor.clipId)]!
        if (!clipContainsAnchor(target, command.anchor.sourceTime))
          invalid('动效锚点必须位于片段源时间范围内。')
        scene.startFrame = Math.round(
          (target.timelineStart +
            (command.anchor.sourceTime - target.sourceIn) / target.speed) *
            MOTION_FPS,
        )
        scene.anchor = command.anchor
      } else delete scene.anchor
      break
    }
    case 'deleteMotionObject': {
      const index = scene.objects.findIndex(
        (object) => object.id === command.objectId,
      )
      if (index < 0) invalid('找不到这个动效对象。')
      if (scene.objects.length === 1)
        invalid('这是最后一个对象，请明确选择删除整幕。')
      scene.objects.splice(index, 1)
      scene.version++
      return { project, selectedMotionSceneId: null }
    }
    case 'deleteMotionScene':
      scenes.splice(index, 1)
      return { project, selectedMotionSceneId: null }
    case 'moveMotionScene':
      scene.startFrame = command.startFrame
      if (scene.anchor && clip)
        scene.anchor.offsetSource =
          anchorSourceAt(clip, scene.startFrame) - scene.anchor.sourceTime
      break
    case 'trimMotionScene': {
      const next = sliceMotionScene(
        scene,
        command.startFrame,
        command.startFrame + command.durationFrames,
        clip,
      )
      if (next.sourceInFrame !== command.sourceInFrame && next.playback) {
        delete next.playback.phase
        next.playback.endFrame =
          command.sourceInFrame +
          command.durationFrames * (next.playback.rate ?? 1)
      }
      next.sourceInFrame = command.sourceInFrame
      scenes[index] = next
      break
    }
    case 'splitMotionScene': {
      const end = scene.startFrame + scene.durationFrames
      if (command.frame <= scene.startFrame || command.frame >= end)
        invalid('播放头必须位于动效场景内部。')
      const left = sliceMotionScene(
        scene,
        scene.startFrame,
        command.frame,
        clip,
      )
      const right = {
        ...sliceMotionScene(scene, command.frame, end, clip),
        id: createId(),
      }
      scenes.splice(index, 1, left, right)
      return { project, selectedMotionSceneId: right.id }
    }
  }
  return { project, selectedMotionSceneId: scene.id }
}

interface KeptMotionSlice {
  /** Scene still positioned on the original timeline for clip-lineage reconciliation. */
  scene: MotionScene
  startAfterCut: number
}

/** Remove frames covered by a global ripple; a two-sided cut requires two source phases. */
function rippleMotionSlices(
  scene: MotionScene,
  start: number,
  end: number,
  createId: IdFactory,
  clip?: VideoClip,
): KeptMotionSlice[] {
  const first = scene.startFrame
  const last = first + scene.durationFrames
  if (last <= start || end <= start) return [{ scene, startAfterCut: first }]
  if (first >= end) return [{ scene, startAfterCut: first - (end - start) }]
  const kept: KeptMotionSlice[] = []
  if (first < start)
    kept.push({
      scene: sliceMotionScene(scene, first, start, clip),
      startAfterCut: first,
    })
  if (last > end) {
    const right = sliceMotionScene(scene, end, last, clip)
    if (kept.length) right.id = createId()
    kept.push({ scene: right, startAfterCut: start })
  }
  return kept
}

function retimeMotionScenes(
  current: VideoProject,
  project: VideoProject,
  command: VideoProjectCommand,
  lineage: MotionLineage,
  createId: IdFactory,
): void {
  if (!('clipId' in command) && command.type !== 'rippleDeleteRange') return
  const globalCut =
    command.type === 'rippleDeleteRange'
      ? {
          start: Math.ceil(command.start * MOTION_FPS - 1e-8),
          end: Math.ceil(command.end * MOTION_FPS - 1e-8),
        }
      : null
  const before = new Map(current.clips.map((clip) => [clip.id, clip]))
  const after = new Map(project.clips.map((clip) => [clip.id, clip]))
  project.motionScenes = project.motionScenes!.flatMap((scene) => {
    const anchor = scene.anchor
    const old = anchor && before.get(anchor.clipId)
    const next = anchor && after.get(anchor.clipId)
    const pieces: MotionClipFragment[] = anchor
      ? (lineage.get(anchor.clipId) ??
        (next ? [{ clip: next, oldSourceIn: next.sourceIn }] : []))
      : []
    const changed =
      !!old &&
      (lineage.has(old.id) ||
        !next ||
        next.timelineStart !== old.timelineStart ||
        next.speed !== old.speed ||
        next.sourceIn !== old.sourceIn ||
        next.sourceOut !== old.sourceOut)
    const relink = (piece: MotionScene) =>
      old && changed ? reconcileMotionAnchor(piece, old, pieces) : piece
    if (!globalCut) return [relink(scene)]
    // Retain the authored scene for repair when the underlying source anchor itself was removed.
    const bound = relink(scene)
    if (bound.anchor?.status === 'lost') {
      bound.startFrame =
        Math.min(scene.startFrame, globalCut.start) +
        Math.max(0, scene.startFrame - globalCut.end)
      return [bound]
    }
    return rippleMotionSlices(
      scene,
      globalCut.start,
      globalCut.end,
      createId,
      old,
    ).map(({ scene: kept, startAfterCut }) => {
      const result = relink(kept)
      result.startFrame = startAfterCut
      if (result.anchor && !result.anchor.status) {
        const target = after.get(result.anchor.clipId)!
        const offset =
          anchorSourceAt(target, startAfterCut) - result.anchor.sourceTime
        if (
          Math.abs(offset) > EPSILON ||
          result.anchor.offsetSource !== undefined
        )
          result.anchor.offsetSource = offset
      }
      return result
    })
  })
}
