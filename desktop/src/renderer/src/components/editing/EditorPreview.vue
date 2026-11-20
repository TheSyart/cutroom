<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-vue-next'
import {
  subtitleCueAt,
  motionFrameAt,
  MOTION_FPS,
  zoomViewport,
  captionLayout,
  resolveCaptionStyle,
  CAPTION_WIDTH,
  CAPTION_SAFE_Y,
  CAPTION_FONT,
} from '@emperor/core/editing'
import type { VideoAsset, VideoClip, VideoTrack } from '@emperor/core/editing'
import Button from '../ui/Button.vue'
import LinkButton from '../ui/LinkButton.vue'
import RangeInput from '../ui/RangeInput.vue'
import { formatTimecode } from './editingViewModel'
import MotionImage from './MotionImage.vue'
import { capturePreviewFrame } from './capturePreviewFrame'
import PreviewLayer from './PreviewLayer.vue'
import { useEditingWorkspace } from './editingStore'

const workspace = useEditingWorkspace()
const failure = ref('')
const project = workspace.displayProject
const layout = workspace.layout
const total = computed(() => layout.value.totalDuration)
const assetsById = computed(
  () => new Map(project.value?.assets.map((asset) => [asset.id, asset])),
)
type Layer = {
  key: string
  slot: string
  clip: VideoClip
  start: number
  end: number
  asset: VideoAsset
  track: VideoTrack
}
const tracks = computed(() =>
  layout.value.tracks.map(({ track, clips }) => {
    const layers: Layer[] = []
    let index = -1
    for (const entry of clips) {
      const clip = project.value?.clips[entry.index]
      const asset = clip && assetsById.value.get(clip.assetId)
      if (!clip || !asset) continue
      const previous = layers.at(-1)
      const continuous =
        previous &&
        previous.asset.id === asset.id &&
        previous.clip.speed === clip.speed &&
        Math.abs(previous.end - entry.start) < 0.00001 &&
        Math.abs(previous.clip.sourceOut - clip.sourceIn) < 0.00001
      const key = continuous
        ? previous.key
        : JSON.stringify([
            track.id,
            clip.id,
            asset.path,
            clip.sourceIn,
            clip.speed,
          ])
      if (!continuous) index++
      const slot = JSON.stringify([track.id, index % 2])
      layers.push({ ...entry, key, slot, clip, asset, track })
    }
    return layers
  }),
)
function selectLayers(time: number) {
  return tracks.value.map((layers) => {
    let lo = 0
    let hi = layers.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (layers[mid]!.start <= time + 1e-7) lo = mid + 1
      else hi = mid
    }
    const candidate = layers[lo - 1]
    const active =
      candidate && time < candidate.end - 1e-7 ? candidate : undefined
    return { active, upcoming: layers[lo], layers, index: lo }
  })
}
const selections = computed(() =>
  selectLayers(
    Math.min(workspace.state.playhead, Math.max(0, total.value - 0.001)),
  ),
)
const slots = computed(() =>
  selections.value.flatMap(({ active, layers, index }) => {
    let upcoming = index
    while (active && layers[upcoming]?.key === active.key) upcoming++
    const next = layers[upcoming]
    return [
      ...(active ? [{ ...active, active: true }] : []),
      ...(next ? [{ ...next, active: false }] : []),
    ]
  }),
)
const readySlots = new Map<string, string>()
const slotErrors = new Map<string, { key: string; message: string }>()
type Player = Pick<
  InstanceType<typeof PreviewLayer>,
  'clockTime' | 'applyDrift' | 'warmStandby' | 'alignForCut'
