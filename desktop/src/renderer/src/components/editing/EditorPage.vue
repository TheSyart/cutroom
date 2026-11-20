<script setup lang="ts">
import type { TimelineChip } from '@emperor/core/editing'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { X, SlidersHorizontal } from 'lucide-vue-next'
import { EDITING_AGENT_NAME } from '../../../../shared/app-brand'
import Button from '../ui/Button.vue'
import { elementOf } from '../ui/elementOf'
import IconButton from '../ui/IconButton.vue'
import agentMark from '../../../../../../assets/brand/cutroom-mark.svg'
import EditorTopBar from './EditorTopBar.vue'
import EditorDraftBar from './EditorDraftBar.vue'
import ProjectHome from './ProjectHome.vue'
import AssetLibraryPanel from './AssetLibraryPanel.vue'
import EditorPreview from './EditorPreview.vue'
import EditorInspector from './EditorInspector.vue'
import EditorTimeline from './EditorTimeline.vue'
import { onCoreEvent } from '../../api/backend'
import { useEditingWorkspace, type MotionWork } from './editingStore'
import { useEditorLayout } from './useEditorLayout'
import { handTimelineReferenceTo } from './editorTimelineHandoff'
import { isEditableTarget } from '../../composables/useShortcuts'
import {
  clearEditorAgentFocus,
  editorAgentFocus,
  requestEditorAgentFocus,
} from './editorAgentFocus'

const EditorAgentDock = defineAsyncComponent(
  () => import('./EditorAgentDock.vue'),
)
const workspace = useEditingWorkspace()
const preview = ref<InstanceType<typeof EditorPreview> | null>(null)
function captureFrame() {
  if (!preview.value) throw new Error('播放器尚未就绪。')
  return preview.value.captureFrame()
}
const body = ref<HTMLElement | null>(null)
const {
  layout,
  drawer,
  assetsOpen,
  rightOpen,
  assetsDocked,
  sideDocked,
  setAssetsOpen,
  setRightOpen,
  leftPanelWidth,
  rightPanelWidth,
  timelineHeight,
  leftPanelResize,
  rightPanelResize,
  timelineResize,
} = useEditorLayout(body)
const rightTab = ref<'agent' | 'params'>('agent')
const agentTab = ref<HTMLElement | null>(null)
const paramsTab = ref<HTMLElement | null>(null)
const landing = ref<HTMLElement | null>(null)
const page = ref<HTMLElement | null>(null)
let sideOpener: 'agent' | 'inspector' = 'agent'

const project = computed(() => workspace.state.project)
const saveLabel = computed(() =>
  workspace.state.saving
    ? '正在保存…'
    : project.value
      ? `已保存 · r${project.value.revision}`
      : '',
)

let unsubscribe: (() => void) | undefined
function handleCoreEvent(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const data = event as Record<string, unknown>
  if (
    !workspace.state.sessionId ||
    data.session_id !== workspace.state.sessionId
  )
    return
  if (
    data.event === 'video_edit_draft_changed' &&
    typeof data.run_id === 'string' &&
    typeof data.generation === 'number'
  ) {
    void workspace
      .refreshDraft(workspace.state.sessionId, {
        runId: data.run_id,
        generation: data.generation,
      })
      .catch(() => undefined)
  } else if (
    data.event === 'video_motion_work' &&
    data.work &&
    typeof data.work === 'object'
  ) {
    workspace.applyMotionWork(data.work as MotionWork)
  } else if (data.event === 'video_project_changed') {
    void workspace
      .refreshFromDisk(workspace.state.sessionId)
      .catch(() => undefined)
  } else if (data.event === 'video_project_focus') {
    workspace.applyAgentFocus({
      ...(typeof data.clipId === 'string' ? { clipId: data.clipId } : {}),
      ...(typeof data.time === 'number' ? { time: data.time } : {}),
    })
  }
}
onMounted(() => {
  unsubscribe = onCoreEvent(handleCoreEvent)
  void workspace.refreshRecentProjects()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  window.removeEventListener('keydown', onKeydown)
})

async function importMedia(): Promise<void> {
  if (workspace.readOnly.value) return
  if (!workspace.state.project && !(await workspace.pickWorkspace())) return
  const origin = workspace.captureProject()
  try {
    const assets = await workspace.importAssets()
    if (workspace.isCurrent(origin))
      await workspace.probeAssets(assets, origin, true)
  } catch {
    /* workspace reports the error */
  }
}

