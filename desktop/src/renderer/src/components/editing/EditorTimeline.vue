<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Captions,
  Film,
  AudioLines,
  Import,
  Layers2,
  MessageSquareText,
  Plus,
  Scissors,
  Trash2,
  BetweenHorizontalEnd,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next'
import {
  clipTimelineDuration,
  minSplitTimelineOffset,
  MOTION_FPS,
  type SubtitleCue,
  type TimelineChip,
  type VideoAsset,
  type VideoClip,
  type VideoTrack,
} from '@emperor/core/editing'
import {
  clampTrimDrag,
  formatTimecode,
  pointerTimelineTime,
  timelineHitInsets,
} from './editingViewModel'
import Button from '../ui/Button.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import MotionLane from './MotionLane.vue'
import AssetThumbnail from './AssetThumbnail.vue'
import SubtitleGenerateDialog from './SubtitleGenerateDialog.vue'
import { core } from '../../api/http'
import {
  useEditingWorkspace,
  type TimelineReferenceTarget,
} from './editingStore'

const emit = defineEmits<{
  import: []
  'add-reference': [reference: TimelineChip]
}>()
const workspace = useEditingWorkspace()
const pixelsPerSecond = ref(80)
const draggingClipId = ref('')
const dragOffset = ref(0)
const dropTrackId = ref('')
const trimHint = ref('')
const cueDraft = ref<{ id: string; start: number; end: number } | null>(null)
const subtitleDialogOpen = ref(false)
const peaks = ref<Record<string, number[]>>({})
const project = workspace.displayProject
const counts = computed(() => {
  const clips = project.value?.clips.length ?? 0
  const cues = project.value?.subtitles.length ?? 0
  const motions = workspace.motionScenes.value.length
  return [
    ...(clips || !motions ? [`${clips} 个片段`] : []),
    ...(cues || !motions ? [`${cues} 条字幕`] : []),
    ...(motions ? [`${motions} 幕动效`] : []),
  ].join(' · ')
})
const readOnly = workspace.readOnly
const layout = workspace.layout
const change = computed(() =>
  readOnly.value ? workspace.state.draft?.change : undefined,
)
const changedClips = computed(() => new Set(change.value?.clipIds))
const changedSubtitles = computed(() => new Set(change.value?.subtitleIds))
const changedTracks = computed(() => new Set(change.value?.trackIds))
const rippleRange = ref<{ start: number; end: number } | null>(null)
const contextOpen = ref(false)
const contextAnchor = ref<HTMLElement | null>(null)
const contextPoint = ref({ x: 0, y: 0 })
const contextReference = ref<TimelineChip | null>(null)
const contextRange = ref<TimelineChip | null>(null)
const rippleTarget = computed(
  () => rippleRange.value ?? workspace.selectedRange.value,
)
watch([readOnly, () => project.value?.revision], () => {
  rippleRange.value = null
  if (readOnly.value) {
    cancelGesture?.()
    draggingClipId.value = ''
    dropTrackId.value = ''
    subtitleDialogOpen.value = false
  }
})
watch(
  [
    () => workspace.state.sessionId,
    readOnly,
    () => project.value?.revision,
    () => workspace.state.draft?.generation,
  ],
  () => {
    contextOpen.value = false
  },
)
const ruler = ref<HTMLElement | null>(null)
const referenceFocus = computed(() => {
  const cited = workspace.state.referenceFocus
  return cited && !workspace.referenceUnavailable(cited) ? cited : null
})
watch(
  referenceFocus,
  async (cited) => {
    if (!cited) return
    await nextTick()
    const scroll = ruler.value?.closest<HTMLElement>('.timeline-scroll')
    if (!scroll) return
    const x = cited.start * pixelsPerSecond.value
    const labelWidth = ruler.value?.offsetLeft ?? 0
    if (
      x < scroll.scrollLeft ||
      x > scroll.scrollLeft + scroll.clientWidth - labelWidth - 12
    )
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 3)
  },
  { flush: 'post' },
)
const contentWidth = computed(() =>
  Math.max(1, layout.value.totalDuration * pixelsPerSecond.value),
)
const displayTracks = computed<VideoTrack[]>(() =>
  project.value
    ? [...project.value.tracks].sort((a, b) => b.index - a.index)
    : [],
)

const currentAtPlayhead = computed(workspace.splitTarget)
const canSplit = computed(() => {
  const scene = workspace.selectedMotionScene.value
  if (scene) {
    const frame = Math.round(workspace.state.playhead * MOTION_FPS)
    return (
      !workspace.state.selectedMotionObjectId &&
      workspace.canEditMotionScene(scene.id) &&
      frame > scene.startFrame &&
      frame < scene.startFrame + scene.durationFrames
    )
  }
  const current = currentAtPlayhead.value
  return Boolean(
    current &&
    current.localTime >= minSplitTimelineOffset(current.clip.speed) &&
    clipTimelineDuration(current.clip) - current.localTime >=
      minSplitTimelineOffset(current.clip.speed),
  )
})
const tickStep = computed(() =>
  pixelsPerSecond.value < 45 ? 5 : pixelsPerSecond.value < 90 ? 2 : 1,
)
const ticks = computed(() => {
  const result: number[] = []
  for (
    let time = 0;
    time <= layout.value.totalDuration + tickStep.value && result.length < 1000;
    time += tickStep.value
  )
    result.push(time)
  return result
})

