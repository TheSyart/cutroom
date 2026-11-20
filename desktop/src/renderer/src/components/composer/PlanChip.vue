<script setup lang="ts">
import { computed } from 'vue'
import type { ComposerLifecycleMode } from '../../composables/composerLifecycle'
import { DsClose, DsPlan } from '../icons/ds'

const props = defineProps<{ mode: ComposerLifecycleMode; busy?: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()

const title = computed(() =>
  props.busy ? '任务运行中，请先停止或暂停' : '退出计划',
)

function dismiss(): void {
  if (props.busy) return
  emit('dismiss')
}
</script>

<template>
  <button
    v-if="mode"
    type="button"
    class="plan-chip"
    :data-kind="mode"
    aria-label="退出计划"
    :aria-disabled="busy || undefined"
    :title="title"
    @click="dismiss"
  >
    <DsPlan :size="14" aria-hidden="true" />
    <span>计划</span>
    <DsClose :size="12" class="close" aria-hidden="true" />
  </button>
</template>

<style scoped>
.plan-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  height: var(--space-6);
  padding: var(--space-0-5) var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--attention-soft));
  color: rgb(var(--approval-line));
  box-shadow: inset 0 0 0 1px rgb(var(--attention) / 0.3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  cursor: pointer;
}

.plan-chip:hover:not([aria-disabled]) {
  color: rgb(var(--approval-strong));
}

.plan-chip[aria-disabled] {
  opacity: 0.6;
  cursor: default;
}

.plan-chip:focus-visible {
  outline: 2px solid rgb(var(--approval-line));
  outline-offset: 2px;
}

.close {
  opacity: 0.8;
}
</style>
