<script setup lang="ts">
/** Full-width editor top bar: project menu, save state, and every app action. */
import { computed, ref } from 'vue'
import { EDITING_AGENT_NAME } from '../../../../shared/app-brand'
import {
  ChevronDown,
  FolderOpen,
  Folders,
  Download,
  FolderPlus,
  FolderSync,
  Home,
  Import,
  MessageSquareText,
  Moon,
  PanelRight,
  Redo2,
  Settings,
  Sun,
  Undo2,
} from 'lucide-vue-next'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import MenuItem from '../ui/MenuItem.vue'
import Popover from '../ui/Popover.vue'
import { elementOf } from '../ui/elementOf'
import SidebarBell from '../sidebar/SidebarBell.vue'
import { openPath } from '../../api/backend'
import {
  editorExport,
  startEditorExport,
  cancelEditorExport,
} from './editorExport'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import { useTheme } from '../../composables/useTheme'
import { useEditingWorkspace } from './editingStore'

const props = defineProps<{
  hasProject: boolean
  projectName: string
  saveLabel: string
  canUndo: boolean
  canRedo: boolean
  inspectorOpen: boolean
  /** The Agent dock is visible; the top-bar button toggles it. */
  agentOpen?: boolean
  assetsToggleVisible?: boolean
  assetsOpen?: boolean
}>()
const emit = defineEmits<{
  undo: []
  redo: []
  'toggle-inspector': []
  'toggle-agent': []
  'toggle-assets': []
  home: []
  import: []
}>()

const workspace = useEditingWorkspace()
const settings = useSettingsRoute()
const { theme, toggle } = useTheme()
const menuOpen = ref(false)
const menuAnchor = ref<HTMLElement | null>(null)
const projectLabel = computed(() =>
  props.hasProject ? props.projectName : '新建或打开剪辑',
)
const themeLabel = computed(() =>
  theme.value === 'dark' ? '切换浅色' : '切换深色',
)
const agentOpen = computed(() => props.agentOpen !== false)
const agentLabel = computed(() =>
  agentOpen.value ? `隐藏 ${EDITING_AGENT_NAME}` : `显示 ${EDITING_AGENT_NAME}`,
)
const currentExport = computed(() => {
  const job = editorExport.value
  return job?.owner.projectId === workspace.state.project?.projectId &&
    job?.owner.sessionId === workspace.state.sessionId
    ? job
    : null
})
const exporting = computed(() =>
  Boolean(currentExport.value && !currentExport.value.result),
)
const otherExport = computed(() =>
  Boolean(
    editorExport.value && !editorExport.value.result && !currentExport.value,
  ),
)
const exportBlock = computed(() => {
  if (otherExport.value) return '另一工程正在导出'
  if (workspace.readOnly.value) return '请切回可编辑时间线后导出'
  if (workspace.state.saving) return '正在保存工程'
  const project = workspace.state.project
  return project?.clips.length ||
    project?.motionScenes?.some((scene) => scene.anchor?.status !== 'lost')
    ? ''
    : '时间线中还没有可导出的内容'
})
const exportStatus = computed(() => {
  if (otherExport.value) return '另一工程正在导出'
  const job = currentExport.value
  if (!job) return ''
  if (job.result?.kind === 'done') return 'MP4 已导出'
  if (job.result?.kind === 'failed') return '导出失败'
  if (job.result?.kind === 'cancelled') return '导出已取消'
  if (job.cancelling) return '正在取消导出…'
  return job.percent === null ? '准备导出…' : `正在导出 ${job.percent}%`
})
const exportDetail = computed(() => {
  const result = currentExport.value?.result
  if (result?.kind === 'done') return result.path
  if (result?.kind === 'failed') return result.message
  return exportStatus.value || props.saveLabel
})

function startExport(): void {
  const project = workspace.state.project
  if (!project || exportBlock.value || exporting.value) return
  void startEditorExport(
    workspace.state.sessionId,
    project.projectId,
    project.revision,
  )
}

async function cancelExport(): Promise<void> {
  const job = currentExport.value
  if (!job || !exporting.value) return
  try {
    await cancelEditorExport(job.owner)
  } catch (error) {
    if (currentExport.value === job)
      workspace.state.error =
        error instanceof Error ? error.message : String(error)
  }
}

function closeMenu(): void {
  menuOpen.value = false
}

function goHome(): void {
  closeMenu()
  emit('home')
}

async function createProject(): Promise<void> {
  closeMenu()
  await workspace.createProject()
}
async function openFolder(): Promise<void> {
  closeMenu()
  await workspace.openFolder()
}
async function switchWorkspace(): Promise<void> {
  closeMenu()
  await workspace.pickWorkspace()
}
function revealProject(): void {
  closeMenu()
  const sessionId = workspace.state.sessionId
  if (!sessionId) return
  void openPath({
    kind: 'diagnostic',
    rowId: 'active-project-path',
    sessionId,
  }).catch(() => undefined)
}
</script>