async function loadPeaks(): Promise<void> {
  const origin = workspace.captureProject()
  const sessionId = origin.sessionId
  if (!project.value || !sessionId) return
  const assetIds = [
    ...new Set(
      project.value.clips
        .map((clip) =>
          project.value?.assets.find((asset) => asset.id === clip.assetId),
        )
        .filter(
          (asset): asset is VideoAsset => !!asset && asset.kind !== 'image',
        )
        .map((asset) => asset.id),
    ),
  ]
  for (const assetId of assetIds) {
    if (!workspace.isCurrent(origin)) return
    if (peaks.value[assetId]?.length) continue
    try {
      const result = await core('videoProject.transcript', {
        sessionId,
        assetId,
      })
      const values = result?.transcript?.peaks
      if (workspace.isCurrent(origin) && values?.length)
        peaks.value = { ...peaks.value, [assetId]: values }
    } catch {
      // No transcript cache yet; the strip shows volume state instead.
    }
  }
}
watch(
  () =>
    [
      workspace.state.sessionId,
      project.value?.revision ?? 0,
      project.value?.clips.map((clip) => clip.assetId).join('|') ?? '',
    ].join('::'),
  () => void loadPeaks(),
  { immediate: true },
)
function waveBars(clip: VideoClip): number[] {
  const asset = assetFor(clip)
  const values = peaks.value[clip.assetId]
  if (!asset?.duration || !values?.length) return []
  const from = Math.floor((clip.sourceIn / asset.duration) * values.length)
  const to = Math.max(
    from + 1,
    Math.ceil((clip.sourceOut / asset.duration) * values.length),
  )
  const slice = values.slice(from, to)
  const bars = 24
  return Array.from({ length: bars }, (_, index) => {
    const start = Math.floor((index / bars) * slice.length)
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) / bars) * slice.length),
    )
    return Math.max(...slice.slice(start, end), 0.05)
  })
}

const assetsById = computed(
  () => new Map(project.value?.assets.map((asset) => [asset.id, asset])),
)
const layoutById = computed(
  () =>
    new Map(
      layout.value.clips.map((entry, index) => [
        entry.clipId,
        { ...entry, number: index + 1 },
      ]),
    ),
)
const clipsByTrack = computed(
  () =>
    new Map(
      layout.value.tracks.map((row) => [
        row.track.id,
        row.clips.map((entry) => project.value!.clips[entry.index]!),
      ]),
    ),
)
function assetFor(clip: VideoClip) {
  return assetsById.value.get(clip.assetId)
}
function clipLayout(id: string) {
  return layoutById.value.get(id)
}
function clipNumber(id: string) {
  return clipLayout(id)?.number
}
function trackClips(trackId: string) {
  return clipsByTrack.value.get(trackId) ?? []
}
const clipHits = computed(
  () =>
    new Map(
      layout.value.tracks.flatMap((row) => [
        ...timelineHitInsets(
          row.clips.map((item) => ({ ...item, id: item.clipId })),
          pixelsPerSecond.value,
        ),
      ]),
    ),
)
const cueHits = computed(() =>
  timelineHitInsets(layout.value.subtitles, pixelsPerSecond.value),
)
function clipStyle(clipId: string) {
  const item = clipLayout(clipId)
  return item
    ? {
        left: `${item.start * pixelsPerSecond.value}px`,
        width: `${item.duration * pixelsPerSecond.value}px`,
        ...clipHits.value.get(clipId),
      }
    : {}
}
function cueStyle(cue: SubtitleCue) {
  const draft = cueDraft.value?.id === cue.id ? cueDraft.value : cue
  return {
    left: `${draft.start * pixelsPerSecond.value}px`,
    width: `${(draft.end - draft.start) * pixelsPerSecond.value}px`,
    ...cueHits.value.get(cue.id),
  }
}
function timeAt(clientX: number): number {
  const container = ruler.value
  if (!container) return 0
  return pointerTimelineTime({
    clientX,
    left: container.getBoundingClientRect().left,
    scrollLeft: 0,
    pixelsPerSecond: pixelsPerSecond.value,
    total: Math.max(layout.value.totalDuration, 0.01),
  })
}
function openContextMenu(event: MouseEvent): void {
  if (!(event.target instanceof Element) || !project.value) return
  const element = event.target
  const clip = element.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId
  const cue =
    element.closest<HTMLElement>('[data-subtitle-id]')?.dataset.subtitleId
  const track = element.closest<HTMLElement>('[data-timeline-track]')?.dataset
    .timelineTrack
  const bounds = element.getBoundingClientRect()
  const keyboard = event.clientX === 0 && event.clientY === 0
  const x = keyboard ? bounds.left + bounds.width / 2 : event.clientX
  const y = keyboard ? bounds.top + bounds.height / 2 : event.clientY
  const time = element.closest('[data-timeline-playhead]')
    ? workspace.state.playhead
    : Math.min(timeAt(x), layout.value.totalDuration)
  const range = rippleRange.value
  const rangeTarget =
    range && time >= range.start && time <= range.end
      ? { kind: 'range' as const, ...range }
      : null

  let target: TimelineReferenceTarget
  const motion = element.closest<HTMLElement>(
    '[data-motion-scene],[data-motion-scene-detail]',
  )
  const sceneId =
    motion?.dataset.motionScene ?? motion?.dataset.motionSceneDetail
  if (sceneId) {
    target = {
      kind: 'motion',
      id: sceneId,
      objectId: element.closest<HTMLElement>('[data-motion-object]')?.dataset
        .motionObject,
    }
    const marker = element.closest<HTMLElement>('[data-motion-marker]')?.dataset
      .motionMarker
    if (marker !== undefined) target.markerFrame = Number(marker)
  } else if (clip) target = { kind: 'clip', id: clip }
  else if (cue) target = { kind: 'subtitle', id: cue }
  else if (track) target = { kind: 'track', id: track }
  else if (element.closest('[data-timeline-subtitles]'))
    target = { kind: 'subtitle-track' }
  else target = rangeTarget ?? { kind: 'point', time }

  const text = workspace.timelineReference(target)
  if (!text) return
  contextReference.value = text
  contextRange.value =
    rangeTarget && (clip || cue)
      ? workspace.timelineReference(rangeTarget)
      : null
  contextPoint.value = { x, y }
  contextOpen.value = true
  void nextTick(() => {
    document
      .querySelector<HTMLElement>('[data-testid="timeline-add-reference"]')
      ?.focus()
  })
}