watch(
  [
    () => workspace.state.sessionId,
    () => workspace.state.project?.projectId,
    () => workspace.state.loading,
  ],
  () => {
    const project = workspace.state.project
    if (!project || workspace.state.loading) return
    void workspace.refreshDraft().catch(() => undefined)
    void workspace.refreshMotion().catch((cause) => {
      if (workspace.state.project?.projectId === project.projectId)
        workspace.state.error =
          cause instanceof Error ? cause.message : String(cause)
    })
    const missing = new Set(workspace.state.missingAssetIds)
    const unfinished = project.assets.filter(
      (asset) =>
        !missing.has(asset.id) &&
        (!asset.width ||
          !asset.height ||
          (asset.kind === 'video' && !asset.duration)),
    )
    if (unfinished.length)
      void workspace.probeAssets(unfinished, workspace.captureProject())
  },
  { immediate: true },
)
function addTimelineReference(reference: TimelineChip): void {
  const sessionId = workspace.state.sessionId
  if (!sessionId) return
  showRightTab('agent')
  handTimelineReferenceTo(sessionId, reference)
  requestEditorAgentFocus('composer')
}

function showRightTab(tab: typeof rightTab.value): void {
  rightTab.value = tab
  if (!rightOpen.value || drawer.value === 'assets') setRightOpen(true)
}

function focusToggle(name: 'assets' | 'agent' | 'inspector'): void {
  void nextTick(() =>
    page.value
      ?.querySelector<HTMLButtonElement>(
        `[data-testid="editor-${name}-toggle"]`,
      )
      ?.focus(),
  )
}

function closeSide(): void {
  setRightOpen(false)
  focusToggle(sideOpener)
}

function closeAssets(): void {
  setAssetsOpen(false)
  focusToggle('assets')
}

function toggleSideTab(tab: typeof rightTab.value): void {
  sideOpener = tab === 'agent' ? 'agent' : 'inspector'
  if (rightOpen.value && rightTab.value === tab && drawer.value !== 'assets') {
    closeSide()
    return
  }
  showRightTab(tab)
  if (tab === 'agent') requestEditorAgentFocus('composer')
  else void nextTick(() => paramsTab.value?.focus())
}

function toggleAssets(): void {
  if (assetsOpen.value) {
    closeAssets()
    return
  }
  setAssetsOpen(true)
  if (drawer.value === 'assets')
    void nextTick(() =>
      page.value
        ?.querySelector<HTMLInputElement>('#editor-assets-panel input')
        ?.focus(),
    )
}

function closeDrawer(): void {
  if (drawer.value === 'assets') closeAssets()
  else if (drawer.value === 'side') closeSide()
}

// When shrinking turns a focused dock into a closed drawer, keep focus in the workbench.
watch(layout, () => {
  const focused = document.activeElement
  if (!assetsOpen.value && focused?.closest('#editor-assets-panel'))
    focusToggle('assets')
  if (!rightOpen.value && focused?.closest('#editor-side-panel'))
    focusToggle(sideOpener)
})

function onTabKeydown(event: KeyboardEvent): void {
  const { key } = event
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
  event.preventDefault()
  const tab =
    key === 'Home'
      ? 'agent'
      : key === 'End'
        ? 'params'
        : rightTab.value === 'agent'
          ? 'params'
          : 'agent'
  showRightTab(tab)
  void nextTick(() => (tab === 'agent' ? agentTab : paramsTab).value?.focus())
}

async function reloadProject(): Promise<void> {
  if (!workspace.state.sessionId) return
  try {
    await workspace.openProject({ sessionId: workspace.state.sessionId })
  } catch {
    /* inline error */
  }
}

const spaceControls = [
  'button',
  'input',
  'textarea',
  'select',
  'a[href]',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '#editor-side-panel',
  '#editor-assets-panel',
  ...[
    'button',
    'switch',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'checkbox',
    'combobox',
    'link',
    'listbox',
    'option',
    'radio',
    'separator',
    'slider',
    'spinbutton',
    'tab',
    'textbox',
    'treeitem',
  ].map((role) => `[role="${role}"]`),
].join(',')

