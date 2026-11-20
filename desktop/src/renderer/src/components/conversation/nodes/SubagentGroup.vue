<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationHandle } from '../../../conversation/store'
import type { AgentsRow } from '../processModel'
import ToolCallTree from './ToolCallTree.vue'

const props = defineProps<{ handle: ConversationHandle; row: AgentsRow }>()
const calls = computed(() =>
  props.row.members.flatMap((key) => {
    const node = props.handle.node(key).value
    return node?.kind === 'tool' ? [node] : []
  }),
)
</script>

<template>
  <div
    class="archived-calls"
    :data-chat-anchor-key="row.id"
    data-chat-flow-kind="agents"
    :data-chat-turn="row.turn"
  >
    <ToolCallTree
      v-for="call in calls"
      :key="call.key"
      :node="call"
      :step="false"
    />
  </div>
</template>

<style scoped>
.archived-calls {
  padding-bottom: var(--space-4);
  min-width: 0;
}
</style>