function addReference(reference: TimelineChip | null): void {
  if (reference) emit('add-reference', reference)
}

function seek(event: MouseEvent, anchor = workspace.state.playhead): void {
  if (!project.value) return
  const time = timeAt(event.clientX)
  rippleRange.value =
    event.shiftKey && anchor !== time
      ? { start: Math.min(anchor, time), end: Math.max(anchor, time) }
      : null
  workspace.setPlayhead(time)
}
function scrubRuler(event: PointerEvent): void {
  if (event.button !== 0 || event.ctrlKey) return
  event.preventDefault()
  const initial = workspace.state.playhead
  seek(event, initial)
  const scrub = (pointer: PointerEvent) => seek(pointer, initial)
  trackPointer(scrub, scrub, event.pointerId)
}
function selectClip(clipId: string): void {
  rippleRange.value = null
  workspace.selectClip(clipId)
}
function selectSubtitle(subtitleId: string): void {
  rippleRange.value = null
  workspace.selectSubtitle(subtitleId, readOnly.value)
}
function rippleDelete(): void {
  if (readOnly.value || !rippleTarget.value) return
  void workspace
    .rippleDeleteSelection(rippleTarget.value)
    .catch(() => undefined)
}
function zoom(delta: number): void {
  pixelsPerSecond.value = Math.max(
    20,
    Math.min(240, pixelsPerSecond.value + delta),
  )
}
function startClipDrag(event: DragEvent, clip: VideoClip): void {
  if (readOnly.value) {
    event.preventDefault()
    return
  }
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  draggingClipId.value = clip.id
  dragOffset.value = Math.max(
    0,
    Math.min(
      clipTimelineDuration(clip),
      (event.clientX - bounds.left) / pixelsPerSecond.value,
    ),
  )
  event.dataTransfer?.setData('text/x-video-clip', clip.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onLaneDragOver(event: DragEvent, trackId: string): void {
  if (readOnly.value) return
  if (
    !event.dataTransfer?.types.includes('text/x-video-asset') &&
    !event.dataTransfer?.types.includes('text/x-video-clip')
  )
    return
  event.preventDefault()
  dropTrackId.value = trackId
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
      'text/x-video-clip',
    )
      ? 'move'
      : 'copy'
}
function onLaneDrop(event: DragEvent, trackId: string): void {
  event.preventDefault()
  dropTrackId.value = ''
  if (!project.value || readOnly.value) return
  const assetId = event.dataTransfer?.getData('text/x-video-asset') || ''
  const clipId =
    draggingClipId.value ||
    event.dataTransfer?.getData('text/x-video-clip') ||
    ''
  const at = timeAt(event.clientX)
  if (assetId) {
    const asset = project.value.assets.find((item) => item.id === assetId)
    if (!asset || (asset.kind !== 'image' && asset.duration === null)) return
    void workspace
      .mutate({
        type: 'addClip',
        assetId,
        trackId,
        timelineStart: at,
      })
      .catch(() => undefined)
  } else if (clipId) {
    void workspace
      .mutate({
        type: 'moveClip',
        clipId,
        trackId,
        timelineStart: Math.max(0, at - dragOffset.value),
      })
      .catch(() => undefined)
  }
  draggingClipId.value = ''
}
function addTrack(): void {
  void workspace.mutate({ type: 'addTrack' }).catch(() => undefined)
}
function removeTrack(trackId: string): void {
  void workspace.mutate({ type: 'removeTrack', trackId }).catch(() => undefined)
}
function trackEmpty(trackId: string): boolean {
  return !project.value?.clips.some((clip) => clip.trackId === trackId)
}
function neighbourBounds(clip: VideoClip, edge: 'left' | 'right') {
  const item = clipLayout(clip.id)
  const others = layout.value.clips
    .filter(
      (entry) => entry.trackId === clip.trackId && entry.clipId !== clip.id,
    )
    .sort((a, b) => a.start - b.start)
  if (!item) return null
  if (edge === 'right') {
    const next = others.find((entry) => entry.start >= item.end - 1e-6)
    return next ? next.start : null
  }
  const previous = [...others]
    .reverse()
    .find((entry) => entry.end <= item.start + 1e-6)
  return previous ? previous.end : null
}
let cancelGesture: (() => void) | undefined
function trackPointer(
  move: (event: PointerEvent) => void,
  up: (event: PointerEvent) => void,
  id: number,
) {
  cancelGesture?.()
  const onMove = (event: PointerEvent) => {
    if (event.pointerId === id) move(event)
  }
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== id) return
    cleanup()
    up(event)
  }
  function cleanup() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', cleanup)
    trimHint.value = ''
    cueDraft.value = null
    cancelGesture = undefined
  }
  cancelGesture = cleanup
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cleanup)
}
onBeforeUnmount(() => cancelGesture?.())
function beginTrim(
  event: PointerEvent,
  clip: VideoClip,
  edge: 'left' | 'right',
): void {
  if (readOnly.value || event.button !== 0 || event.ctrlKey) return
  event.preventDefault()
  event.stopPropagation()
  const asset = assetFor(clip)
  if (!asset) return
  const origin = workspace.captureProject()
  const startX = event.clientX
  const original = { ...clip }
  const item = clipLayout(clip.id)
  const target = event.currentTarget as HTMLElement
  try {
    target.setPointerCapture(event.pointerId)
  } catch {
    /* window listeners still work */
  }
  const clamp = (clientX: number) => {
    const next = clampTrimDrag(
      asset,
      original,
      edge,
      clientX - startX,
      pixelsPerSecond.value,
    )
    if (!item) return next
    if (edge === 'right') {
      const bound = neighbourBounds(original, 'right')
      if (bound !== null)
        next.sourceOut = Math.min(
          next.sourceOut,
          original.sourceIn + (bound - item.start) * original.speed,
        )
    } else {
      const bound = neighbourBounds(original, 'left')
      if (bound !== null)
        next.sourceIn = Math.max(
          next.sourceIn,
          original.sourceOut - (item.end - bound) * original.speed,
        )
    }
    return next
  }
  const move = (moveEvent: PointerEvent) => {
    const next = clamp(moveEvent.clientX)
    trimHint.value = `${formatTimecode(next.sourceIn)} — ${formatTimecode(next.sourceOut)}`
  }
  const up = (upEvent: PointerEvent) => {
    if (!workspace.isCurrent(origin)) return
    const next = clamp(upEvent.clientX)
    trimHint.value = ''
    void workspace
      .mutate({
        type: 'trimClip',
        clipId: clip.id,
        edge,
        ...next,
      })
      .catch(() => undefined)
  }
  trackPointer(move, up, event.pointerId)
}
function beginCueMove(event: PointerEvent, cue: SubtitleCue): void {
  if (readOnly.value || event.button !== 0 || event.ctrlKey) return
  event.preventDefault()
  event.stopPropagation()
  const origin = workspace.captureProject()
  const startX = event.clientX
  const original = { ...cue }
  const move = (moveEvent: PointerEvent) => {
    const delta = (moveEvent.clientX - startX) / pixelsPerSecond.value
    const shift = Math.max(-original.start, delta)
    cueDraft.value = {
      id: cue.id,
      start: original.start + shift,
      end: original.end + shift,
    }
  }
  const up = () => {
    if (!workspace.isCurrent(origin)) return
    const draft = cueDraft.value
    cueDraft.value = null
    if (!draft) return
    void workspace
      .mutate({
        type: 'updateSubtitle',
        subtitleId: cue.id,
        start: draft.start,
        end: draft.end,
      })
      .catch(() => undefined)
  }
  trackPointer(move, up, event.pointerId)
}
function beginCueTrim(
  event: PointerEvent,
  cue: SubtitleCue,
  edge: 'left' | 'right',
): void {
  if (readOnly.value || event.button !== 0 || event.ctrlKey) return
  event.preventDefault()
  event.stopPropagation()
  const origin = workspace.captureProject()
  const startX = event.clientX
  const original = { ...cue }
  const clamp = (clientX: number) => {
    const delta = (clientX - startX) / pixelsPerSecond.value
    if (edge === 'left')
      return {
        id: cue.id,
        start: Math.max(
          0,
          Math.min(original.end - 0.05, original.start + delta),
        ),
        end: original.end,
      }
    return {
      id: cue.id,
      start: original.start,
      end: Math.max(original.start + 0.05, original.end + delta),
    }
  }
  const move = (moveEvent: PointerEvent) => {
    cueDraft.value = clamp(moveEvent.clientX)
  }
  const up = (upEvent: PointerEvent) => {
    if (!workspace.isCurrent(origin)) return
    const draft = clamp(upEvent.clientX)
    cueDraft.value = null
    void workspace
      .mutate({
        type: 'updateSubtitle',
        subtitleId: cue.id,
        start: draft.start,
        end: draft.end,
      })
      .catch(() => undefined)
  }
  trackPointer(move, up, event.pointerId)
}
</script>

