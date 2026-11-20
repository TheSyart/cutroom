<script setup lang="ts">
import { computed } from 'vue'
import { Captions, Clock3, Film, Layers2, Spline } from 'lucide-vue-next'
import { motionFrameAt, type TimelineChip } from '@emperor/core/editing'
import LinkButton from '../ui/LinkButton.vue'
import AssetThumbnail from './AssetThumbnail.vue'
import MotionImage from './MotionImage.vue'
import { useEditingWorkspace } from './editingStore'

const props = defineProps<{ reference: TimelineChip }>()
const workspace = useEditingWorkspace()
const snapshot = computed(() => props.reference.timeline)
const reason = computed(() => workspace.referenceUnavailable(snapshot.value))
const project = computed(() =>
  snapshot.value.draft
    ? workspace.state.draft?.project
    : workspace.state.project,
)
const asset = computed(
  () =>
    !reason.value &&
    project.value?.assets.find((item) => item.id === snapshot.value.assetId),
)
const scene = computed(() => {
  const target = snapshot.value.target
  if (reason.value || target.kind !== 'motion') return null
  const scenes =
    workspace.readOnly.value === Boolean(snapshot.value.draft)
      ? workspace.motionScenes.value
      : project.value?.motionScenes
  return scenes?.find((scene) => scene.id === target.id)
})
const icon = computed(() => {
  switch (snapshot.value.target.kind) {
    case 'subtitle':
    case 'subtitle-track':
      return Captions
    case 'track':
      return Layers2
    case 'clip':
      return Film
    case 'motion':
      return Spline
    default:
      return Clock3
  }
})
const description = computed(() =>
  [
    reason.value || '定位到时间线',
    props.reference.label,
    snapshot.value.excerpt,
    snapshot.value.draft
      ? 'Agent 草稿 g' + snapshot.value.draft.generation
      : '工程 r' + snapshot.value.revision,
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>
<template>
  <LinkButton
    type="button"
    class="timeline-reference"
    data-kind="timeline"
    :data-target="snapshot.target.kind"
    :aria-label="description"
    :title="description"
    :aria-disabled="Boolean(reason)"
    @mousedown.prevent
    @keydown.stop
    @click.stop="workspace.revealTimelineReference(snapshot)"
  >
    <span v-if="asset" class="poster"
      ><AssetThumbnail
        :asset="asset"
        :session-id="snapshot.sessionId"
        :poster-time="snapshot.sourceIn"
        :poster-end="asset.kind === 'audio' ? snapshot.sourceOut : undefined"
    /></span>
    <span v-else-if="scene" class="poster"
      ><MotionImage
        :scene="scene"
        :frame="motionFrameAt(scene, snapshot.start) ?? scene.sourceInFrame"
        :width="96"
    /></span>
    <component :is="icon" v-else :size="14" aria-hidden="true" />
    <span class="caption">
      <span class="label">{{ reference.label }}</span>
      <span v-if="snapshot.excerpt" class="excerpt">{{
        snapshot.excerpt
      }}</span>
      <span v-if="reason" class="excerpt">{{ reason }}</span>
    </span>
  </LinkButton>
</template>
<style scoped>
.timeline-reference {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  vertical-align: middle;
  margin: 1px 2px;
  padding: 2px var(--space-1);
  max-width: min(100%, 245px);
  border-radius: var(--r-xs);
  border: 0.5px solid rgb(var(--accent) / 0.28);
  background: rgb(var(--accent) / 0.09);
  color: rgb(var(--text-1));
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.timeline-reference:focus-visible {
  outline: 2px solid rgb(var(--accent));
}
.timeline-reference[aria-disabled='true'] {
  color: rgb(var(--text-3));
  cursor: default;
}
.poster {
  width: 34px;
  height: 24px;
  flex: none;
  overflow: hidden;
  border-radius: var(--r-xs);
}
.caption {
  min-width: 0;
  display: inline-flex;
  flex-direction: column;
  line-height: 1.35;
}
.label,
.excerpt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label {
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
}
.excerpt {
  color: rgb(var(--text-2));
  font-size: var(--fs-xxxs);
}
</style>
