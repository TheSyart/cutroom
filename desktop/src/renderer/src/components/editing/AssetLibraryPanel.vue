<script setup lang="ts">
/** CapCut-style media library: import, search, filter, real thumbnails and drag. */
import emptyMedia from '../../assets/editor-empty-media.png'
import { computed, ref } from 'vue'
import { Film, Music, Image as ImageIcon, Import, Plus } from 'lucide-vue-next'
import type { VideoAsset } from '@emperor/core/editing'
import Button from '../ui/Button.vue'
import SearchField from '../ui/SearchField.vue'
import AssetThumbnail from './AssetThumbnail.vue'
import { formatTimecode } from './editingViewModel'
import { useEditingWorkspace } from './editingStore'

const emit = defineEmits<{ import: [] }>()
const workspace = useEditingWorkspace()
const query = ref('')
const filter = ref<'all' | 'video' | 'image' | 'audio'>('all')
const project = workspace.displayProject
const readOnly = workspace.readOnly
const selected = computed(
  () =>
    project.value?.assets.find(
      (asset) => asset.id === workspace.state.selectedAssetId,
    ) ?? null,
)
const assets = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return (project.value?.assets ?? []).filter(
    (asset) =>
      (filter.value === 'all' || asset.kind === filter.value) &&
      (!needle || asset.displayName.toLowerCase().includes(needle)),
  )
})
const filters = [
  { id: 'all' as const, label: '全部' },
  { id: 'video' as const, label: '视频' },
  { id: 'audio' as const, label: '音频' },
  { id: 'image' as const, label: '图片' },
]

function missing(id: string): boolean {
  return workspace.displayMissingAssetIds.value.includes(id)
}
function add(asset: VideoAsset): void {
  if (
    readOnly.value ||
    missing(asset.id) ||
    (asset.kind !== 'image' && asset.duration === null)
  )
    return
  void workspace
    .mutate({ type: 'addClip', assetId: asset.id })
    .catch(() => undefined)
}