>
const players = new Map<string, Player>()
function setPlayer(key: string, player: unknown) {
  if (player) players.set(key, player as Player)
  else {
    players.delete(key)
    readySlots.delete(key)
    slotErrors.delete(key)
  }
}
function slotReady(layer: Layer, ready: boolean, active: boolean) {
  if (ready) {
    readySlots.set(layer.slot, layer.key)
    slotErrors.delete(layer.slot)
    if (
      active &&
      selections.value.every(({ active }) => !active || !errorFor(active))
    )
      failure.value = ''
  } else readySlots.delete(layer.slot)
}
function slotError(layer: Layer, error: string, active: boolean) {
  slotErrors.set(layer.slot, { key: layer.key, message: error })
  if (active) onLayerError(error)
}
const activeSubtitle = computed(() =>
  project.value ? subtitleCueAt(project.value, workspace.state.playhead) : null,
)
const annotations = computed(() =>
  (project.value?.annotations ?? []).filter(
    (a) =>
      workspace.state.playhead >= a.start && workspace.state.playhead < a.end,
  ),
)
const zoomStyle = computed(() => {
  const zoom = annotations.value.find((a) => a.kind === 'zoom')
  if (!zoom) return {}
  const v = zoomViewport(zoom)
  return {
    transformOrigin: 'top left',
    transform: `scale(${1 / v.size}) translate(-${v.x * 100}%, -${v.y * 100}%)`,
  }
})
const caption = computed(() => {
  const cue = activeSubtitle.value
  if (!cue) return null
  const style = resolveCaptionStyle(project.value?.captionStyle)
  const box = captionLayout(cue.text, style)
  const cqw = (pixels: number) => `${(100 * pixels) / CAPTION_WIDTH}cqw`
  return {
    text: box.lines.join('\n'),
    style: {
      color: style.color,
      fontFamily: `"${CAPTION_FONT}", sans-serif`,
      fontSize: cqw(style.fontSize),
      top: style.position === 'top' ? cqw(CAPTION_SAFE_Y) : 'auto',
      bottom: style.position === 'bottom' ? cqw(CAPTION_SAFE_Y) : 'auto',
      WebkitTextStroke: `${cqw(style.outlineWidth)} ${style.outlineColor}`,
    },
    box:
      style.backgroundOpacity > 0
        ? {
            minWidth: cqw(box.width),
            paddingBlock: cqw(box.paddingY),
            backgroundColor: `color-mix(in srgb, ${style.backgroundColor} ${style.backgroundOpacity * 100}%, transparent)`,
          }
        : undefined,
  }
})
const motions = computed(() => {
  const time = Math.min(
    workspace.state.playhead,
    Math.max(0, total.value - 0.00001),
  )
  return workspace.motionScenes.value.flatMap((scene) => {
    const frame = motionFrameAt(scene, time)
    const work = workspace.visibleMotionWork.value
    const validatedFrame =
      workspace.state.motionFollow &&
      work?.scene?.id === scene.id &&
      work.frame !== undefined
        ? (motionFrameAt(scene, work.frame / MOTION_FPS) ?? undefined)
        : undefined
    return frame === null ? [] : [{ scene, frame, validatedFrame }]
  })
})
const highlight = computed(() => {
  const scene = motions.value.find(
    ({ scene }) => scene.id === workspace.state.selectedMotionSceneId,
  )?.scene
  const objectId =
    workspace.state.selectedMotionObjectId ??
    (workspace.state.motionCue?.sceneId === scene?.id
      ? workspace.state.motionCue?.objectId
      : undefined)
  const obj = scene?.objects.find((obj) => obj.id === objectId)
  if (!obj) return null
  const { x, y, width, height } = obj.bounds
  return {
    id: obj.id,
    style: {
      left: (x / 1920) * 100 + '%',
      top: (y / 1080) * 100 + '%',
      width: (width / 1920) * 100 + '%',
      height: (height / 1080) * 100 + '%',
    },
  }
})
const hasContent = computed(() =>
  Boolean(
    project.value?.clips.length ||
    project.value?.subtitles.length ||
    workspace.motionScenes.value.length,
  ),
)
const buffering = ref(false)
let frameId: number | null = null
let previousFrame: number | null = null
let heldBoundary: number | null = null

function cancelFrame(): void {
  if (frameId !== null) cancelAnimationFrame(frameId)
  frameId = null
  previousFrame = null
}
function startFrame(): void {
  cancelFrame()
  heldBoundary = null
  buffering.value = false
  frameId = requestAnimationFrame(onFrame)
}

function firstUnready(
  layers: ReturnType<typeof selectLayers>,
): Layer | undefined {
  return layers
    .map(({ active }) => active)
    .find((layer) => layer && readySlots.get(layer.slot) !== layer.key)
}
function errorFor(layer: Layer): string | undefined {
  const error = slotErrors.get(layer.slot)
  return error?.key === layer.key ? error.message : undefined
}

