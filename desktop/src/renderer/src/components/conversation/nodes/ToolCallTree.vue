<script setup lang="ts">
import type { ToolChatNode, ToolGrantView } from '../../../conversation/types'
import { DsShieldAlert } from '../../icons/ds'
import ToolCallRow from './ToolCallRow.vue'

withDefaults(defineProps<{ node: ToolChatNode; step?: boolean }>(), {
  step: true,
})

const APPROVAL_LABEL: Record<string, string> = {
  'allowed-once': '已允许',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法审批',
}

const GRANT_LABEL: Record<string, string> = {
  once: '已允许本次',
  task: '本任务内允许',
  session: '本会话内允许',
  timed: '限时允许',
  denied: '已拒绝',
}

function grantStatus(grant: ToolGrantView): string {
  if (grant.decision === undefined) return '未记录决定'
  if (grant.cause !== undefined && grant.cause !== 'user') return '已取消'
  return GRANT_LABEL[grant.decision] ?? grant.decision
}
</script>

<template>
  <div
    class="tool-call"
    :data-process-step="step ? '' : undefined"
    :data-chat-call-id="node.data.callId"
  >
    <ToolCallRow :data="node.data" />
    <div
      v-if="node.data.approvals.length || node.data.grants?.length"
      class="subcalls"
      data-subcalls
    >
      <div
        v-for="approval in node.data.approvals"
        :key="approval.id"
        class="sub-line"
        :data-outcome="approval.outcome ?? 'pending'"
      >
        <span class="sub-leading"><DsShieldAlert :size="14" /></span>
        <span class="sub-title">审批</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="sub-text">{{ approval.reason ?? approval.toolName }}</span>
        <span class="sub-status">{{
          approval.outcome === undefined
            ? '未记录决定'
            : (APPROVAL_LABEL[approval.outcome] ?? approval.outcome)
        }}</span>
      </div>
      <div
        v-for="grant in node.data.grants ?? []"
        :key="grant.id"
        class="sub-line"
        data-grant
        :data-outcome="
          grant.decision === undefined
            ? 'pending'
            : grant.decision === 'denied'
              ? 'rejected'
              : grant.cause && grant.cause !== 'user'
                ? 'cancelled'
                : 'allowed-once'
        "
      >
        <span class="sub-leading"><DsShieldAlert :size="14" /></span>
        <span class="sub-title">{{
          grant.highImpact ? '高影响操作确认' : '电脑操作授权'
        }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="sub-text">{{ grant.target }}</span>
        <span class="sub-status">{{ grantStatus(grant) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--r-sm);
}

.subcalls {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0 0 var(--space-0-5) calc(var(--space-4) + var(--space-1-5));
  padding-left: var(--space-2);
  border-left: 1px solid var(--stroke-2);
}

.sub-line {
  display: flex;
  align-items: center;
  min-width: 0;
  height: var(--control-sm);
  font: var(--type-footnote) var(--font-sans);
}

.sub-leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  margin-right: var(--space-1-5);
  color: rgb(var(--text-3));
}

[data-outcome='pending'] .sub-leading {
  color: rgb(var(--attention));
}

.sub-title {
  flex: none;
  color: rgb(var(--text-2));
}

.sep {
  flex: none;
  margin: 0 var(--space-1-5);
  color: rgb(var(--text-4));
}

.sub-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--text-3));
}

.sub-status {
  flex: none;
  margin-left: var(--space-2);
  font-size: var(--fs-xs);
  color: rgb(var(--text-2));
}
</style>
