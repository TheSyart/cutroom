<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue'
import type { MotionScene } from '@emperor/core/editing'
import { renderMotionFrame } from './motionFrame'

const props = defineProps<{
  scene: MotionScene
  frame: number
  width: number
  seq?: number
  validatedFrame?: number
  seekRevision?: number
}>()
const source = shallowRef<{
  url: string
  seq?: number
  frame: number
  version: number
} | null>(null)
const loadedSeq = ref<number>()
const failed = ref('')
let ticket = 0
let pending = false
let busy = false
let scheduled = 0
let disposed = false
let firstFrame: number | undefined

// A decoder may lag playback. Finish one frame, then draw the newest request.
function schedule(): void {
  pending = true
  if (!busy && !scheduled && !disposed) scheduled = requestAnimationFrame(draw)
}
async function draw(): Promise<void> {
  scheduled = 0
  busy = true
  pending = false
  const { scene, width, seq } = props
  // Start with the already validated bitmap even when the audition clock
  // has advanced a frame while the previous version finished rendering.
  const frame = firstFrame ?? props.frame
  firstFrame = undefined
  if (frame !== props.frame) pending = true
  const epoch = ticket
  try {
    const url = await renderMotionFrame(toRaw(scene), frame, width)
    if (disposed || epoch !== ticket) return
    const img = new Image()
    img.src = url
    await img.decode()
    if (disposed || epoch !== ticket) return
    failed.value = ''
    // A repeated bitmap can represent a new (identical) version or frame.
    loadedSeq.value = source.value?.url === url ? seq : undefined
    source.value = { url, frame, seq, version: scene.version }
  } catch (cause) {
    if (!disposed && epoch === ticket) {
      source.value = null
      failed.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    busy = false
    if (pending && !disposed) schedule()
  }
}
function loaded(event: Event): void {
  const img = event.currentTarget as HTMLImageElement
  if (source.value && img.currentSrc === source.value.url)
    loadedSeq.value = source.value.seq
}
watch(
  () =>
    [
      props.scene,
      props.seq,
      props.seekRevision,
      props.width,
      props.validatedFrame,
    ] as const,
  (current, previous) => {
    firstFrame = current[1] !== previous?.[1] ? props.validatedFrame : undefined
    ticket++
    schedule()
  },
  { immediate: true, flush: 'pre' },
)
watch(
  () => props.seq,
  (seq, previous) => {
    if (seq === undefined && previous !== undefined) {
      source.value = null
      loadedSeq.value = undefined
    }
  },
  { flush: 'sync' },
)
watch(() => props.frame, schedule, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  if (scheduled) cancelAnimationFrame(scheduled)
})
</script>

<template>
  <span class="motion-image" :title="failed || undefined">
    <img
      v-if="source"
      :src="source.url"
      alt=""
      draggable="false"
      :data-motion-frame="source.frame"
      :data-motion-version="source.version"
      :data-motion-seq="loadedSeq"
      @load="loaded"
    />
    <small v-else-if="failed" role="alert">动效帧生成失败</small>
  </span>
</template>

<style scoped>
.motion-image,
img {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
img {
  object-fit: contain;
}
small {
  color: rgb(var(--error));
}
</style>