function onKeydown(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !project.value ||
    document.querySelector('[aria-modal="true"], dialog[open], [role="menu"]')
  )
    return
  if (event.key === 'Escape' && drawer.value) {
    event.preventDefault()
    closeDrawer()
    return
  }
  const target =
    event.target instanceof Element ? event.target : document.activeElement
  if (
    isEditableTarget(target) ||
    target?.closest('[contenteditable]:not([contenteditable="false"])')
  )
    return
  if (
    event.code === 'Space' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    if (target?.closest(spaceControls) || drawer.value) return
    event.preventDefault()
    if (!event.repeat) void preview.value?.togglePlayback()
    return
  }
  if (workspace.readOnly.value) return
  if (
    (event.key === 'Delete' || event.key === 'Backspace') &&
    workspace.canDelete.value
  ) {
    event.preventDefault()
    if (!event.repeat) void workspace.deleteSelection().catch(() => undefined)
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    void (event.shiftKey ? workspace.redo() : workspace.undo()).catch(
      () => undefined,
    )
  }
}

watch(
  editorAgentFocus,
  (request) => {
    if (!request || request.target !== 'setup' || project.value) return
    void nextTick(() => {
      landing.value
        ?.querySelector<HTMLElement>('[data-testid="new-project"]')
        ?.focus()
      clearEditorAgentFocus(request.id)
    })
  },
  { flush: 'post' },
)
</script>

