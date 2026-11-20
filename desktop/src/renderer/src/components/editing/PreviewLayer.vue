<script setup lang="ts">
/** A prepared playback slot. The next slot stays hidden and muted until promoted. */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { VideoAsset, VideoClip } from '@emperor/core/editing'
import {
  editingMediaTarget,
  useMediaAddress,
} from '../workspace/useFileAddress'
import { invokeCore } from '../../api/backend'
import { sourceTimeAt } from './editingViewModel'
import { useEditMediaSource } from './useEditMediaSource'

const props = defineProps<{
  clip: VideoClip
  asset: VideoAsset
  editKey: string
  sessionId: string
  fit: 'contain' | 'cover'
  start: number
  end: number
  playhead: number
  playing: boolean
  playbackInProgress: boolean
  active: boolean
  audioOnly: boolean
  seekRevision: number
  zIndex: number
}>()
const emit = defineEmits<{
  error: [message: string]
  ready: [ready: boolean]
}>()
const element = ref<HTMLMediaElement | null>(null)
const loading = ref(true)
const loadFailed = ref(false)
const source = useEditMediaSource(
  () => ({ sessionId: props.sessionId, asset: props.asset }),
  'playback',
  // Only preserve a source that already has a decoded frame.
  () => props.playbackInProgress && !loading.value,
)
const media = useMediaAddress(() =>
  editingMediaTarget(props.sessionId, source.path.value),
)
const player = crypto.randomUUID()
watch(
  () =>
    [
      props.sessionId,
      source.path.value,
      props.active && props.playing,
    ] as const,
  ([sessionId, path, playing], _previous, onCleanup) => {
    const target = editingMediaTarget(sessionId, path)
    if (!playing || target?.source !== 'cache') return
    const heartbeat = (active: boolean) => {
      void invokeCore('videoProject.cachePlayback', {
        sessionId,
        handle: target.handle,
        player,
        active,
      }).catch(() => undefined)
    }
    heartbeat(true)
    const timer = setInterval(() => heartbeat(true), 30_000)
    onCleanup(() => {
      clearInterval(timer)
      heartbeat(false)
    })
  },
  { immediate: true },
)
const localTime = computed(() =>
  props.active
    ? Math.max(
        0,
        Math.min(props.end - props.start, props.playhead - props.start),
      )
    : 0,
)
const targetTime = computed(() => sourceTimeAt(props.clip, localTime.value))
const transformStyle = computed(() => ({
  objectFit: props.fit,
  transform: `translate(${props.clip.transform.x}%, ${props.clip.transform.y}%) scale(${props.clip.transform.scale})`,
}))
const leadSeconds = 0.13
const startAllowance = 0.05
const firstFrameTimeoutMs = 10_000
let wanted: number | null = null
let pendingPlay: Promise<void> | undefined
let initialized = false
let lastNudge = 0
let warming = false

function preheatTime(): number {
  return Math.max(0, props.clip.sourceIn - props.clip.speed * leadSeconds)
}

function shouldPlay(): boolean {
  return props.active ? props.playing : warming && props.playbackInProgress
}

function ready(value: boolean) {
  loading.value = !value
  if (value) loadFailed.value = false
  emit('ready', value)
}

function failLoad(reason: string) {
  ready(false)
  loadFailed.value = true
  emit('error', `无法加载素材「${props.asset.displayName}」：${reason}`)
}

function applyGain(mediaElement: HTMLMediaElement): void {
  const duration = props.end - props.start
  const fadeIn = Math.min(duration, props.clip.fadeIn ?? 0)
  const fadeOut = Math.min(duration, props.clip.fadeOut ?? 0)
  mediaElement.volume =
    props.clip.volume *
    (fadeIn ? Math.min(1, localTime.value / fadeIn) : 1) *
    (fadeOut ? Math.min(1, (duration - localTime.value) / fadeOut) : 1)
  mediaElement.muted = !props.active || props.clip.muted
}

