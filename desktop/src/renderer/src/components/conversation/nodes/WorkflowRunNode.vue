<script setup lang="ts">
import type { WorkflowRunChatNode } from '../../../conversation/types'
import JsonTree from '../../ui/JsonTree.vue'

defineProps<{ node: WorkflowRunChatNode }>()
</script>

<template>
  <details data-process-step>
    <summary>工作流记录 · {{ node.data.name }}</summary>
    <JsonTree :value="node.data" />
  </details>
</template>
