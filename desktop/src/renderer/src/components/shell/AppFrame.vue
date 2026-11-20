<script setup lang="ts">
/**
 * Two-column shell frame for the retained legacy routes: center | workspace.
 * The product itself is the full-window editor; this frame exists so old
 * chat deep links keep their Files/Terminal/Browser pane without bringing
 * back the application sidebar.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CENTER_MIN_CHAT, computeColumnsWithoutSidebar } from './columns'
import { frameActions, useFrameState } from './frameState'

const props = withDefaults(
  defineProps<{
    workspaceAvailable?: boolean
    centerMin?: number
    /** Fill a flex parent instead of the viewport (legacy chrome). */
    fill?: boolean
  }>(),
  { workspaceAvailable: true, centerMin: CENTER_MIN_CHAT, fill: false },
)

const frame = useFrameState()
const root = ref<HTMLElement | null>(null)
const viewport = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
const dragging = ref(false)

const columns = computed(() =>
  computeColumnsWithoutSidebar(
    viewport.value,
    props.workspaceAvailable ? frame.workspace : 0,
    props.centerMin,
  ),
)
const gridStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, 1fr) ${columns.value.workspace}px`,
}))

let observer: ResizeObserver | null = null
let resizeFrame: number | null = null

function measure(): void {
  const width = root.value?.getBoundingClientRect().width ?? 0
  if (width > 0) viewport.value = width
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined' || !root.value) return
  observer = new ResizeObserver(() => {
    resizeFrame ??= requestAnimationFrame(() => {
      resizeFrame = null
      measure()
    })
  })
  observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
})

let origin = 0
let latest = 0
let base = 0
let dragFrame: number | null = null

function applyDrag(): void {
  frameActions.setWorkspace(frame, base - (latest - origin))
}

function onPointerDown(event: PointerEvent) {
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  origin = event.clientX
  latest = event.clientX
  base = columns.value.workspace
  dragging.value = true
}

function onPointerMove(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  if (!dragging.value || !target.hasPointerCapture(event.pointerId)) return
  latest = event.clientX
  dragFrame ??= requestAnimationFrame(() => {
    dragFrame = null
    applyDrag()
  })
}

function onPointerUp(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  if (!target.hasPointerCapture(event.pointerId)) return
  target.releasePointerCapture(event.pointerId)
  if (dragFrame !== null) {
    cancelAnimationFrame(dragFrame)
    dragFrame = null
  }
  applyDrag()
  dragging.value = false
}

function onHandleKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    frameActions.setWorkspace(frame, columns.value.workspace + step)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    frameActions.setWorkspace(frame, columns.value.workspace - step)
  }
}
</script>

<template>
  <div
    ref="root"
    class="app-frame"
    :style="gridStyle"
    :data-workspace-collapsed="columns.workspace === 0 || undefined"
    :data-dragging="dragging || undefined"
    :data-fill="fill || undefined"
  >
    <main class="center-col">
      <slot />
    </main>
    <div
      class="workspace-col"
      :aria-hidden="columns.workspace === 0 || undefined"
      :inert="columns.workspace === 0 || undefined"
    >
      <slot name="workspace" :open="columns.workspace > 0" />
    </div>
    <div
      v-if="columns.workspace > 0"
      class="handle"
      data-side="workspace"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整工作台宽度"
      tabindex="0"
      :style="{ left: `${viewport - columns.workspace}px` }"
      :data-dragging="dragging || undefined"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onHandleKeydown"
    />
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.app-frame {
  position: relative;
  display: grid;
  grid-template-rows: 100%;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  background: rgb(var(--surface-base));
}
.app-frame[data-fill] {
  height: 100%;
}
.app-frame[data-dragging] {
  cursor: col-resize;
  user-select: none;
}
.center-col,
.workspace-col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.workspace-col {
  border-left: 0.5px solid var(--stroke-1);
  background: rgb(var(--surface-base));
}
.handle {
  position: absolute;
  top: 0;
  z-index: var(--z-raised);
  width: 5px;
  height: 100%;
  margin-left: -2px;
  cursor: col-resize;
  touch-action: none;
}
.handle:hover,
.handle[data-dragging] {
  background: rgb(var(--accent) / 0.35);
}
.handle:focus-visible {
  outline: 2px solid rgb(var(--focus-ring) / 0.55);
  outline-offset: -2px;
}
</style>