<template>
  <section
    class="editor-timeline"
    aria-label="剪辑时间线"
    :data-drop-active="dropTrackId || undefined"
    :data-readonly="readOnly || undefined"
  >
    <header class="timeline-toolbar">
      <div class="timeline-title">
        <strong>时间线</strong>
        <span>{{ counts }}</span>
      </div>
      <slot name="versions" />
      <div class="timeline-actions">
        <span v-if="trimHint" class="trim-hint">{{ trimHint }}</span>
        <Button
          type="button"
          size="sm"
          :disabled="readOnly || !project?.clips.length"
          title="转写并生成字幕"
          @click="subtitleDialogOpen = true"
        >
          <Captions :size="14" />字幕
        </Button>
        <Button
          size="sm"
          :disabled="readOnly || displayTracks.length >= 8"
          @click="
            workspace
              .mutate({ type: 'addTrack', kind: 'audio' })
              .catch(() => undefined)
          "
          >＋音轨</Button
        >
        <Button
          type="button"
          size="sm"
          :disabled="readOnly || displayTracks.length >= 8"
          title="新增一条并行视频轨道"
          @click="addTrack"
        >
          <Plus :size="14" />画面轨
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="readOnly || !canSplit"
          title="在播放头拆分"
          @click="workspace.splitAtPlayhead"
        >
          <Scissors :size="14" />拆分
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="!workspace.canDelete.value"
          :title="
            workspace.state.selectedMotionMarkerFrame !== null
              ? '动作标记用于定位播放头'
              : workspace.deleteLabel.value
          "
          data-testid="timeline-delete-selection"
          @click="workspace.deleteSelection().catch(() => undefined)"
        >
          <Trash2 :size="14" />{{ workspace.deleteLabel.value }}
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="readOnly || !rippleTarget"
          title="删除所选时间范围并左移所有轨道。选中片段或字幕，或在标尺上按住 Shift 点击以选定范围。"
          @click="rippleDelete"
        >
          <BetweenHorizontalEnd :size="14" />波纹删除
        </Button>
        <span class="toolbar-separator" />
        <Button
          type="button"
          size="sm"
          class="square"
          aria-label="缩小时间线"
          @click="zoom(-20)"
        >
          <ZoomOut :size="14" />
        </Button>
        <Button
          type="button"
          size="sm"
          class="square"
          aria-label="放大时间线"
          @click="zoom(20)"
        >
          <ZoomIn :size="14" />
        </Button>
      </div>
    </header>

    <SubtitleGenerateDialog v-model:open="subtitleDialogOpen" />
    <div v-if="project" class="timeline-scroll">
      <div
        class="sequence-content"
        :style="{
          width: `calc(var(--track-label-width) + ${contentWidth}px)`,
          minWidth: '100%',
          '--tick-width': pixelsPerSecond * tickStep + 'px',
        }"
        @contextmenu.prevent="openContextMenu"
      >
        <div
          ref="ruler"
          class="timeline-ruler"
          @pointerdown="scrubRuler"
          @click="!$event.detail && seek($event)"
        >
          <Button
            v-for="tick in ticks"
            :key="tick"
            type="button"
            class="ruler-tick"
            :style="{ left: `${tick * pixelsPerSecond}px` }"
            tabindex="-1"
          >
            {{ formatTimecode(tick).slice(0, -3) }}
          </Button>
        </div>
        <MotionLane
          v-if="
            workspace.state.motionEnabled ||
            workspace.motionScenes.value.length ||
            workspace.visibleMotionWork.value
          "
          :scale="pixelsPerSecond"
          @seek="seek"
          @reference="addReference(workspace.timelineReference($event))"
        />
        <div
          v-for="track in displayTracks"
          :key="track.id"
          class="track-row media-row"
          :data-track-kind="track.kind"
          :data-reference-focus="
            (referenceFocus?.target.kind === 'track' &&
              referenceFocus.target.id === track.id) ||
            undefined
          "
          :class="{ 'drop-target': dropTrackId === track.id }"
          :data-agent-change="changedTracks.has(track.id) || undefined"
        >
          <div class="track-label" :data-timeline-track="track.id" tabindex="0">
            <AudioLines v-if="track.kind === 'audio'" :size="14" />
            <Film v-else-if="track.index === 0" :size="14" />
            <Layers2 v-else :size="14" />
            <span :title="track.name">{{ track.name }}</span>
            <Button
              v-if="!readOnly && track.index > 0 && trackEmpty(track.id)"
              type="button"
              class="track-remove"
              :aria-label="`删除轨道 ${track.name}`"
              title="删除空轨道"
              @click="removeTrack(track.id)"
            >
              ×
            </Button>
          </div>
          <div
            class="lane"
            @click.self="seek"
            @dragover="onLaneDragOver($event, track.id)"
            @dragleave="dropTrackId = ''"
            @drop="onLaneDrop($event, track.id)"
          >
            <div
              v-for="clip in trackClips(track.id)"
              :key="clip.id"
              class="timeline-clip video-clip"
              :class="{
                selected: workspace.state.selectedClipId === clip.id,
                dragging: draggingClipId === clip.id,
              }"
              :style="clipStyle(clip.id)"
              :data-clip-id="clip.id"
              :data-agent-change="changedClips.has(clip.id) || undefined"
              role="button"
              tabindex="0"
              :draggable="!readOnly"
              :aria-label="`片段 ${clipNumber(clip.id)}：${assetFor(clip)?.displayName ?? clip.assetId}`"
              :title="`${assetFor(clip)?.displayName ?? clip.assetId} · ${formatTimecode(clip.timelineStart)}–${formatTimecode(clip.timelineStart + clipTimelineDuration(clip))}`"
              @click.stop="selectClip(clip.id)"
              @keydown.enter="selectClip(clip.id)"
              @dragstart="startClipDrag($event, clip)"
              @dragend="draggingClipId = ''"
            >
              <span class="hit-area" aria-hidden="true" />
              <div class="segment-face">
                <AssetThumbnail
                  v-if="track.kind !== 'audio' && assetFor(clip)"
                  class="clip-poster"
                  :asset="assetFor(clip)!"
                  :session-id="workspace.state.sessionId"
                />
                <span class="clip-shade" />
                <span class="clip-index">{{ clipNumber(clip.id) }}</span>
                <span class="clip-copy">
                  <strong>{{ assetFor(clip)?.displayName }}</strong>
                  <span
                    class="clip-audio"
                    :class="{
                      muted: assetFor(clip)?.kind === 'image' || clip.muted,
                    }"
                  >
                    <VolumeX
                      v-if="assetFor(clip)?.kind === 'image' || clip.muted"
                      :size="12"
                    />
                    <Volume2 v-else :size="12" />
                    <span>
                      {{
                        assetFor(clip)?.kind === 'image'
                          ? '无原声'
                          : clip.muted
                            ? '已静音'
                            : `${Math.round(clip.volume * 100)}% ${track.kind === 'audio' ? '音量' : '原声'}`
                      }}
                    </span>
                    <span
                      v-if="waveBars(clip).length"
                      class="clip-wave"
                      aria-hidden="true"
                    >
                      <i
                        v-for="(peak, index) in waveBars(clip)"
                        :key="index"
                        :style="{ height: `${Math.round(peak * 100)}%` }"
                      />
                    </span>
                    <span
                      v-else-if="
                        assetFor(clip)?.kind !== 'image' && !clip.muted
                      "
                      class="clip-audio-level"
                      :style="{ width: `${Math.round(clip.volume * 100)}%` }"
                    />
                  </span>
                </span>
              </div>
              <span
                v-if="!readOnly"
                class="trim-handle left"
                @pointerdown="beginTrim($event, clip, 'left')"
              />
              <span
                v-if="!readOnly"
                class="trim-handle right"
                @pointerdown="beginTrim($event, clip, 'right')"
              />
            </div>
          </div>
        </div>
        <div
          class="track-row subtitle-row"
          data-track-kind="subtitle"
          :data-reference-focus="
            referenceFocus?.target.kind === 'subtitle-track' || undefined
          "
        >
          <div class="track-label" data-timeline-subtitles tabindex="0">
            <Captions :size="14" aria-hidden="true" />
            <span>字幕</span>
          </div>
          <div class="lane" @click.self="seek">
            <div
              v-for="cue in layout.subtitles"
              :key="cue.id"
              class="timeline-clip subtitle-clip"
              :class="{
                selected: workspace.state.selectedSubtitleId === cue.id,
              }"
              :style="cueStyle(cue)"
              :data-subtitle-id="cue.id"
              :data-agent-change="changedSubtitles.has(cue.id) || undefined"
              role="button"
              tabindex="0"
              :aria-label="`字幕：${cue.text}`"
              :title="`${cue.text} · ${formatTimecode(cue.start)}–${formatTimecode(cue.end)}`"
              @click.stop="selectSubtitle(cue.id)"
              @keydown.enter="selectSubtitle(cue.id)"
              @pointerdown="beginCueMove($event, cue)"
            >
              <span class="hit-area" aria-hidden="true" />
              <div class="segment-face">
                <span class="subtitle-text">{{ cue.text }}</span>
              </div>
              <span
                v-if="!readOnly"
                class="trim-handle left"
                @pointerdown="beginCueTrim($event, cue, 'left')"
              />
              <span
                v-if="!readOnly"
                class="trim-handle right"
                @pointerdown="beginCueTrim($event, cue, 'right')"
              />
            </div>
            <span v-if="!layout.subtitles.length" class="lane-hint"
              >字幕会显示在这里</span
            >
          </div>
        </div>
        <div
          v-if="referenceFocus?.target.kind === 'range'"
          class="ripple-range"
          data-reference-range
          aria-hidden="true"
          :style="{
            left: `${referenceFocus.start * pixelsPerSecond}px`,
            width: `${(referenceFocus.end - referenceFocus.start) * pixelsPerSecond}px`,
          }"
        />
        <div
          v-if="rippleRange"
          class="ripple-range"
          aria-hidden="true"
          :style="{
            left: `${rippleRange.start * pixelsPerSecond}px`,
            width: `${(rippleRange.end - rippleRange.start) * pixelsPerSecond}px`,
          }"
        />
        <div
          class="playhead"
          aria-hidden="true"
          :style="{ left: `${workspace.state.playhead * pixelsPerSecond}px` }"
        >
          <span data-timeline-playhead @pointerdown="scrubRuler" />
        </div>
        <div
          v-if="
            !project.clips.length &&
            !workspace.motionScenes.value.length &&
            !workspace.visibleMotionWork.value
          "
          class="timeline-empty"
        >
          <Film :size="20" />
          <span>时间线还是空的</span>
          <Button
            v-if="!readOnly"
            type="button"
            size="sm"
            @click="emit('import')"
          >
            <Import :size="14" />导入第一个素材
          </Button>
        </div>
      </div>
    </div>
    <span
      ref="contextAnchor"
      class="timeline-context-anchor"
      :style="{ left: `${contextPoint.x}px`, top: `${contextPoint.y}px` }"
      aria-hidden="true"
    />
    <Menu
      v-model:open="contextOpen"
      :anchor="contextAnchor"
      label="时间线操作"
      align="start"
      dense
    >
      <MenuItem
        data-testid="timeline-add-reference"
        @select="addReference(contextReference)"
      >
        <template #icon><MessageSquareText :size="16" /></template>
        添加到对话
      </MenuItem>
      <MenuItem v-if="contextRange" @select="addReference(contextRange)">
        添加选区到对话
      </MenuItem>
    </Menu>
  </section>