<template>
  <header class="editor-topbar" :data-project-open="hasProject || undefined">
    <div class="topbar-left">
      <Button
        :ref="(component) => (menuAnchor = elementOf(component))"
        type="button"
        class="project-menu"
        variant="ghost"
        data-testid="editor-project-menu"
        :title="workspace.state.projectPath || projectLabel"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <FolderOpen :size="16" />
        <span>{{ projectLabel }}</span>
        <ChevronDown :size="12" />
      </Button>
    </div>

    <div
      v-if="hasProject"
      class="project-title"
      :data-export-state="exportStatus ? true : undefined"
    >
      <span
        role="status"
        :title="exportDetail"
        :class="{ failed: currentExport?.result?.kind === 'failed' }"
      >
        {{ exportStatus || saveLabel }}
      </span>
    </div>

    <div class="topbar-actions">
      <template v-if="hasProject">
        <IconButton
          label="撤销"
          :disabled="!canUndo || workspace.readOnly.value"
          @click="emit('undo')"
        >
          <Undo2 :size="16" />
        </IconButton>
        <IconButton
          label="重做"
          :disabled="!canRedo || workspace.readOnly.value"
          @click="emit('redo')"
        >
          <Redo2 :size="16" />
        </IconButton>
        <span class="separator" />
        <IconButton
          v-if="assetsToggleVisible"
          label="素材库"
          aria-controls="editor-assets-panel"
          :active="assetsOpen"
          :aria-expanded="assetsOpen"
          data-testid="editor-assets-toggle"
          @click="emit('toggle-assets')"
        >
          <Folders :size="16" />
        </IconButton>
        <IconButton
          label="参数"
          aria-controls="editor-side-panel"
          :active="inspectorOpen"
          :aria-pressed="inspectorOpen"
          data-testid="editor-inspector-toggle"
          @click="emit('toggle-inspector')"
        >
          <PanelRight :size="16" />
        </IconButton>
        <IconButton
          :label="agentLabel"
          aria-controls="editor-side-panel"
          :active="agentOpen"
          :aria-pressed="agentOpen"
          data-testid="editor-agent-toggle"
          @click="emit('toggle-agent')"
        >
          <MessageSquareText :size="16" />
        </IconButton>
        <Button
          type="button"
          class="import-button"
          aria-label="导入素材"
          variant="secondary"
          size="sm"
          :disabled="workspace.readOnly.value"
          @click="emit('import')"
        >
          <Import :size="16" /><span>导入素材</span>
        </Button>
        <Button
          v-if="exporting"
          type="button"
          variant="ghost"
          size="sm"
          data-testid="editor-export-cancel"
          :disabled="currentExport?.cancelling"
          @click="cancelExport"
          >取消导出</Button
        >
        <Button
          v-else
          type="button"
          class="export-button"
          size="sm"
          data-testid="editor-export"
          :aria-label="
            currentExport?.result?.kind === 'failed'
              ? '重新导出 MP4'
              : '导出 MP4'
          "
          :title="exportBlock || exportDetail"
          :disabled="Boolean(exportBlock)"
          @click="startExport"
        >
          <Download :size="16" /><span>{{
            currentExport?.result?.kind === 'failed' ? '重新导出' : '导出 MP4'
          }}</span>
        </Button>
        <span class="separator" />
      </template>
      <IconButton
        :label="themeLabel"
        data-testid="editor-theme-toggle"
        @click="toggle()"
      >
        <Sun v-if="theme === 'dark'" :size="16" />
        <Moon v-else :size="16" />
      </IconButton>
      <IconButton label="设置" @click="settings.openSettings('model')">
        <Settings :size="16" />
      </IconButton>
      <SidebarBell />
    </div>

    <Popover
      v-model:open="menuOpen"
      :anchor="menuAnchor"
      label="项目菜单"
      :width="260"
      align="start"
      :padded="false"
      data-testid="editor-project-popover"
    >
      <MenuItem v-if="hasProject" @select="goHome">
        <template #icon><Home :size="16" /></template>
        项目首页
      </MenuItem>
      <MenuItem v-if="hasProject" variant="separator" />
      <MenuItem @select="createProject">
        <template #icon><FolderPlus :size="16" /></template>
        新建项目
      </MenuItem>
      <MenuItem @select="openFolder">
        <template #icon><FolderOpen :size="16" /></template>
        打开文件夹
      </MenuItem>
      <MenuItem @select="switchWorkspace">
        <template #icon><FolderSync :size="16" /></template>
        切换工作区
      </MenuItem>
      <template v-if="hasProject">
        <MenuItem variant="separator" />
        <MenuItem @select="revealProject">在访达中显示</MenuItem>
      </template>
    </Popover>
  </header>
</template>

<style scoped>
.editor-topbar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  height: 52px;
  padding: 0 var(--space-3);
  border-bottom: 0.5px solid rgb(var(--editor-line));
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-text));
}
.editor-topbar[data-project-open] {
  height: 43px;
  background: rgb(var(--editor-canvas));
}
.topbar-left,
.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.project-menu {
  max-width: 250px;
  height: 30px;
  padding: 0 var(--space-2);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.project-menu span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-title {
  display: flex;
  flex: 1;
  align-items: baseline;
  min-width: 0;
}
.project-title .failed {
  color: rgb(var(--error));
}
.project-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  white-space: nowrap;
}
.topbar-actions {
  justify-content: flex-end;
}
.import-button {
  margin: 0 var(--space-1);
  color: rgb(var(--editor-text));
}
.export-button:not(:disabled) {
  background: rgb(var(--editor-accent));
  color: rgb(var(--editor-canvas));
}
.separator {
  width: 1px;
  height: 18px;
  margin: 0 var(--space-1);
  background: rgb(var(--editor-line));
}
@media (max-width: 899px) {
  .project-menu {
    max-width: 150px;
  }
  .project-title span {
    max-width: 14em;
  }
}
@media (max-width: 760px) {
  .import-button span,
  .export-button span {
    display: none;
  }
  .import-button,
  .export-button {
    padding-inline: var(--space-2);
  }
  .editor-topbar {
    gap: var(--space-1-5);
  }
}
@media (max-width: 640px) {
  .editor-topbar[data-project-open] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-0-5) var(--space-1-5);
    height: auto;
    padding-block: var(--space-1);
  }
  [data-project-open] .topbar-actions {
    grid-column: 1 / -1;
    justify-content: space-between;
  }
}
</style>