function settlePosition(): void {
  const mediaElement = element.value
  if (
    !mediaElement ||
    media.state.value !== 'ready' ||
    mediaElement.readyState < 1 ||
    mediaElement.seeking
  )
    return
  if (wanted !== null) {
    const target = wanted
    wanted = null
    if (Math.abs(mediaElement.currentTime - target) > 0.001) {
      mediaElement.currentTime = target
      return
    }
  }
  if (mediaElement.readyState >= 2) {
    ready(true)
    media.loaded()
    void syncPlay()
  }
}

function position(time = props.active ? targetTime.value : preheatTime()) {
  if (props.asset.kind === 'image') return
  const mediaElement = element.value
  if (mediaElement) mediaElement.pause()
  warming = false
  wanted = time
  initialized = true
  ready(false)
  settlePosition()
}

async function syncPlay() {
  const mediaElement = element.value
  if (!mediaElement) return
  applyGain(mediaElement)
  if (!shouldPlay()) {
    if (!mediaElement.paused) mediaElement.pause()
    return
  }
  if (
    loading.value ||
    !mediaElement.paused ||
    mediaElement.ended ||
    pendingPlay
  )
    return
  mediaElement.playbackRate = props.clip.speed
  let interrupted = false
  try {
    pendingPlay = mediaElement.play()
    await pendingPlay
    if (!shouldPlay()) mediaElement.pause()
  } catch (error) {
    interrupted = (error as { name?: string }).name === 'AbortError'
    if (
      !interrupted &&
      element.value === mediaElement &&
      props.active &&
      props.playing
    )
      emit('error', error instanceof Error ? error.message : String(error))
  } finally {
    pendingPlay = undefined
    // A new playback request may have arrived while a paused promise settled.
    if (interrupted && element.value === mediaElement && shouldPlay())
      void syncPlay()
  }
}

function warmStandby(remaining: number): void {
  const elementNow = element.value
  if (
    props.active ||
    warming ||
    loading.value ||
    !elementNow ||
    !props.playbackInProgress
  )
    return
  const lead = (props.clip.sourceIn - elementNow.currentTime) / props.clip.speed
  if (remaining > Math.max(0.012, lead + startAllowance)) return
  warming = true
  void syncPlay()
}

function alignForCut(): void {
  const elementNow = element.value
  if (props.active || loading.value || !elementNow) return
  const distance =
    (elementNow.currentTime - props.clip.sourceIn) / props.clip.speed
  if (distance < -0.016 || distance > 0.024) position(props.clip.sourceIn)
}

function clockTime(): number | null {
  const mediaElement = element.value
  if (!props.active || !mediaElement || loading.value || mediaElement.seeking)
    return null
  if (mediaElement.ended) return props.end
  if (mediaElement.paused) return null
  return (
    props.start +
    (mediaElement.currentTime - props.clip.sourceIn) / props.clip.speed
  )
}

function applyDrift(master: boolean): void {
  const mediaElement = element.value
  const clock = clockTime()
  if (!mediaElement || !props.playing || clock === null) return
  if (master) {
    if (mediaElement.playbackRate !== props.clip.speed)
      mediaElement.playbackRate = props.clip.speed
    return
  }
  const difference = props.playhead - clock
  if (Math.abs(difference) > 0.25 && performance.now() - lastNudge > 500) {
    lastNudge = performance.now()
    position()
  } else {
    const correction =
      Math.abs(difference) < 0.018
        ? 0
        : Math.max(-0.07, Math.min(0.07, difference * 0.8))
    mediaElement.playbackRate = Math.max(
      0.0625,
      props.clip.speed * (1 + correction),
    )
  }
}

function onLoaded() {
  if (!initialized) position()
  else settlePosition()
}

function onWaiting() {
  if (element.value && element.value.readyState < 2 && !loadFailed.value)
    ready(false)
}

async function onError() {
  const failedUrl = media.url.value
  if ((await media.failed()) || failedUrl !== media.url.value) return
  if (source.recover()) return
  failLoad(media.failure.value || '文件或编码不可用')
}