function startDrag(event: DragEvent, asset: VideoAsset): void {
  if (
    readOnly.value ||
    missing(asset.id) ||
    (asset.kind !== 'image' && asset.duration === null)
  ) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/x-video-asset', asset.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <section class="asset-library" aria-label="素材库">
    <header class="library-header">
      <div class="library-title">
        <strong>素材</strong>
        <span :title="project?.name"
          >{{ project?.name }} · {{ project?.assets.length ?? 0 }} 项</span
        >
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="asset-import"
        :disabled="readOnly"
        @click="emit('import')"
      >
        <Import :size="14" />导入
      </Button>
    </header>

    <SearchField
      v-model="query"
      class="library-search"
      aria-label="搜索素材"
      placeholder="搜索素材名称"
      size="sm"
    />

    <div class="filters" role="group" aria-label="素材筛选">
      <Button
        v-for="item in filters"
        :key="item.id"
        type="button"
        size="sm"
        class="filter"
        :class="{ active: filter === item.id }"
        :aria-pressed="filter === item.id"
        @click="filter = item.id"
      >
        {{ item.label }}
      </Button>
    </div>

    <div v-if="assets.length" class="asset-grid">
      <Button
        v-for="asset in assets"
        :key="asset.id"
        type="button"
        variant="ghost"
        class="asset-card"
        :class="{ selected: workspace.state.selectedAssetId === asset.id }"
        :data-testid="`asset-${asset.id}`"
        :draggable="!readOnly"
        :title="asset.displayName"
        @click="workspace.selectAsset(asset.id)"
        @dblclick="add(asset)"
        @dragstart="startDrag($event, asset)"
      >
        <span class="thumb">
          <AssetThumbnail
            :asset="asset"
            :session-id="workspace.state.sessionId"
          />
          <span class="duration">
            {{ asset.duration ? formatTimecode(asset.duration) : '…' }}
          </span>
        </span>
        <span class="card-copy">
          <span class="kind">
            <Film v-if="asset.kind === 'video'" :size="12" />
            <Music v-else-if="asset.kind === 'audio'" :size="12" /><ImageIcon
              v-else
              :size="12"
            />
            {{
              asset.kind === 'audio'
                ? '音频'
                : asset.kind === 'video'
                  ? '视频'
                  : '图片'
            }}
          </span>
          <strong>{{ asset.displayName }}</strong>
        </span>
      </Button>
    </div>
    <div v-else class="library-empty">
      <img
        v-if="!query && filter === 'all'"
        :src="emptyMedia"
        class="empty-illustration"
        alt=""
      />
      <span>{{
        query || filter !== 'all'
          ? '没有匹配的素材'
          : readOnly
            ? '草稿中没有素材'
            : '导入素材开始剪辑'
      }}</span>
      <Button v-if="!readOnly" type="button" size="sm" @click="emit('import')">
        <Import :size="14" />导入视频、音频或图片
      </Button>
    </div>

    <footer v-if="selected" class="selected-asset">
      <div class="selected-copy">
        <strong>{{ selected.displayName }}</strong>
        <span v-if="missing(selected.id)">素材文件缺失</span>
        <span
          v-else-if="!readOnly && workspace.state.metadataErrors[selected.id]"
          role="alert"
          >{{ workspace.state.metadataErrors[selected.id] }}</span
        >
        <span v-else-if="selected.width && selected.height">
          {{ selected.width }} × {{ selected.height }}
        </span>
        <span v-else-if="selected.kind === 'audio' && selected.duration"
          >音频 · {{ formatTimecode(selected.duration) }}</span
        >
        <span v-else>正在读取媒体信息</span>
      </div>
      <template v-if="!readOnly && missing(selected.id)">
        <Button
          size="sm"
          @click="workspace.relinkAsset(selected.id).catch(() => undefined)"
          >重新链接文件</Button
        >
        <Button
          size="sm"
          @click="
            workspace.removeMissingAsset(selected.id).catch(() => undefined)
          "
          >移除缺失素材</Button
        >
      </template>
      <Button
        v-else-if="!readOnly && workspace.state.metadataErrors[selected.id]"
        size="sm"
        @click="workspace.probeAssets([selected], workspace.captureProject())"
        >重试读取</Button
      >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        class="full"
        :disabled="
          readOnly ||
          missing(selected.id) ||
          (selected.kind !== 'image' && selected.duration === null)
        "
        @click="add(selected)"
      >
        <Plus :size="14" />添加到时间线
      </Button>
    </footer>
  </section>
</template>

<style scoped>
.asset-library {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: var(--space-3);
  border-right: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-text));
}
.library-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.library-header > div {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.library-title span {
  overflow: hidden;
  max-width: 110px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-header strong {
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
}
.library-header span {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.library-search {
  width: 100%;
}
.filters {
  display: flex;
  gap: var(--space-1);
}
.filter {
  height: 24px;
  padding: 0 var(--space-2);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.filter.active {
  background: rgb(var(--editor-accent-soft));
  color: rgb(var(--editor-accent));
}
.asset-grid {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* Implicit rows must size to content; `auto` rows collapse inside the
     definite-height flex area once a project holds dozens of assets. */
  grid-auto-rows: max-content;
  align-content: start;
  gap: var(--space-2);
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.asset-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  height: auto;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: 0.5px solid transparent;
  white-space: normal;
  border-radius: var(--r-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: grab;
}
.asset-grid .asset-card {
  height: auto;
  padding: 0;
  white-space: normal;
}
.asset-card:hover {
  background: rgb(255 255 255 / 0.05);
}
.asset-card.selected {
  border-color: rgb(var(--editor-accent));
  box-shadow: 0 0 0 0.5px rgb(var(--editor-accent));
}
.thumb {
  position: relative;
  display: block;
  width: 100%;
  height: 82px;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: var(--r-xs);
  background: rgb(var(--editor-canvas));
}
.duration {
  position: absolute;
  right: var(--space-1);
  bottom: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: 2px;
  background: rgb(0 0 0 / 0.65);
  color: rgb(255 255 255);
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
.card-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 0 2px 2px;
}
.card-copy strong {
  display: block;
  max-width: 100%;
  overflow: hidden;
  font-size: var(--fs-xxxs);
  font-weight: var(--weight-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
.empty-illustration {
  width: min(125px, 28vh);
  height: auto;
}
.library-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 160px;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  text-align: center;
}
.selected-asset {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 0.5px solid rgb(var(--editor-line));
}
.selected-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.selected-copy strong {
  overflow: hidden;
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-copy span {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.full {
  width: 100%;
}
</style>
