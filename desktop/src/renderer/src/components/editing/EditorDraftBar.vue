<script setup lang="ts">
import { computed } from 'vue'
import { LocateFixed } from 'lucide-vue-next'
import Button from '../ui/Button.vue'
import { useEditingWorkspace } from './editingStore'
import { editRunLabels } from './editorPrecisionRun'
import { formatTimecode } from './editingViewModel'

const workspace = useEditingWorkspace()
const draft = computed(() => workspace.state.draft)
const available = workspace.draftAvailable
const readOnly = workspace.readOnly
const coverage = computed(() => draft.value?.coverage)
const reviewedTimeline = computed(() => coverage.value?.draft)
const sources = computed(() => coverage.value?.source ?? [])

type Coverage = {
  readSeconds: number
  unread: { start: number; end: number }[]
  noPicture?: { start: number; end: number }[]
}
function gapSeconds(item: Coverage): number {
  return (
    item.noPicture?.reduce((sum, range) => sum + range.end - range.start, 0) ??
    0
  )
}
function scopedSeconds(item: Coverage): number {
  return (
    item.readSeconds +
    gapSeconds(item) +
    item.unread.reduce((sum, range) => sum + range.end - range.start, 0)
  )
}
function percent(read: number, total: number): number {
  if (total <= 0) return 0
  return read >= total ? 100 : Math.min(99, Math.round((100 * read) / total))
}
const sourceProgress = computed(() =>
  percent(
    sources.value.reduce((sum, item) => sum + item.readSeconds, 0),
    sources.value.reduce((sum, item) => sum + scopedSeconds(item), 0),
  ),
)
const reviewProgress = computed(() => {
  const item = reviewedTimeline.value
  return item && percent(item.readSeconds, scopedSeconds(item))
})
</script>

<template>
  <div
    v-if="draft && (available || sources.length || reviewedTimeline)"
    class="draft-bar"
  >
    <div
      v-if="available"
      class="view-switch"
      role="group"
      aria-label="时间线版本"
    >
      <Button
        size="sm"
        data-testid="editor-live-view"
        :aria-pressed="!readOnly"
        @click="workspace.selectView('live')"
        >当前工程</Button
      >
      <Button
        size="sm"
        data-testid="editor-draft-view"
        :aria-pressed="readOnly"
        @click="workspace.selectView('draft')"
        >Agent 草稿</Button
      >
    </div>
    <span v-if="available" class="draft-status" role="status">
      {{ editRunLabels[draft.state]
      }}<template v-if="readOnly"> · 只读</template>
    </span>
    <details
      v-if="sources.length || reviewedTimeline"
      class="coverage"
      data-testid="editor-draft-coverage"
    >
      <summary>
        <span v-if="sources.length">素材已读 {{ sourceProgress }}%</span>
        <span v-if="reviewedTimeline">草稿已审 {{ reviewProgress }}%</span>
      </summary>
      <div class="coverage-panel">
        <div v-if="reviewedTimeline" class="coverage-entry">
          <strong>草稿时间线</strong>
          <span
            >{{ formatTimecode(reviewedTimeline.readSeconds) }} /
            {{ formatTimecode(scopedSeconds(reviewedTimeline)) }}</span
          >
          <ul v-if="reviewedTimeline.unread.length" aria-label="草稿待审区间">
            <li v-for="range in reviewedTimeline.unread" :key="range.start">
              待审 {{ formatTimecode(range.start) }}–{{
                formatTimecode(range.end)
              }}
            </li>
          </ul>
          <ul
            v-if="reviewedTimeline.noPicture?.length"
            aria-label="草稿无画面区间"
          >
            <li v-for="range in reviewedTimeline.noPicture" :key="range.start">
              无画面 {{ formatTimecode(range.start) }}–{{
                formatTimecode(range.end)
              }}
            </li>
          </ul>
        </div>
        <div v-for="item in sources" :key="item.assetId" class="coverage-entry">
          <strong>{{ item.name }}</strong>
          <span
            >{{ formatTimecode(item.readSeconds) }} /
            {{ formatTimecode(scopedSeconds(item)) }}</span
          >
          <ul v-if="item.unread.length" aria-label="素材未读区间">
            <li v-for="range in item.unread" :key="range.start">
              未读 {{ formatTimecode(range.start) }}–{{
                formatTimecode(range.end)
              }}
            </li>
          </ul>
          <ul v-if="item.noPicture?.length" aria-label="素材无画面区间">
            <li v-for="range in item.noPicture" :key="range.start">
              无画面 {{ formatTimecode(range.start) }}–{{
                formatTimecode(range.end)
              }}
            </li>
          </ul>
        </div>
      </div>
    </details>
    <Button
      v-if="available && draft.change"
      class="change-button"
      size="sm"
      data-testid="editor-draft-change"
      @click="workspace.seekDraftChange"
    >
      <LocateFixed :size="14" />最新改动
    </Button>
  </div>
</template>

<style scoped>
.draft-bar {
  display: flex;
  flex: none;
  flex-wrap: nowrap;
  white-space: nowrap;
  align-items: center;
  gap: var(--space-1) var(--space-2-5);
  min-height: 28px;
  padding: 0;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.view-switch {
  display: flex;
  padding: 2px;
  border-radius: var(--r-sm);
  background: rgb(var(--editor-canvas));
}
.view-switch :deep(.ds-button) {
  height: 24px;
  color: rgb(var(--editor-muted));
}
.view-switch :deep([aria-pressed='true']) {
  background: rgb(var(--editor-accent-soft));
  color: rgb(var(--editor-text));
}
.draft-status {
  white-space: nowrap;
}
.coverage {
  position: relative;
  margin-left: auto;
}
.coverage summary {
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--r-sm);
  cursor: pointer;
}
.coverage summary:hover {
  background: var(--surface-hover);
}
.coverage summary span + span::before {
  margin-inline: var(--space-1-5);
  content: '·';
}
.coverage-panel {
  position: absolute;
  z-index: var(--z-overlay);
  top: calc(100% + var(--space-2));
  right: 0;
  width: min(320px, 65vw);
  max-height: min(20vh, 160px);
  overflow: auto;
  padding: var(--space-2);
  border: 0.5px solid rgb(var(--editor-line));
  border-radius: var(--r-sm);
  background: rgb(var(--editor-panel-raised));
  box-shadow: var(--elev-3);
}
.coverage-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-1-5) var(--space-2);
}
.coverage-entry + .coverage-entry {
  border-top: 0.5px solid rgb(var(--editor-line));
}
.coverage-entry strong {
  overflow-wrap: anywhere;
  color: rgb(var(--editor-text));
  font-weight: var(--weight-medium);
}
.coverage-entry ul {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.change-button {
  color: rgb(var(--editor-accent));
}
@media (max-width: 800px) {
  .draft-status {
    display: none;
  }
  .draft-bar {
    gap: var(--space-1);
  }
}
</style>