watch(
  () => media.url.value,
  () => {
    initialized = false
    wanted = null
    loadFailed.value = false
    ready(false)
  },
)
watch(
  [loading, loadFailed, source.pending, source.path, media.url],
  ([waiting, failed, preparing, path], _, onCleanup) => {
    if (!waiting || failed || preparing || !path) return
    const timer = setTimeout(() => {
      if (!source.recover()) failLoad('读取预览超时，请检查素材后重试')
    }, firstFrameTimeoutMs)
    onCleanup(() => clearTimeout(timer))
  },
  { immediate: true },
)
watch(
  () => [props.seekRevision, props.editKey],
  () => {
    if (props.asset.kind === 'image') {
      if (props.editKey && !loading.value) ready(true)
      return
    }
    position()
  },
)
watch(
  () => [
    props.active,
    props.playing,
    props.playbackInProgress,
    props.clip.id,
    props.clip.volume,
    props.clip.muted,
    props.clip.speed,
  ],
  () => {
    if (!props.active && !props.playbackInProgress && warming) position()
    else void syncPlay()
  },
)
watch(
  () => props.playhead,
  () => {
    if (
      element.value &&
      props.active &&
      (props.clip.fadeIn || props.clip.fadeOut)
    ) {
      applyGain(element.value)
    }
  },
)
watch(
  () => [media.state.value, source.failure.value],
  ([state, problem]) => {
    if (problem || state === 'missing' || state === 'failed') {
      ready(false)
      if (
        !problem &&
        source.path.value &&
        source.path.value !== props.asset.path &&
        source.recover()
      )
        return
      failLoad(problem || media.failure.value)
    }
  },
)
watch(
  () => props.active,
  (active) => {
    if (!active) return
    void nextTick(() => {
      // A prepared adjacent clip already sits at its in-point. A direct seek
      // into the middle of a newly activated slot still needs positioning.
      if (!element.value || !initialized || props.playing) return
      if (Math.abs(element.value.currentTime - targetTime.value) > 0.06)
        position()
    })
  },
)
onBeforeUnmount(() => {
  element.value?.pause()
})
defineExpose({ clockTime, applyDrift, warmStandby, alignForCut })
</script>

<template>
  <div
    class="preview-layer"
    :data-preview-active="active"
    :data-preview-proxy="
      Boolean(source.path.value && source.path.value !== asset.path)
    "
    :style="{ zIndex }"
  >
    <audio
      v-if="(audioOnly || asset.kind === 'audio') && media.url.value"
      ref="element"
      :src="media.url.value"
      preload="auto"
      @loadedmetadata="onLoaded"
      @loadeddata="onLoaded"
      @seeked="settlePosition"
      @canplay="settlePosition"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @error="onError"
    />
    <video
      v-else-if="asset.kind === 'video' && media.url.value"
      ref="element"
      :src="media.url.value"
      crossorigin="anonymous"
      :style="transformStyle"
      preload="auto"
      playsinline
      @loadedmetadata="onLoaded"
      @loadeddata="onLoaded"
      @seeked="settlePosition"
      @canplay="settlePosition"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @error="onError"
    />
    <img
      v-else-if="asset.kind === 'image' && media.url.value"
      :src="media.url.value"
      :alt="asset.displayName"
      crossorigin="anonymous"
      :style="transformStyle"
      @load="ready(true)"
      @error="onError"
    />
    <span v-if="active && loading && !loadFailed" class="layer-status"
      >{{ source.pending.value ? '正在准备预览' : '正在加载' }}
      {{ asset.displayName }}</span
    >
  </div>
</template>

<style scoped>
.layer-status {
  position: absolute;
  inset: auto auto 8px 8px;
  background: #000b;
  color: white;
  padding: 2px 6px;
  font-size: var(--fs-xxs);
}
.preview-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.preview-layer[data-preview-active='false'] {
  opacity: 0;
}
.preview-layer video,
.preview-layer img {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: center;
}
</style>