<template>
  <main ref="page" class="editor-page" aria-label="剪辑工作区">
    <EditorTopBar
      :has-project="Boolean(project)"
      :project-name="project?.name ?? ''"
      :save-label="saveLabel"
      :can-undo="workspace.state.canUndo"
      :can-redo="workspace.state.canRedo"
      :inspector-open="rightOpen && rightTab === 'params'"
      :agent-open="rightOpen && rightTab === 'agent'"
      assets-toggle-visible
      :assets-open="assetsOpen"
      @undo="workspace.undo"
      @redo="workspace.redo"
      @toggle-inspector="toggleSideTab('params')"
      @toggle-agent="toggleSideTab('agent')"
      @toggle-assets="toggleAssets"
      @home="workspace.closeProject"
      @import="importMedia"
    />

    <section
      v-if="workspace.state.readOnlySnapshot"
      class="readonly-inspection"
    >
      <h2>{{ workspace.state.readOnlySnapshot.project.name }} · 只读查看</h2>
      <p role="alert">{{ workspace.state.readOnlySnapshot.readOnlyReason }}</p>
      <p>
        时间线版本 {{ workspace.state.readOnlySnapshot.project.revision }} ·
        {{ workspace.state.readOnlySnapshot.project.clips.length }} 个片段 ·
        {{ workspace.state.readOnlySnapshot.project.subtitles.length }} 条字幕
      </p>
      <details open>
        <summary>工程素材</summary>
        <ul>
          <li
            v-for="asset in workspace.state.readOnlySnapshot.project.assets"
            :key="asset.id"
          >
            {{ asset.displayName }} · {{ asset.path }}
          </li>
        </ul>
      </details>
      <details>
        <summary>时间线片段</summary>
        <ol>
          <li
            v-for="clip in workspace.state.readOnlySnapshot.project.clips"
            :key="clip.id"
          >
            {{ clip.trackId }} · {{ clip.timelineStart }} 秒 ·
            {{ clip.assetId }}
          </li>
        </ol>
      </details>
      <details>
        <summary>工程字幕</summary>
        <ol>
          <li
            v-for="cue in workspace.state.readOnlySnapshot.project.subtitles"
            :key="cue.id"
          >
            {{ cue.start }} 秒 · {{ cue.text }}
          </li>
        </ol>
      </details>
      <Button
        @click="
          workspace
            .openProject({
              projectPath: workspace.state.readOnlySnapshot.projectPath,
            })
            .catch(() => {})
        "
        >重新打开</Button
      >
      <Button @click="workspace.closeProject">返回首页</Button>
      <p v-if="workspace.state.error" role="alert">
        {{ workspace.state.error }}
      </p>
    </section>

    <div v-else-if="!project" ref="landing" class="home-slot">
      <ProjectHome
        :projects="workspace.state.recentProjects"
        :loading="workspace.state.loading"
        :error="workspace.state.error"
        @create="workspace.createProject"
        @open="workspace.openFolder"
        @open-recent="workspace.openRecent"
      />
    </div>

    <div
      v-else
      :key="`${workspace.state.sessionId}:${project.projectId}`"
      class="editor-workspace"
    >
      <div v-if="workspace.state.error" class="editor-error" role="alert">
        <span>{{ workspace.state.error }}</span>
        <Button type="button" @click="reloadProject">重新加载</Button>
        <Button
          type="button"
          aria-label="关闭错误"
          @click="workspace.state.error = ''"
        >
          ×
        </Button>
      </div>

      <div
        ref="body"
        class="editor-body"
        :data-layout="layout"
        :data-assets-docked="assetsDocked || undefined"
        :data-side-docked="sideDocked || undefined"
        :style="{
          '--editor-library-width': `${leftPanelWidth}px`,
          '--editor-side-width': `${rightPanelWidth}px`,
          '--editor-timeline-height': `${timelineHeight}px`,
        }"
      >
        <div class="editor-stage" data-testid="editor-stage">
          <div class="editor-upper" data-testid="editor-upper">
            <div
              v-show="assetsOpen"
              id="editor-assets-panel"
              class="workbench-panel left-panel"
              :class="{ drawer: drawer === 'assets' }"
            >
              <IconButton
                v-if="drawer === 'assets'"
                class="drawer-close"
                label="关闭素材库"
                @click="closeAssets"
                ><X :size="16"
              /></IconButton>
              <AssetLibraryPanel @import="importMedia" />
            </div>
            <div
              v-if="assetsDocked"
              class="vertical-resizer left-resizer"
              aria-label="调整素材库宽度"
              aria-controls="editor-assets-panel"
              v-bind="leftPanelResize.separatorProps"
            />
            <div
              class="workbench-panel monitor-panel"
              :inert="drawer ? true : undefined"
            >
              <EditorPreview ref="preview" />
            </div>
          </div>
          <div
            class="horizontal-resizer"
            :inert="drawer ? true : undefined"
            aria-label="调整时间线高度"
            aria-controls="editor-timeline-panel"
            v-bind="timelineResize.separatorProps"
          />
          <div
            id="editor-timeline-panel"
            class="workbench-panel timeline-column"
            :inert="drawer ? true : undefined"
            data-testid="editor-timeline-region"
          >
            <EditorTimeline
              @import="importMedia"
              @add-reference="addTimelineReference"
            >
              <template #versions
                ><EditorDraftBar v-if="workspace.state.draft"
              /></template>
            </EditorTimeline>
          </div>
        </div>
        <div
          v-if="sideDocked"
          class="vertical-resizer right-resizer"
          :inert="drawer ? true : undefined"
          aria-label="调整右侧面板宽度"
          aria-controls="editor-side-panel"
          v-bind="rightPanelResize.separatorProps"
        />
        <section
          v-show="rightOpen"
          id="editor-side-panel"
          class="workbench-panel editor-side"
          :inert="drawer === 'assets' || undefined"
          :class="{ drawer: drawer === 'side' }"
          :aria-label="`${EDITING_AGENT_NAME} 和参数`"
        >
          <div class="side-heading">
            <div
              class="editor-tabs"
              role="tablist"
              aria-label="右侧面板"
              @keydown="onTabKeydown"
            >
              <Button
                id="editor-chat-tab"
                :ref="(node) => (agentTab = elementOf(node))"
                size="sm"
                type="button"
                role="tab"
                aria-controls="editor-chat-panel"
                :aria-selected="rightTab === 'agent'"
                :tabindex="rightTab === 'agent' ? 0 : -1"
                @click="showRightTab('agent')"
              >
                <img :src="agentMark" alt="" />{{ EDITING_AGENT_NAME }}
              </Button>
              <Button
                id="editor-properties-tab"
                :ref="(node) => (paramsTab = elementOf(node))"
                size="sm"
                type="button"
                role="tab"
                aria-controls="editor-properties-panel"
                :aria-selected="rightTab === 'params'"
                :tabindex="rightTab === 'params' ? 0 : -1"
                @click="showRightTab('params')"
              >
                <SlidersHorizontal :size="14" />参数
              </Button>
            </div>
            <IconButton
              class="side-close"
              :label="`关闭 ${EDITING_AGENT_NAME} 和参数`"
              @click="closeSide"
            >
              <X :size="16" />
            </IconButton>
          </div>
          <div
            v-show="rightTab === 'agent'"
            id="editor-chat-panel"
            class="side-panel"
            role="tabpanel"
            aria-labelledby="editor-chat-tab"
          >
            <EditorAgentDock
              :capture-frame="captureFrame"
              :session-id="workspace.state.sessionId"
            />
          </div>
          <div
            v-show="rightTab === 'params'"
            id="editor-properties-panel"
            class="side-panel"
            role="tabpanel"
            aria-labelledby="editor-properties-tab"
          >
            <EditorInspector />
          </div>
        </section>
        <div
          v-if="drawer"
          class="drawer-scrim"
          aria-hidden="true"
          @click="closeDrawer"
        />
      </div>
    </div>
  </main>
