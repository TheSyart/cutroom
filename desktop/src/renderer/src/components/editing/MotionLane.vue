<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Box,
  ChevronDown,
  ChevronRight,
  Link2,
  MessageSquareText,
  Spline,
} from 'lucide-vue-next'
import {
  clipTimelineDuration,
  clipContainsAnchor,
  MOTION_FPS,
  motionFrameAt,
  motionTimelineFrame,
  type MotionScene,
  type VideoClip,
} from '@emperor/core/editing'
import { formatTimecode, timelineHitInsets } from './editingViewModel'
import {
  useEditingWorkspace,
  type TimelineReferenceTarget,
} from './editingStore'
import LinkButton from '../ui/LinkButton.vue'
import Select from '../ui/Select.vue'
import MotionImage from './MotionImage.vue'

const props = defineProps<{ scale: number }>()
const emit = defineEmits<{
  seek: [event: MouseEvent]
  reference: [target: TimelineReferenceTarget]
}>()
const workspace = useEditingWorkspace()
const scenes = workspace.motionScenes
const work = workspace.visibleMotionWork
const expanded = ref<string | null>(null)
const targetClip = ref('')
watch(
  () => workspace.state.referenceFocus,
  (snapshot) => {
    if (snapshot?.target.kind === 'motion' && snapshot.target.objectId)
      expanded.value = snapshot.target.id
  },
)
const detail = computed(() => scenes.value.find((s) => s.id === expanded.value))
const preview = ref<{ id: string; start: number; duration: number } | null>(
  null,
)
const lanes = computed(() => {
  const ends: number[] = []
  const rows = new Map<string, number>()
  for (const scene of [...scenes.value].sort(
    (a, b) => a.startFrame - b.startFrame,
  )) {
    let index = ends.findIndex((end) => end <= scene.startFrame)
    if (index < 0) index = ends.length
    rows.set(scene.id, index)
    ends[index] = scene.startFrame + scene.durationFrames
  }
  return { rows, count: Math.max(1, ends.length) }
})
const hitInsets = computed(() => {
  const rows = Array.from(
    { length: lanes.value.count },
    () => [] as { id: string; start: number; end: number }[],
  )
  for (const scene of scenes.value) {
    rows[lanes.value.rows.get(scene.id)!]!.push({
      id: scene.id,
      start: scene.startFrame / MOTION_FPS,
      end: (scene.startFrame + scene.durationFrames) / MOTION_FPS,
    })
  }
  return new Map(
    rows.flatMap((items) => [...timelineHitInsets(items, props.scale)]),
  )
})
const clips = computed(() => workspace.displayProject.value?.clips ?? [])
function writable(scene: MotionScene): boolean {
  return workspace.canEditMotionScene(scene.id)
}
function sceneStyle(scene: MotionScene) {
  const range =
    preview.value?.id === scene.id
      ? preview.value
      : { start: scene.startFrame, duration: scene.durationFrames }
  return {
    left: (range.start / MOTION_FPS) * props.scale + 'px',
    width: (range.duration / MOTION_FPS) * props.scale + 'px',
    ...hitInsets.value.get(scene.id),
    top: (lanes.value.rows.get(scene.id) ?? 0) * 46 + 3 + 'px',
  }
}
function thumbFrame(scene: MotionScene) {
  if (
    scene.posterFrame !== undefined &&
    motionTimelineFrame(scene, scene.posterFrame) !== null
  )
    return scene.posterFrame
  const first = scene.objects
    .flatMap((o) => o.markers.map((m) => motionTimelineFrame(scene, m.frame)))
    .find((f) => f !== null)
  const workingFrame =
    work.value?.scene?.id === scene.id ? work.value.frame : undefined
  return (
    motionFrameAt(
      scene,
      (workingFrame ??
        first ??
        scene.startFrame + Math.floor(scene.durationFrames / 2)) / MOTION_FPS,
    ) ?? scene.sourceInFrame
  )
}
function toggle(scene: MotionScene) {
  workspace.selectMotion(scene)
  expanded.value = expanded.value === scene.id ? null : scene.id
}
watch(
  () => [
    workspace.state.sessionId,
    workspace.displayProject.value?.projectId,
    workspace.state.view,
    workspace.state.draft?.runId,
  ],
  () => {
    expanded.value = null
    cancel?.()
  },
)
watch(
  () => [work.value?.scene?.id, work.value?.objectId],
  () => {
    if (
      workspace.state.motionFollow &&
      work.value?.objectId &&
      work.value.scene
    )
      expanded.value = work.value.scene.id
  },
)
watch(
  () => workspace.state.selectedMotionSceneId,
  (id) => {
    if (expanded.value && expanded.value !== id) expanded.value = id
  },
)
watch(
  [
    () => detail.value?.id,
    () => detail.value?.version,
    () => detail.value?.anchor?.clipId,
    () => detail.value?.anchor?.status,
    () => detail.value?.anchor?.sourceTime,
  ],
  () => {
    targetClip.value =
      clips.value.find((clip) => clip.id === detail.value?.anchor?.clipId)
        ?.id ?? ''
  },
  { flush: 'sync' },
)
watch(clips, () => {
  if (!clips.value.some((clip) => clip.id === targetClip.value))
    targetClip.value = ''
})
const chosenClip = computed(() =>
  clips.value.find((clip) => clip.id === targetClip.value),
)
const anchorSource = computed(() => {
  const clip = chosenClip.value
  const at = workspace.state.playhead
  if (
    !clip ||
    at < clip.timelineStart ||
    at >= clip.timelineStart + clipTimelineDuration(clip)
  )
    return null
  const source = clip.sourceIn + (at - clip.timelineStart) * clip.speed
  return clipContainsAnchor(clip, source) ? source : null
})
function clipLabel(clip: VideoClip) {
  const project = workspace.displayProject.value
  const name =
    project?.assets.find((item) => item.id === clip.assetId)?.displayName ??
    clip.assetId
  const track =
    project?.tracks.find((item) => item.id === clip.trackId)?.name ??
    clip.trackId
  return `${name} · ${track} · ${formatTimecode(clip.timelineStart)}`
}
const clipOptions = computed(() => [
  { value: '', label: '选择片段' },
  ...clips.value.map((clip) => ({ value: clip.id, label: clipLabel(clip) })),
])
const boundClip = computed(() =>
  clips.value.find((item) => item.id === detail.value?.anchor?.clipId),
)
function selectedDetail(scene: MotionScene): boolean {
  return (
    writable(scene) &&
    workspace.state.selectedMotionSceneId === scene.id &&
    detail.value === scene
  )
}
function locateClip() {
  if (chosenClip.value) {
    workspace.state.playing = false
    workspace.setPlayhead(chosenClip.value.timelineStart)
  }
}
function bindAnchor(scene: MotionScene) {
  const clipId = chosenClip.value?.id
  const sourceTime = anchorSource.value
  if (!clipId || sourceTime === null || !selectedDetail(scene)) return
  void workspace
    .mutateDerived(
      {
        type: 'setMotionAnchor',
        sceneId: scene.id,
        expectedVersion: scene.version,
        anchor: { clipId, sourceTime },
      },
      workspace.captureProject(),
      () =>
        selectedDetail(scene) &&
        chosenClip.value?.id === clipId &&
        anchorSource.value === sourceTime,
    )
    .catch(() => undefined)
}
function releaseAnchor(scene: MotionScene) {
  if (!scene.anchor || !selectedDetail(scene)) return
  void workspace
    .mutateDerived(
      {
        type: 'setMotionAnchor',
        sceneId: scene.id,
        expectedVersion: scene.version,
        anchor: null,
      },
      workspace.captureProject(),
      () => selectedDetail(scene),
    )
    .catch(() => undefined)
}
function markers(scene: MotionScene, object: MotionScene['objects'][number]) {
  return object.markers.flatMap((m) => {
    const at = motionTimelineFrame(scene, m.frame)
    return at === null ? [] : [{ ...m, at }]
  })
}
let cancel: (() => void) | undefined
function gesture(
  event: PointerEvent,
  scene: MotionScene,
  kind: 'move' | 'left' | 'right',
) {
  if (event.button !== 0 || event.ctrlKey) return
  workspace.selectMotion(scene)
  if (!writable(scene)) return
  const origin = workspace.captureProject()
  const pointer = event.pointerId
  const x = event.clientX
  const scale = props.scale
  const end = scene.startFrame + scene.durationFrames
  const rate = scene.playback?.rate ?? 1
  const phase = scene.playback?.phase ?? 0
  const range = (event: PointerEvent) => {
    const delta = Math.round(((event.clientX - x) / scale) * MOTION_FPS)
    if (kind === 'right')
      return {
        id: scene.id,
        start: scene.startFrame,
        duration: Math.max(1, scene.durationFrames + delta),
      }
    if (kind === 'move')
      return {
        id: scene.id,
        start: Math.max(0, scene.startFrame + delta),
        duration: scene.durationFrames,
      }
    const leftBound =
      scene.startFrame - Math.floor((scene.sourceInFrame + phase) / rate)
    const start = Math.max(
      0,
      leftBound,
      Math.min(end - 1, scene.startFrame + delta),
    )
    return { id: scene.id, start, duration: end - start }
  }
  function move(event: PointerEvent) {
    if (event.pointerId === pointer) preview.value = range(event)
  }
  function up(event: PointerEvent) {
    if (event.pointerId !== pointer) return
    cleanup()
    if (
      !workspace.isCurrent(origin) ||
      !writable(scene) ||
      Math.abs(event.clientX - x) < 3
    )
      return
    const { start, duration } = range(event)
    if (start === scene.startFrame && duration === scene.durationFrames) return
    const sourceInFrame = Math.floor(
      scene.sourceInFrame + phase + (start - scene.startFrame) * rate + 1e-8,
    )
    void workspace
      .mutateDerived(
        kind === 'move'
          ? { type: 'moveMotionScene', sceneId: scene.id, startFrame: start }
          : {
              type: 'trimMotionScene',
              sceneId: scene.id,
              startFrame: start,
              sourceInFrame,
              durationFrames: duration,
            },
        origin,
        () =>
          workspace.state.selectedMotionSceneId === scene.id && writable(scene),
      )
      .catch(() => undefined)
  }
  function cleanup() {
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointercancel', cleanup)
    preview.value = null
    cancel = undefined
  }
  cancel?.()
  cancel = cleanup
  window.addEventListener('pointerup', up)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointercancel', cleanup)
}
onBeforeUnmount(() => cancel?.())
</script>