function onFrame(now: number): void {
  frameId = null
  if (!workspace.state.playing) return
  const elapsed = previousFrame === null ? 0 : (now - previousFrame) / 1000
  previousFrame = now
  if (heldBoundary !== null) {
    const incoming = selectLayers(heldBoundary)
    for (const { active } of incoming)
      if (active) players.get(active.slot)?.alignForCut()
    const missing = firstUnready(incoming)
    if (missing) {
      const error = errorFor(missing)
      if (error) {
        onLayerError(error)
        return
      }
      frameId = requestAnimationFrame(onFrame)
      return
    }
    workspace.reportPlayhead(heldBoundary)
    heldBoundary = null
    buffering.value = false
    frameId = requestAnimationFrame(onFrame)
    return
  }
  const waiting = firstUnready(selections.value)
  if (waiting) {
    const error = errorFor(waiting)
    if (error) {
      onLayerError(error)
      return
    }
    buffering.value = true
    frameId = requestAnimationFrame(onFrame)
    return
  }
  buffering.value = false
  const current = workspace.state.playhead
  const moving = selections.value.flatMap(({ active }) =>
    active && active.asset.kind !== 'image' ? [active] : [],
  )
  const master =
    moving.find((layer) => !layer.clip.muted && layer.track.kind === 'audio') ??
    moving.find((layer) => layer.track.index === 0) ??
    moving[0]
  const decodedTime = master && players.get(master.slot)?.clockTime()
  const candidate = master
    ? Math.max(current, decodedTime ?? current)
    : current + elapsed
  const auditionEnd = workspace.state.auditionEnd
  if (auditionEnd !== null && candidate >= auditionEnd) {
    workspace.reportPlayhead(auditionEnd)
    workspace.stopAudition()
    return
  }
  for (const { active, upcoming } of selections.value)
    if (
      upcoming &&
      upcoming.key !== active?.key &&
      upcoming.start !== total.value
    )
      players.get(upcoming.slot)?.warmStandby(upcoming.start - candidate)
  const boundary = Math.min(
    total.value,
    ...selections.value.flatMap(({ active, upcoming }) =>
      [active?.end, upcoming?.start].filter(
        (time): time is number => time !== undefined && time > current + 1e-7,
      ),
    ),
  )
  if (candidate >= boundary - 0.0001) {
    if (boundary >= total.value - 0.0001) {
      workspace.reportPlayhead(total.value)
      workspace.state.playing = false
      return
    }
    const incoming = selectLayers(boundary)
    for (const { active } of incoming)
      if (active) players.get(active.slot)?.alignForCut()
    const missing = firstUnready(incoming)
    if (missing) {
      const error = errorFor(missing)
      if (error) {
        onLayerError(error)
        return
      }
      heldBoundary = boundary
      buffering.value = true
      workspace.reportPlayhead(Math.max(current, boundary - 0.00001))
    } else workspace.reportPlayhead(boundary)
  } else {
    workspace.reportPlayhead(candidate)
    for (const layer of moving)
      players.get(layer.slot)?.applyDrift(layer === master)
  }
  frameId = requestAnimationFrame(onFrame)
}

function togglePlayback(): void {
  failure.value = ''
  const playing = workspace.state.playing
  workspace.takeMotionControl()
  if (playing) {
    workspace.state.playing = false
    cancelFrame()
    heldBoundary = null
    buffering.value = false
    return
  }
  if (!hasContent.value) return
  if (workspace.state.playhead >= total.value - 0.001) workspace.setPlayhead(0)
  workspace.state.playing = true
}

function stepFrame(delta: number): void {
  workspace.state.playing = false
  workspace.setPlayhead(
    (Math.floor(workspace.state.playhead * MOTION_FPS + 1e-8) + delta) /
      MOTION_FPS,
  )
}

function seek(event: Event): void {
  workspace.setPlayhead(Number((event.target as HTMLInputElement).value))
}

function onLayerError(message: string): void {
  workspace.state.playing = false
  cancelFrame()
  failure.value = message
  buffering.value = false
  heldBoundary = null
}

watch(
  () => workspace.state.playing,
  (playing) => {
    if (playing) startFrame()
    else {
      cancelFrame()
      heldBoundary = null
      buffering.value = false
    }
  },
)
watch(
  () => workspace.state.seekRevision,
  () => {
    failure.value = ''
    if (workspace.state.playing) startFrame()
  },
)
onBeforeUnmount(() => {
  workspace.state.playing = false
  cancelFrame()
})
const monitor = ref<HTMLElement | null>(null)
function captureFrame() {
  if (!monitor.value || !hasContent.value)
    throw new Error('请先添加可预览的画面。')
  return capturePreviewFrame(monitor.value, workspace.state.playhead)
}
defineExpose({ togglePlayback, captureFrame })
</script>