</template>

<style scoped>
.readonly-inspection {
  padding: var(--space-6);
  overflow: auto;
}
.readonly-inspection details {
  margin: var(--space-3) 0;
}
.editor-page {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: rgb(var(--editor-canvas));
  color: rgb(var(--editor-text));
}
.home-slot {
  display: flex;
  flex: 1;
  min-height: 0;
}
.editor-workspace {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.editor-body {
  display: grid;
  flex: 1;
  position: relative;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  min-width: 0;
  margin: 0 var(--space-1-5) var(--space-1-5);
}
.editor-error {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2-5);
  min-height: 34px;
  padding: var(--space-1) var(--space-3-5);
  border-bottom: 0.5px solid rgb(var(--error) / 0.25);
  background: rgb(var(--error-soft));
  color: rgb(var(--error));
  font-size: var(--fs-xxxs);
}
.editor-error span {
  flex: 1;
}
.editor-error button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--fs-xxxs);
  cursor: pointer;
}
.editor-body[data-side-docked] {
  grid-template-columns: minmax(0, 1fr) 6px var(--editor-side-width);
}
.editor-stage {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 6px var(--editor-timeline-height);
  min-width: 0;
  min-height: 0;
}
.editor-upper {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.editor-body[data-assets-docked] .editor-upper {
  grid-template-columns: var(--editor-library-width) 6px minmax(0, 1fr);
}
.workbench-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 0.5px solid rgb(var(--editor-line));
  border-radius: var(--r-sm);
  background: rgb(var(--editor-panel));
}
.timeline-column {
  position: relative;
}
.left-panel {
  position: relative;
}
.left-panel > :deep(.asset-library) {
  height: 100%;
}
.monitor-panel {
  display: flex;
}
.monitor-panel :deep(.program-monitor) {
  flex: 1;
}
.editor-side {
  display: flex;
  flex-direction: column;
}
.side-heading {
  display: flex;
  flex: none;
  justify-content: space-between;
  align-items: center;
  height: 43px;
  padding-inline: var(--space-2);
  border-bottom: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
}
.editor-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: rgb(var(--editor-canvas));
}
.editor-tabs .ds-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 27px;
  padding-inline: var(--space-2);
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  cursor: pointer;
}
.editor-tabs .ds-button:hover {
  color: rgb(var(--editor-text));
}
.editor-tabs .ds-button[aria-selected='true'] {
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
  box-shadow:
    0 0 0 1px rgb(var(--editor-line)),
    0 1px 3px rgb(var(--shadow-color) / 0.1);
}
.editor-tabs .ds-button:focus-visible {
  outline: 2px solid rgb(var(--editor-accent));
  outline-offset: 1px;
}
.editor-tabs img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}
.side-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.vertical-resizer,
.horizontal-resizer {
  z-index: var(--z-raised);
  touch-action: none;
}
.vertical-resizer {
  cursor: col-resize;
}
.horizontal-resizer {
  cursor: row-resize;
}
.vertical-resizer:hover,
.horizontal-resizer:hover,
.vertical-resizer:focus-visible,
.horizontal-resizer:focus-visible {
  background: rgb(var(--editor-accent) / 0.45);
}
.drawer-scrim {
  position: absolute;
  z-index: var(--z-overlay);
  inset: 0;
  background: rgb(0 0 0 / 0.22);
}
.workbench-panel.drawer {
  position: absolute;
  z-index: var(--z-drawer);
  inset-block: 0;
  box-shadow: var(--elev-2);
}
.left-panel.drawer {
  left: 0;
  width: min(320px, 92%);
}
.editor-side.drawer {
  right: 0;
  width: min(400px, 92%);
}
.drawer-close {
  position: absolute;
  z-index: var(--z-raised);
  right: var(--space-2);
  top: var(--space-2);
}
.left-panel.drawer :deep(.library-header) {
  padding-right: var(--space-8);
}
</style>
