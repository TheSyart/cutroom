<script setup lang="ts">
import type { DelegationResultChatNode } from '../../../conversation/types'
import JsonTree from '../../ui/JsonTree.vue'

defineProps<{ node: DelegationResultChatNode }>()
const status = {
  ready: '已记录',
  conflicted: '存在冲突',
  applied: '已应用',
  reverted: '已撤销',
  discarded: '已丢弃',
} as const
</script>

<template>
  <details
    class="archived-result"
    data-delegation-result
    :data-state="node.data.state"
  >
    <summary>
      {{ node.data.title || '历史委派' }} · {{ status[node.data.state] }} ·
      {{ node.data.totals.files }} 个文件
    </summary>
    <JsonTree :value="node.data" />
  </details>
</template>

<style scoped>
.archived-result {
  color: rgb(var(--text-2));
  font: var(--type-footnote) var(--font-sans);
}
summary {
  cursor: pointer;
}
</style>