<template>
  <section class="program-monitor" aria-label="节目预览">
    <header class="monitor-heading">
      <strong>播放器</strong>
      <LinkButton
        v-if="workspace.activeMotion.value"
        type="button"
        class="follow"
        data-testid="motion-follow"
        :aria-pressed="workspace.state.motionFollow"
        @click="
          workspace.state.motionFollow
            ? workspace.takeMotionControl()
            : workspace.resumeMotionFollow()
        "
      >
        {{ workspace.state.motionFollow ? '正在跟随绘制' : '跟随绘制' }}
      </LinkButton>
      <span>{{ workspace.readOnly.value ? 'Agent 草稿' : '当前工程' }}</span>
    </header>
    <div class="monitor-stage">
      <div
        ref="monitor"
        class="monitor-canvas"
        :style="project ? { background: project.canvas.background } : undefined"
      >
        <div class="picture-stack" :style="zoomStyle">
          <PreviewLayer
            v-for="layer in slots"
            :key="layer.slot"
            :ref="(player) => setPlayer(layer.slot, player)"
            :edit-key="layer.key"
            :clip="layer.clip"
            :asset="layer.asset"
            :session-id="workspace.state.sessionId"
            :fit="project?.canvas.fit ?? 'contain'"
            :start="layer.start"
            :end="layer.end"
            :playhead="workspace.state.playhead"
            :playing="workspace.state.playing && !buffering"
            :playback-in-progress="workspace.state.playing"
            :active="layer.active"
            :audio-only="layer.track.kind === 'audio'"
            :seek-revision="workspace.state.seekRevision"
            :z-index="layer.track.index + 1"
            @ready="slotReady(layer, $event, layer.active)"
            @error="slotError(layer, $event, layer.active)"
          />
        </div>
        <div class="motion-stack" :key="workspace.state.view">
          <MotionImage
            v-for="{ scene, frame, validatedFrame } in motions"
            :key="scene.id"
            data-testid="motion-preview"
            :data-scene-id="scene.id"
            :scene="scene"
            :frame="frame"
            :validated-frame="validatedFrame"
            :width="640"
            :seek-revision="workspace.state.seekRevision"
            :seq="
              workspace.visibleMotionWork.value?.scene?.id === scene.id
                ? workspace.visibleMotionWork.value.seq
                : undefined
            "
          />
          <div
            v-if="highlight"
            class="motion-highlight"
            data-testid="motion-highlight"
            :data-object-id="highlight.id"
            :style="highlight.style"
          />
        </div>
        <div
          v-for="a in annotations.filter((a) => a.kind === 'box')"
          :key="a.id"
          class="annotation-box"
          :style="{
            left: a.x * 100 + '%',
            top: a.y * 100 + '%',
            width: a.width * 100 + '%',
            height: a.height * 100 + '%',
            borderColor: a.color,
          }"
        />
        <div
          v-if="caption"
          :style="caption.style"
          class="subtitle-overlay"
          role="status"
        >
          <span :style="caption.box">{{ caption.text }}</span>
        </div>
        <div v-if="!hasContent" class="monitor-empty">
          <Clapperboard :size="20" stroke-width="1.4" />
          <strong>{{
            workspace.readOnly.value ? '草稿时间线为空' : '从素材开始你的第一剪'
          }}</strong>
          <span v-if="!workspace.readOnly.value"
            >导入视频、音频或图片，再添加到时间线</span
          >
        </div>
        <div v-if="failure" class="media-error" role="alert">{{ failure }}</div>
      </div>
    </div>
    <div class="playback-bar">
      <Button
        type="button"
        class="icon-button"
        aria-label="回到开头"
        :disabled="!hasContent"
        @click="workspace.setPlayhead(0)"
      >
        <RotateCcw :size="16" />
      </Button>
      <Button
        type="button"
        class="play-button"
        :aria-label="workspace.state.playing ? '暂停' : '播放'"
        :disabled="!hasContent"
        @click="togglePlayback"
      >
        <Pause v-if="workspace.state.playing" :size="16" fill="currentColor" />
        <Play v-else :size="16" fill="currentColor" />
      </Button>
      <template v-if="workspace.motionScenes.value.length">
        <Button
          type="button"
          class="icon-button frame-step"
          aria-label="上一帧"
          data-testid="motion-step-back"
          @click="stepFrame(-1)"
        >
          <ChevronLeft :size="14" />
        </Button>
        <Button
          type="button"
          class="icon-button frame-step"
          aria-label="下一帧"
          data-testid="motion-step-forward"
          @click="stepFrame(1)"
        >
          <ChevronRight :size="14" />
        </Button>
      </template>
      <span class="time-readout current">{{
        formatTimecode(workspace.state.playhead)
      }}</span>
      <RangeInput
        tone="editor"
        class="playback-scrubber"
        aria-label="播放位置"
        type="range"
        min="0"
        :max="Math.max(0.01, total)"
        step="0.01"
        :value="workspace.state.playhead"
        :disabled="!hasContent"
        @pointerdown="workspace.takeMotionControl"
        @input="seek"
      />
      <span class="time-readout">{{ formatTimecode(total) }}</span>
      <span class="fit-label">{{
        project?.canvas.fit === 'cover' ? '填满' : '适应'
      }}</span>
    </div>
  </section>
