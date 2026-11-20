<script setup lang="ts">
/** Render saved time and skill references alongside a message's links and text. */
import { computed } from 'vue'
import type { MessageReference } from '../../../types'
import { DsSkill } from '../../icons/ds'
import { useReferenceCatalog } from '../../composer/editor/referenceCatalog'
import { messageSegments } from '../../composer/editor/referenceText'
import TimelineReferenceChip from '../../editing/TimelineReferenceChip.vue'
import ResourceLink from '../resources/ResourceLink.vue'
import ResourceCard from '../resources/ResourceCard.vue'
import {
  resourceUrlSpans,
  standaloneResource,
  type DisplayResource,
} from '../resources/resourceModel'

const props = defineProps<{
  text: string
  references?: readonly MessageReference[]
  sourceMessageId?: string
}>()

const catalog = useReferenceCatalog()
type RenderSegment =
  | ReturnType<typeof messageSegments>[number]
  | { kind: 'resource'; resource: DisplayResource; card: boolean }
const segments = computed<RenderSegment[]>(() => {
  const source = props.sourceMessageId || 'user'
  const urls = resourceUrlSpans(props.text, source)
  let cursor = 0
  return messageSegments(props.text, props.references, catalog).flatMap(
    (segment): RenderSegment[] => {
      if (segment.kind === 'chip') return [segment]
      const offset = props.text.indexOf(segment.text, cursor)
      if (offset >= 0) cursor = offset + segment.text.length
      const spans =
        offset < 0
          ? []
          : urls.filter((span) => span.start >= offset && span.end <= cursor)
      const card = standaloneResource(segment.text, source)
      if (
        card &&
        (segment.text === props.text ||
          spans.some((span) => span.resource.href === card.href))
      )
        return [{ kind: 'resource', resource: card, card: true }]
      const out: RenderSegment[] = []
      let last = 0
      for (const span of spans) {
        const start = span.start - offset
        if (start > last)
          out.push({ kind: 'text', text: segment.text.slice(last, start) })
        out.push({ kind: 'resource', resource: span.resource, card: false })
        last = span.end - offset
      }
      if (last < segment.text.length)
        out.push({ kind: 'text', text: segment.text.slice(last) })
      return out
    },
  )
})
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index"
    ><TimelineReferenceChip
      v-if="segment.kind === 'chip' && segment.chip.kind === 'timeline'"
      :reference="segment.chip"
    /><span
      v-else-if="segment.kind === 'chip'"
      class="reference-chip"
      :data-kind="segment.chip.kind"
      :data-unavailable="segment.available ? undefined : 'true'"
      role="img"
      :aria-label="
        segment.available
          ? `技能 ${segment.chip.label}`
          : `技能 ${segment.chip.label}（已不可用）`
      "
      :title="segment.available ? undefined : '已不可用'"
      ><DsSkill :size="14" class="reference-chip-icon" />{{
        segment.chip.label
      }}</span
    ><ResourceCard
      v-else-if="segment.kind === 'resource' && segment.card"
      :resource="segment.resource"
      compact
    /><ResourceLink
      v-else-if="segment.kind === 'resource'"
      :resource="segment.resource"
    /><template v-else>{{ segment.text }}</template></template
  >
</template>

<style scoped>
.reference-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  margin: 0 var(--space-0-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--accent) / 0.12);
  color: rgb(var(--text-link));
  font-weight: var(--weight-medium);
  white-space: nowrap;
  vertical-align: baseline;
}

.reference-chip-icon {
  flex: none;
}

.reference-chip[data-unavailable] {
  background: var(--surface-hover);
  color: rgb(var(--text-3));
  text-decoration: line-through;
}
</style>