<template>
  <section class="motion-lane" aria-label="动效轨" data-testid="motion-lane">
    <div class="row">
      <div class="label"><Spline :size="14" />动效</div>
      <div
        class="lane"
        :style="{ height: lanes.count * 46 + 'px' }"
        @click.self="emit('seek', $event)"
      >
        <span v-if="!scenes.length" class="empty">{{
          work?.message ?? '暂无动效'
        }}</span>
        <div
          v-for="scene in scenes"
          :key="scene.id"
          class="scene"
          :style="sceneStyle(scene)"
          :data-motion-scene="scene.id"
          :data-agent-change="work?.scene?.id === scene.id || undefined"
          :aria-label="scene.name"
          tabindex="0"
          role="button"
          :aria-expanded="expanded === scene.id"
          :class="{
            selected: workspace.state.selectedMotionSceneId === scene.id,
            lost: scene.anchor?.status === 'lost',
          }"
          :title="
            scene.name +
            ' · ' +
            formatTimecode(scene.startFrame / MOTION_FPS) +
            ' · ' +
            scene.durationFrames +
            ' 帧'
          "
          @pointerdown="gesture($event, scene, 'move')"
          @click="workspace.selectMotion(scene)"
          @dblclick="expanded = scene.id"
          @keydown.enter.self.prevent="toggle(scene)"
          @keydown.space.self.prevent="toggle(scene)"
        >
          <span class="hit-area" aria-hidden="true" />
          <div class="scene-face">
            <MotionImage
              v-if="scene.anchor?.status !== 'lost'"
              class="thumb"
              :scene="scene"
              :frame="thumbFrame(scene)"
              :width="192"
            />
            <LinkButton
              class="expand"
              :aria-label="'展开或收起 ' + scene.name"
              :data-motion-expand="scene.id"
              @pointerdown.stop
              @click.stop="toggle(scene)"
            >
              <ChevronDown
                v-if="expanded === scene.id"
                :size="12"
              /><ChevronRight v-else :size="12" />
            </LinkButton>
            <div class="copy">
              <strong>{{ scene.name }}</strong
              ><span
                >{{
                  work?.scene?.id === scene.id
                    ? '绘制中'
                    : scene.anchor?.status === 'lost'
                      ? '需重新绑定'
                      : scene.mode === 'fullscreen'
                        ? '全屏'
                        : '叠加'
                }}
                · {{ scene.objects.length }} 个对象</span
              >
            </div>
          </div>
          <template v-if="writable(scene)">
            <span
              class="trim left"
              data-motion-trim="left"
              @pointerdown.stop.prevent="gesture($event, scene, 'left')"
            />
            <span
              class="trim right"
              data-motion-trim="right"
              @pointerdown.stop.prevent="gesture($event, scene, 'right')"
            />
          </template>
        </div>
      </div>
    </div>
    <template v-if="detail">
      <div
        v-for="object in detail.objects"
        :key="object.id"
        class="row object-row"
        :data-motion-scene-detail="detail.id"
        :data-motion-object="object.id"
        :class="{
          active:
            workspace.state.selectedMotionObjectId === object.id &&
            workspace.state.selectedMotionSceneId === detail.id,
        }"
      >
        <LinkButton
          class="label object-label"
          :title="object.name"
          @click="workspace.selectMotion(detail, object.id)"
        >
          <Box :size="12" /><span>{{ object.name }}</span>
        </LinkButton>
        <div class="lane object-lane" @click.self="emit('seek', $event)">
          <LinkButton
            v-for="(marker, i) in markers(detail, object)"
            :key="i"
            class="marker"
            :data-motion-marker="marker.frame"
            :aria-pressed="
              workspace.state.selectedMotionSceneId === detail.id &&
              workspace.state.selectedMotionObjectId === object.id &&
              workspace.state.selectedMotionMarkerFrame === marker.frame
            "
            :style="{ left: (marker.at / MOTION_FPS) * scale + 'px' }"
            :title="
              marker.label + ' · ' + formatTimecode(marker.at / MOTION_FPS)
            "
            @click="workspace.selectMotion(detail, object.id, marker.frame)"
          >
            ◆ {{ marker.label }}
          </LinkButton>
        </div>
        <LinkButton
          class="handoff"
          :aria-label="object.name + ' 添加到对话'"
          :data-motion-reference="object.id"
          @click="
            emit('reference', {
              kind: 'motion',
              id: detail.id,
              objectId: object.id,
            })
          "
        >
          <MessageSquareText :size="14" />
        </LinkButton>
      </div>
      <div
        v-if="selectedDetail(detail) && (clips.length || detail.anchor)"
        class="anchor-controls"
      >
        <Link2 :size="14" />
        <span>{{
          detail.anchor?.status === 'lost'
            ? '需重新绑定'
            : detail.anchor
              ? '已绑定片段'
              : '独立场景'
        }}</span>
        <template v-if="detail.anchor">
          <span class="anchor-time"
            >源 {{ formatTimecode(detail.anchor.sourceTime) }}</span
          >
          <span
            class="bound-clip-name"
            :title="boundClip ? clipLabel(boundClip) : detail.anchor.clipId"
          >
            {{ boundClip ? clipLabel(boundClip) : detail.anchor.clipId }}
          </span>
        </template>
        <Select
          v-if="clips.length"
          v-model="targetClip"
          class="anchor-select"
          size="sm"
          aria-label="选择锚点片段"
          :options="clipOptions"
        />
        <LinkButton
          v-if="chosenClip && anchorSource === null"
          data-testid="motion-locate-clip"
          @click="locateClip"
        >
          定位到片段
        </LinkButton>
        <span v-if="anchorSource !== null" class="anchor-time"
          >目标源 {{ formatTimecode(anchorSource) }}</span
        >
        <LinkButton
          v-if="clips.length"
          :disabled="anchorSource === null"
          data-testid="motion-bind"
          @click="bindAnchor(detail)"
        >
          绑定
        </LinkButton>
        <LinkButton
          v-if="detail.anchor"
          data-testid="motion-unbind"
          @click="releaseAnchor(detail)"
        >
          解除绑定
        </LinkButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.motion-lane {
  --motion-tint: 166 134 210;
  font-size: var(--fs-xxxs);
  color: rgb(var(--editor-muted));
  background: rgb(var(--editor-canvas));
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.row {
  display: flex;
  position: relative;
}
.label {
  box-sizing: border-box;
  position: sticky;
  left: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--space-1-5);
  width: var(--track-label-width);
  padding: 0 var(--space-3);
  background: rgb(var(--editor-panel));
  border: 0;
  border-right: 0.5px solid rgb(var(--editor-line));
  font: inherit;
  color: inherit;
}
.lane {
  position: relative;
  flex: 1;
  min-width: 0;
}
.empty {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  transform: translateY(-50%);
  pointer-events: none;
}
.label svg {
  color: rgb(var(--motion-tint));
  flex: none;
}
.scene {
  position: absolute;
  height: 40px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.hit-area {
  position: absolute;
  inset: 0 var(--hit-right, 0px) 0 var(--hit-left, 0px);
}
.scene-face {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-xs);
  box-shadow: inset 0 0 0 1px rgb(var(--motion-tint) / 0.65);
  color: rgb(var(--editor-text));
  background: color-mix(
    in srgb,
    rgb(var(--motion-tint)) 17%,
    rgb(var(--editor-panel))
  );
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.scene.selected .scene-face,
.scene[data-agent-change] .scene-face {
  box-shadow: inset 0 0 0 2px rgb(var(--motion-tint));
}
.scene.lost .scene-face {
  outline: 1px dashed rgb(var(--warn));
  outline-offset: -1px;
}
.scene .thumb {
  flex: none;
  width: 40px;
  height: 30px;
}
.copy {
  display: grid;
  min-width: 0;
}
.copy strong,
.copy span,
.object-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.copy span {
  color: rgb(var(--editor-muted));
}
.expand,
.handoff,
.anchor-controls .ds-link-button,
.marker {
  padding: 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.expand {
  display: flex;
  order: -1;
}
.trim {
  position: absolute;
  top: 0;
  bottom: 0;
  width: min(5px, 22%);
  cursor: ew-resize;
}
.trim:hover {
  background: rgb(var(--editor-accent));
}
.left {
  left: 0;
}
.right {
  right: 0;
}
.object-row {
  border-top: 0.5px solid rgb(var(--editor-line));
  min-height: 25px;
}
.object-label {
  display: flex;
  text-align: left;
  cursor: pointer;
  padding-right: var(--space-6);
}
.object-label span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.active .object-label,
.marker[aria-pressed='true'] {
  color: rgb(var(--editor-text));
  background: color-mix(
    in srgb,
    rgb(var(--motion-tint)) 22%,
    rgb(var(--editor-panel))
  );
}
.marker {
  position: absolute;
  top: var(--space-1);
  max-width: 130px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.handoff {
  position: sticky;
  right: 0;
  width: 24px;
  background: rgb(var(--editor-panel));
  z-index: var(--z-raised);
}
.anchor-controls {
  position: sticky;
  left: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1) var(--space-1-5);
  width: max-content;
  max-width: 100cqw;
  box-sizing: border-box;
  flex-wrap: wrap;
  white-space: nowrap;
  min-height: 27px;
  padding: 0 var(--space-2-5);
}
.anchor-controls > * {
  flex-shrink: 0;
}
.anchor-time {
  font-variant-numeric: tabular-nums;
}
.bound-clip-name {
  max-width: min(135px, 30cqw);
  overflow: hidden;
  text-overflow: ellipsis;
}
.anchor-controls .anchor-select {
  max-width: 200px;
  color: inherit;
  background: rgb(var(--editor-panel));
}
.anchor-controls .ds-link-button {
  color: rgb(var(--editor-text));
}
.anchor-controls .ds-link-button:disabled {
  opacity: 0.45;
}
</style>