</template>

<style scoped>
.editor-timeline {
  --track-label-width: 128px;
  --track-tint: var(--editor-accent);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-text));
}
.timeline-context-anchor {
  position: fixed;
  width: 1px;
  height: 1px;
  pointer-events: none;
}
.editor-timeline[data-drop-active] {
  box-shadow: inset 0 0 0 1px rgb(var(--editor-accent));
}
.timeline-toolbar {
  background: rgb(var(--editor-panel-raised));
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 42px;
  padding: 0 var(--space-3);
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.timeline-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  white-space: nowrap;
}
.timeline-title strong {
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
}
.timeline-title span {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.timeline-actions {
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
  margin-left: auto;
  align-items: center;
  gap: var(--space-1);
}
.timeline-actions :deep(.ds-button) {
  flex: none;
  white-space: nowrap;
  height: 26px;
  padding: 0 var(--space-2);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.timeline-actions :deep(.ds-button:hover:not(:disabled)) {
  background: rgb(255 255 255 / 0.06);
  color: rgb(var(--editor-text));
}
.timeline-actions :deep(.ds-button:disabled) {
  opacity: 0.3;
}
.timeline-actions :deep(.ds-button.square) {
  justify-content: center;
  width: 26px;
  padding: 0;
}
.toolbar-separator {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: rgb(var(--editor-line));
}
.trim-hint {
  margin-right: var(--space-2);
  color: rgb(var(--editor-muted));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}
.timeline-scroll {
  container-type: inline-size;
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
}
.sequence-content {
  position: relative;
  height: 100%;
  min-height: 170px;
}
.timeline-ruler {
  touch-action: none;
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  height: 28px;
  margin-left: var(--track-label-width);
  border-bottom: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
  cursor: crosshair;
}
.ruler-tick {
  position: absolute;
  top: 0;
  height: 100%;
  padding: var(--space-1) 0 0 var(--space-1);
  border: 0;
  border-left: 0.5px solid rgb(var(--editor-line));
  border-radius: 0;
  background: transparent;
  color: rgb(var(--editor-muted));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  white-space: nowrap;
  pointer-events: none;
}
.ruler-tick:hover {
  background: transparent;
}
.track-row {
  display: flex;
  height: 64px;
}
.media-row {
  height: 68px;
}
.media-row.drop-target .lane {
  box-shadow: inset 0 0 0 1px rgb(var(--editor-accent));
}
.track-label {
  position: sticky;
  left: 0;
  z-index: var(--z-sticky);
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  width: var(--track-label-width);
  padding: 0 var(--space-3);
  border-right: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
[data-track-kind='audio'] {
  --track-tint: var(--editor-audio);
}
[data-track-kind='subtitle'] {
  --track-tint: var(--accent);
}
.track-label > svg {
  color: rgb(var(--track-tint));
  flex: none;
}
.track-label > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-remove {
  margin-left: auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxs);
  cursor: pointer;
}
.track-remove:hover {
  background: rgb(255 255 255 / 0.08);
  color: rgb(var(--editor-text));
}
.lane {
  position: relative;
  flex: 1;
  min-width: 0;
  background: rgb(var(--editor-canvas) / 0.55);
}
.lane::before {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(
    90deg,
    rgb(var(--editor-line) / 0.5) 1px,
    transparent 1px
  );
  background-size: var(--tick-width) 100%;
  content: '';
  pointer-events: none;
}
.timeline-clip {
  position: absolute;
  top: var(--space-1);
  bottom: var(--space-1);
  display: flex;
  align-items: center;
  box-sizing: border-box;
  cursor: grab;
  user-select: none;
}
.hit-area {
  position: absolute;
  inset: 0 var(--hit-right, 0px) 0 var(--hit-left, 0px);
}
.segment-face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgb(var(--track-tint) / 0.7);
  border-radius: var(--r-xs);
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
  cursor: grab;
  user-select: none;
}
.segment-face::after {
  position: absolute;
  inset: 0;
  border-top: 2px solid rgb(var(--track-tint));
  border-radius: inherit;
  pointer-events: none;
  content: '';
}
[data-track-kind='audio'] .segment-face {
  background: color-mix(
    in srgb,
    rgb(var(--track-tint)) 22%,
    rgb(var(--editor-panel))
  );
}
.timeline-clip.selected .segment-face::after {
  box-shadow: inset 0 0 0 2px rgb(var(--track-tint));
}
[data-readonly] .timeline-clip,
[data-readonly] .segment-face {
  cursor: pointer;
}
.timeline-clip[data-agent-change]:not(.selected) .segment-face::after {
  box-shadow: inset 0 0 0 1px rgb(var(--editor-accent));
}
.timeline-clip[data-agent-change]::after {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgb(var(--editor-accent));
  content: '';
}
.track-row[data-reference-focus] .track-label,
.track-row[data-agent-change] .track-label {
  color: rgb(var(--editor-accent));
}
.timeline-clip.dragging {
  opacity: 0.45;
}
.clip-poster {
  position: absolute;
  inset: 0;
  opacity: 0.82;
  pointer-events: none;
}
.clip-poster :deep(video),
.clip-poster :deep(img) {
  object-fit: cover;
}
.clip-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgb(0 0 0 / 0.02) 35%,
    rgb(0 0 0 / 0.72) 100%
  );
  pointer-events: none;
}
.clip-index {
  position: relative;
  z-index: var(--z-base);
  display: grid;
  place-items: center;
  flex: none;
  align-self: stretch;
  width: 20px;
  background: rgb(0 0 0 / 0.34);
  color: rgb(255 255 255);
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}
.clip-copy {
  position: relative;
  z-index: var(--z-base);
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  align-self: flex-end;
  padding: var(--space-1) var(--space-2);
}
.clip-copy strong {
  overflow: hidden;
  color: rgb(255 255 255);
  font-size: var(--fs-xxxs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clip-audio {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  overflow: hidden;
  color: rgb(var(--editor-audio));
  font-size: var(--fs-xxxs);
  white-space: nowrap;
}
.clip-audio.muted {
  color: rgb(255 255 255 / 0.62);
}
.clip-wave {
  display: flex;
  align-items: center;
  gap: var(--space-0-5);
  width: 46px;
  height: 12px;
  overflow: hidden;
}
.clip-wave i {
  display: block;
  flex: 1;
  min-width: 1px;
  border-radius: 0.5px;
  background: rgb(var(--editor-audio));
  opacity: 0.75;
}
.clip-audio-level {
  display: block;
  height: 2px;
  max-width: 42px;
  background: rgb(var(--editor-audio));
  opacity: 0.7;
}
.trim-handle {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  bottom: 0;
  width: min(7px, 22%);
  cursor: ew-resize;
}
.trim-handle:hover {
  background: rgb(var(--editor-accent) / 0.45);
}
.trim-handle.left {
  left: 0;
}
.trim-handle.right {
  right: 0;
}
.subtitle-row {
  height: 40px;
  border-top: 0.5px solid rgb(var(--editor-line) / 0.6);
}
.subtitle-clip {
  top: var(--space-1-5);
  bottom: var(--space-1-5);
}
.subtitle-clip .segment-face {
  background: color-mix(
    in srgb,
    rgb(var(--track-tint)) 18%,
    rgb(var(--editor-panel))
  );
}
.subtitle-text {
  margin: 0 var(--space-2);
  overflow: hidden;
  color: rgb(var(--editor-text));
  font-size: var(--fs-xxxs);
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.lane-hint {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  color: rgb(var(--editor-muted) / 0.7);
  font-size: var(--fs-xxxs);
  transform: translateY(-50%);
  pointer-events: none;
}
.ripple-range {
  position: absolute;
  z-index: var(--z-raised);
  inset-block: 0;
  margin-left: var(--track-label-width);
  box-sizing: border-box;
  border-inline: 0.5px solid rgb(var(--editor-accent) / 0.65);
  background: rgb(var(--editor-accent) / 0.15);
  pointer-events: none;
}
.playhead {
  position: absolute;
  z-index: var(--z-overlay);
  top: 0;
  bottom: 0;
  width: 1px;
  margin-left: var(--track-label-width);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: rgb(var(--editor-accent));
  pointer-events: none;
}
.playhead span {
  touch-action: none;
  cursor: ew-resize;
  position: absolute;
  top: 0;
  left: calc(-1 * var(--space-1));
  width: 9px;
  height: 9px;
  border-radius: var(--r-xs) 2px 5px 5px;
  background: rgb(var(--editor-accent));
  pointer-events: auto;
}
.timeline-empty {
  position: absolute;
  top: 50%;
  left: calc(50% + var(--track-label-width) / 2);
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  transform: translate(-50%, -50%);
  white-space: nowrap;
  pointer-events: none;
}
.timeline-empty :deep(.ds-button) {
  pointer-events: auto;
}
@media (max-width: 1050px) {
  .timeline-title span {
    display: none;
  }
}
</style>
