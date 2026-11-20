<script setup lang="ts">
/** Expanded body for a Video Edit Agent tool: its semantic summary, not raw JSON. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import GenericToolCard from './GenericToolCard.vue'
import { resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()

const parsed = computed<Record<string, unknown> | null>(() => {
  const text = resultText(props.data).trim()
  if (!text.startsWith('{')) return null
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
})

function text(key: string): string {
  const value = parsed.value?.[key]
  return typeof value === 'string' ? value : ''
}

function number(key: string): number | null {
  const value = parsed.value?.[key]
  return typeof value === 'number' ? value : null
}

function seconds(value: number | null): string {
  if (value === null) return ''
  return `${value.toFixed(2)} 秒`
}

const summary = computed(
  () => text('summary') || text('message') || text('error'),
)
const before = computed(() => number('beforeDuration'))
const after = computed(() => number('afterDuration'))
const total = computed(() => number('totalDuration'))
const revision = computed(() => number('revision'))
const state = computed(() => {
  const value = parsed.value
  if (!value) return 'muted'
  if (value.valid === false || text('error')) return 'error'
  if (value.noChange === true || value.approved === false) return 'muted'
  if (value.applied === true || value.focused === true || value.valid === true)
    return 'ok'
  return 'muted'
})
</script>

<template>
  <div v-if="parsed" class="video-edit" :data-state="state">
    <p v-if="summary" class="summary">{{ summary }}</p>
    <div
      v-if="before !== null || after !== null || total !== null"
      class="metrics"
    >
      <span v-if="before !== null">前 {{ seconds(before) }}</span>
      <span v-if="after !== null">后 {{ seconds(after) }}</span>
      <span v-else-if="total !== null">总时长 {{ seconds(total) }}</span>
      <span v-if="revision !== null" class="revision">r{{ revision }}</span>
    </div>
  </div>
  <GenericToolCard v-else :data="data" />
</template>

<style scoped>
.video-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid rgb(var(--stroke-2));
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: 1.55;
}
.video-edit[data-state='ok'] {
  border-left-color: rgb(var(--accent) / 0.65);
}
.video-edit[data-state='error'] {
  border-left-color: rgb(var(--error) / 0.7);
  color: rgb(var(--error));
}
.video-edit[data-state='muted'] {
  color: rgb(var(--text-3));
}
.summary {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}
.revision {
  font-family: var(--font-mono);
}
</style>