</template>

<style scoped>
.program-monitor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--editor-canvas));
}
.monitor-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  height: 39px;
  padding-inline: var(--space-3);
  border-bottom: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
  font: var(--font-xxs);
}
.monitor-heading span {
  color: rgb(var(--editor-muted));
}
.monitor-stage {
  display: grid;
  flex: 1;
  container-type: size;
  place-items: center;
  min-height: 0;
  background: rgb(17 16 15);
  overflow: hidden;
}
.monitor-canvas {
  container-type: inline-size;
  position: relative;
  width: min(100cqw, calc(100cqh * 16 / 9));
  overflow: hidden;
  border: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-canvas));
  border-radius: 2px;

  aspect-ratio: 16/9;
}
.picture-stack {
  z-index: var(--z-base);
  position: absolute;
  inset: 0;
}
.motion-stack {
  position: absolute;
  inset: 0;
  z-index: var(--z-base);
  pointer-events: none;
}
.motion-stack > .motion-image {
  position: absolute;
  inset: 0;
}
.motion-highlight {
  position: absolute;
  box-sizing: border-box;
  border: 1px dashed rgb(var(--editor-accent));
}
.follow {
  border: 0;
  border-radius: var(--r-sm);
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-text));
  font: inherit;
  cursor: pointer;
}
.annotation-box {
  z-index: var(--z-raised);
  position: absolute;
  border: 0.26cqw solid;
  box-sizing: border-box;
}
.subtitle-overlay {
  position: absolute;
  right: 8%;
  bottom: 7%;
  left: 8%;
  z-index: var(--z-overlay);
  display: flex;
  justify-content: center;
  color: rgb(255 255 255);
  font-size: clamp(14px, 2.1vw, 26px);
  font-weight: var(--weight-regular);
  line-height: 1.16;
  paint-order: stroke fill;
  text-align: center;
  white-space: pre;
  pointer-events: none;
}
.subtitle-overlay span {
  display: block;
  max-width: 100%;
}
.monitor-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2-5);
  background: radial-gradient(
    circle at 50% 40%,
    rgb(var(--editor-panel-raised)),
    rgb(var(--editor-canvas)) 70%
  );
  color: rgb(var(--editor-muted));
}
.monitor-empty strong {
  margin-top: var(--space-1-5);
  color: rgb(var(--editor-text));
  font-size: var(--fs-s);
  font-weight: var(--weight-medium);
}
.monitor-empty span {
  font-size: var(--fs-xxxs);
}
.media-error {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  left: var(--space-3);
  z-index: var(--z-overlay);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-sm);
  background: rgb(var(--error-soft) / 0.96);
  color: rgb(var(--error));
  font-size: var(--fs-xxxs);
  text-align: center;
}
.playback-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2-5);
  height: 52px;
  padding: 0 var(--space-5);
  border-top: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
}
.icon-button,
.play-button {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgb(var(--editor-muted));
  cursor: pointer;
}
.play-button {
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
  box-shadow: var(--elev-1);
}
.icon-button:hover:not(:disabled),
.play-button:hover:not(:disabled) {
  background: var(--surface-hover);
}
button:disabled {
  opacity: 0.35;
  cursor: default;
}
.frame-step {
  width: 18px;
  height: 22px;
}
.time-readout {
  min-width: 60px;
  color: rgb(var(--editor-muted));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  text-align: right;
}
.time-readout.current {
  color: rgb(var(--editor-text));
  text-align: left;
}
.playback-scrubber {
  flex: 1;
  min-width: 40px;
  accent-color: rgb(var(--editor-accent));
}
.fit-label {
  padding: var(--space-0-5) var(--space-2);
  border: 0.5px solid var(--stroke-1);
  border-radius: var(--r-sm);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
</style>
