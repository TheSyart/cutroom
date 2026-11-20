<script setup lang="ts">
import { computed } from 'vue'
import { Captions, Film, Gauge, Scan, Volume2 } from 'lucide-vue-next'
import {
  resolveCaptionStyle,
  defaultAnnotationColor,
  type Annotation,
  type CaptionStyle,
  type VideoProjectCommand,
} from '@emperor/core/editing'
import Button from '../ui/Button.vue'
import TextField from '../ui/TextField.vue'
import TextArea from '../ui/TextArea.vue'
import Select from '../ui/Select.vue'
import RangeInput from '../ui/RangeInput.vue'
import ColorInput from '../ui/ColorInput.vue'
import Switch from '../ui/Switch.vue'
import { formatTimecode } from './editingViewModel'
import { useEditingWorkspace, type InspectorTab } from './editingStore'

const workspace = useEditingWorkspace()
const baseTabs = [
  { id: 'clip' as const, label: '片段', icon: Film },
  { id: 'canvas' as const, label: '画面', icon: Scan },
  { id: 'speed' as const, label: '变速', icon: Gauge },
  { id: 'audio' as const, label: '声音', icon: Volume2 },
]
const speedOptions = [0.25, 0.5, 1, 1.5, 2, 4].map((value) => ({
  value,
  label: `${value}×`,
}))
const captionPositionOptions = [
  { value: 'top' as const, label: '顶部' },
  { value: 'bottom' as const, label: '底部' },
]
const fitOptions = [
  { value: 'contain' as const, label: '完整显示' },
  { value: 'cover' as const, label: '填满画布' },
]
const project = workspace.displayProject
const readOnly = workspace.readOnly
const style = computed(() => resolveCaptionStyle(project.value?.captionStyle))
function updateCaptionStyle(patch: Partial<CaptionStyle>) {
  run({ type: 'setCaptionStyle', style: { ...style.value, ...patch } })
}
const annotationFields = {
  start: '开始（秒）',
  end: '结束（秒）',
  x: '左边距（比例）',
  y: '顶边距（比例）',
  width: '宽度（比例）',
  height: '高度（比例）',
} as const
function changeAnnotation(
  a: Annotation,
  patch: Partial<Omit<Annotation, 'id'>>,
) {
  const { id, ...annotation } = a
  run({
    type: 'updateAnnotation',
    annotationId: id,
    annotation: { ...annotation, ...patch },
  })
}
function addAnnotation(kind: 'zoom' | 'box') {
  const start = workspace.state.playhead
  run({
    type: 'addAnnotation',
    annotation: {
      kind,
      start,
      end: start + 1,
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      color: defaultAnnotationColor,
    },
  })
}
const clip = computed(
  () =>
    project.value?.clips.find(
      (item) => item.id === workspace.state.selectedClipId,
    ) ?? null,
)
const asset = computed(
  () =>
    project.value?.assets.find((item) => item.id === clip.value?.assetId) ??
    null,
)
const clipIndex = computed(
  () =>
    project.value?.clips.findIndex((item) => item.id === clip.value?.id) ?? -1,
)
const subtitle = computed(
  () =>
    project.value?.subtitles.find(
      (item) => item.id === workspace.state.selectedSubtitleId,
    ) ?? null,
)
const subtitleIndex = computed(
  () =>
    project.value?.subtitles.findIndex(
      (item) => item.id === subtitle.value?.id,
    ) ?? -1,
)
const tabs = computed(() => [
  ...baseTabs,
  ...(subtitle.value
    ? [{ id: 'subtitle' as const, label: '字幕', icon: Captions }]
    : []),
])
const scope = computed(() =>
  workspace.state.activeTab === 'subtitle'
    ? `第 ${subtitleIndex.value + 1} 条`
    : clipIndex.value >= 0
      ? `第 ${clipIndex.value + 1} 段`
      : '全片',
)
const heading = computed(() => {
  const label =
    tabs.value.find((tab) => tab.id === workspace.state.activeTab)?.label ??
    '片段'
  return `${label} · ${scope.value}`
})

function run(command: VideoProjectCommand): void {
  if (readOnly.value) return
  void workspace.mutate(command).catch(() => undefined)
}
function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}
function trim(event: Event, edge: 'sourceIn' | 'sourceOut'): void {
  if (!clip.value || !asset.value) return
  const value = numberValue(event)
  const sourceIn = edge === 'sourceIn' ? value : clip.value.sourceIn
  const sourceOut = edge === 'sourceOut' ? value : clip.value.sourceOut
  run({
    type: 'trimClip',
    clipId: clip.value.id,
    edge: edge === 'sourceIn' ? 'left' : 'right',
    sourceIn,
    sourceOut,
  })
}
function updateTransform(
  patch: Partial<{ scale: number; x: number; y: number }>,
): void {
  if (!clip.value) return
  run({
    type: 'updateClip',
    clipId: clip.value.id,
    transform: { ...clip.value.transform, ...patch },
  })
}
function selectTab(tab: InspectorTab): void {
  workspace.state.activeTab = tab
}
function updateSubtitle(patch: {
  start?: number
  end?: number
  text?: string
}): void {
  if (!subtitle.value) return
  run({
    type: 'updateSubtitle',
    subtitleId: subtitle.value.id,
    ...patch,
  })
}
function subtitleTime(event: Event, edge: 'start' | 'end'): void {
  const value = numberValue(event)
  if (!Number.isFinite(value)) return
  updateSubtitle({ [edge]: value })
}
function subtitleText(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value.trim()
  if (!value) return
  updateSubtitle({ text: value })
}
function deleteSubtitle(): void {
  if (!subtitle.value) return
  run({ type: 'deleteSubtitle', subtitleId: subtitle.value.id })
}
</script>

<template>
  <aside class="editor-inspector" aria-label="剪辑检查器">
    <nav class="inspector-tabs" aria-label="检查器任务">
      <Button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :data-inspector-tab="tab.id"
        :class="{ active: workspace.state.activeTab === tab.id }"
        :aria-label="tab.label"
        :aria-pressed="workspace.state.activeTab === tab.id"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" :size="16" />
        <span>{{ tab.label }}</span>
      </Button>
    </nav>
    <header class="inspector-heading">
      <strong>{{ heading }}</strong>
      <span v-if="readOnly">只读</span>
      <span v-else-if="workspace.state.saving">保存中</span>
    </header>

    <fieldset
      :key="workspace.state.view"
      class="inspector-scroll"
      :disabled="readOnly"
      aria-label="剪辑参数"
    >
      <template v-if="workspace.state.activeTab === 'clip'">
        <section v-if="clip && asset" class="inspector-section">
          <h3>基础</h3>
          <div class="selected-name">
            <span>当前素材</span>
            <strong>{{ asset.displayName }}</strong>
          </div>
          <div class="field-grid">
            <label>
              <span>源入点（秒）</span>
              <TextField
                data-field="source-in"
                type="number"
                min="0"
                :max="asset.duration ?? undefined"
                step="0.1"
                :model-value="String(clip.sourceIn)"
                @change="trim($event, 'sourceIn')"
              />
            </label>
            <label>
              <span>源出点（秒）</span>
              <TextField
                data-field="source-out"
                type="number"
                min="0.1"
                :max="asset.duration ?? undefined"
                step="0.1"
                :model-value="String(clip.sourceOut)"
                @change="trim($event, 'sourceOut')"
              />
            </label>
          </div>
          <div class="readout">
            <span>时间线时长</span
            ><strong>{{
              formatTimecode((clip.sourceOut - clip.sourceIn) / clip.speed)
            }}</strong>
          </div>
        </section>
        <p v-else class="empty-copy padded">
          从时间线选择一个片段后，在这里调整剪口。
        </p>
      </template>

      <template v-else-if="workspace.state.activeTab === 'canvas'">
        <section class="inspector-section">
          <h3>基础</h3>
          <label class="field"
            ><span>适配方式</span>
            <Select
              aria-label="适配方式"
              :model-value="project?.canvas.fit"
              :options="fitOptions"
              @change="(fit) => run({ type: 'updateCanvas', fit })"
            />
          </label>
          <label class="field color-field"
            ><span>背景色</span>
            <ColorInput
              type="color"
              :value="project?.canvas.background"
              @change="
                run({
                  type: 'updateCanvas',
                  background: ($event.target as HTMLInputElement).value,
                })
              "
            />
            <code>{{ project?.canvas.background }}</code>
          </label>
        </section>
        <section class="inspector-section">
          <h3>画面标注</h3>
          <div class="field-grid">
            <Button @click="addAnnotation('box')">添加框选</Button
            ><Button @click="addAnnotation('zoom')">局部放大</Button>
          </div>
          <details v-for="a in project?.annotations" :key="a.id">
            <summary>
              {{ a.kind === 'zoom' ? '局部放大' : '框选' }} ·
              {{ formatTimecode(a.start) }}
            </summary>
            <div class="field-grid">
              <label v-for="(label, field) in annotationFields" :key="field"
                >{{ label
                }}<TextField
                  type="number"
                  :model-value="String(a[field])"
                  step=".01"
                  @change="
                    changeAnnotation(a, { [field]: numberValue($event) })
                  "
              /></label>
            </div>
            <label v-if="a.kind === 'box'"
              >边框颜色
              <ColorInput
                type="color"
                :value="a.color"
                @change="
                  changeAnnotation(a, {
                    color: ($event.target as HTMLInputElement).value,
                  })
                "
            /></label>
            <Button
              @click="run({ type: 'deleteAnnotation', annotationId: a.id })"
              >移除标注</Button
            >
          </details>
        </section>
        <section
          v-if="clip && asset?.kind !== 'audio'"
          class="inspector-section"
        >
          <h3>位置与大小</h3>
          <label class="slider-field"
            ><span
              >缩放
              <output
                >{{ Math.round(clip.transform.scale * 100) }}%</output
              ></span
            >
            <RangeInput
              tone="editor"
              data-field="scale"
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              :value="clip.transform.scale"
              @change="updateTransform({ scale: numberValue($event) })"
            />
          </label>
          <label class="slider-field"
            ><span
              >水平位置 <output>{{ clip.transform.x }}%</output></span
            >
            <RangeInput
              tone="editor"
              type="range"
              min="-100"
              max="100"
              step="1"
              :value="clip.transform.x"
              @change="updateTransform({ x: numberValue($event) })"
            />
          </label>
          <label class="slider-field"
            ><span
              >垂直位置 <output>{{ clip.transform.y }}%</output></span
            >
            <RangeInput
              tone="editor"
              type="range"
              min="-100"
              max="100"
              step="1"
              :value="clip.transform.y"
              @change="updateTransform({ y: numberValue($event) })"
            />
          </label>
        </section>
        <p v-else class="empty-copy padded">选择片段后可调整画面位置。</p>
      </template>

      <template v-else-if="workspace.state.activeTab === 'speed'">
        <section
          v-if="clip && asset && asset.kind !== 'image'"
          class="inspector-section"
        >
          <h3>基础</h3>
          <label class="field">
            <span>播放速度</span>
            <Select
              data-field="speed"
              aria-label="播放速度"
              :model-value="clip.speed"
              :options="speedOptions"
              @change="
                (speed) =>
                  clip && run({ type: 'updateClip', clipId: clip.id, speed })
              "
            />
          </label>
          <div class="readout">
            <span>变速后时长</span
            ><strong>{{
              formatTimecode((clip.sourceOut - clip.sourceIn) / clip.speed)
            }}</strong>
          </div>
        </section>
        <p v-else class="empty-copy padded">
          {{
            asset?.kind === 'image'
              ? '图片片段不支持变速。'
              : '选择视频或音频片段后调整速度。'
          }}
        </p>
      </template>

      <template v-else-if="workspace.state.activeTab === 'audio'">
        <section
          v-if="clip && asset && asset.kind !== 'image'"
          class="inspector-section"
        >
          <h3>基础</h3>
          <label class="slider-field"
            ><span
              >原声音量
              <output>{{ Math.round(clip.volume * 100) }}%</output></span
            >
            <RangeInput
              tone="editor"
              data-field="volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="clip.volume"
              @change="
                run({
                  type: 'updateClip',
                  clipId: clip.id,
                  volume: numberValue($event),
                })
              "
            />
          </label>
          <label
            v-for="field in ['fadeIn', 'fadeOut'] as const"
            :key="field"
            class="field"
          >
            <span>{{ field === 'fadeIn' ? '淡入（秒）' : '淡出（秒）' }}</span>
            <TextField
              type="number"
              min="0"
              step=".05"
              :model-value="String(clip[field] ?? 0)"
              @change="
                run({
                  type: 'updateClip',
                  clipId: clip.id,
                  [field]: numberValue($event),
                })
              "
            />
          </label>
          <label class="toggle-row">
            <span><strong>静音</strong><small>只影响当前片段</small></span>
            <Switch
              aria-label="静音"
              :model-value="clip.muted"
              @change="
                (muted) =>
                  clip && run({ type: 'updateClip', clipId: clip.id, muted })
              "
            />
          </label>
        </section>
        <p
          v-else-if="clip && asset?.kind === 'image'"
          class="empty-copy padded"
        >
          图片片段无原声。
        </p>
        <p v-else class="empty-copy padded">选择视频或音频片段后调整音量。</p>
      </template>

      <template v-else-if="workspace.state.activeTab === 'subtitle'">
        <section v-if="subtitle" class="inspector-section">
          <h3>全片字幕样式</h3>
          <label class="field"
            >字号（1080p 像素）<TextField
              type="number"
              min="12"
              max="120"
              :model-value="String(style.fontSize)"
              @change="updateCaptionStyle({ fontSize: numberValue($event) })"
          /></label>
          <label class="field"
            >文字颜色<ColorInput
              type="color"
              :value="style.color"
              @change="
                updateCaptionStyle({
                  color: ($event.target as HTMLInputElement).value,
                })
              "
          /></label>
          <label class="field"
            >字幕位置<Select
              aria-label="字幕位置"
              :options="captionPositionOptions"
              :model-value="style.position"
              @change="(position) => updateCaptionStyle({ position })"
          /></label>
          <label class="field"
            >背景颜色<ColorInput
              type="color"
              :value="style.backgroundColor"
              @change="
                updateCaptionStyle({
                  backgroundColor: ($event.target as HTMLInputElement).value,
                })
              "
          /></label>
          <label class="field"
            >背景不透明度（%）<TextField
              type="number"
              min="0"
              max="100"
              :model-value="String(Math.round(style.backgroundOpacity * 100))"
              @change="
                updateCaptionStyle({
                  backgroundOpacity: numberValue($event) / 100,
                })
              "
          /></label>
          <label class="field"
            >描边颜色<ColorInput
              type="color"
              :value="style.outlineColor"
              @change="
                updateCaptionStyle({
                  outlineColor: ($event.target as HTMLInputElement).value,
                })
              "
          /></label>
          <label class="field"
            >描边宽度（1080p 像素）<TextField
              type="number"
              min="0"
              max="12"
              :model-value="String(style.outlineWidth)"
              @change="
                updateCaptionStyle({ outlineWidth: numberValue($event) })
              "
          /></label>
          <h3>字幕</h3>
          <label class="field">
            <span>文本</span>
            <TextArea
              data-field="subtitle-text"
              :model-value="subtitle.text"
              :min-rows="3"
              :max-rows="6"
              @change="subtitleText"
            />
          </label>
          <div class="field-grid">
            <label>
              <span>开始（秒）</span>
              <TextField
                data-field="subtitle-start"
                type="number"
                min="0"
                step="0.01"
                :model-value="String(subtitle.start)"
                @change="subtitleTime($event, 'start')"
              />
            </label>
            <label>
              <span>结束（秒）</span>
              <TextField
                data-field="subtitle-end"
                type="number"
                min="0.05"
                step="0.01"
                :model-value="String(subtitle.end)"
                @change="subtitleTime($event, 'end')"
              />
            </label>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            class="full"
            @click="deleteSubtitle"
          >
            删除字幕
          </Button>
        </section>
        <p v-else class="empty-copy padded">从字幕轨选择一条字幕后编辑。</p>
      </template>
    </fieldset>
  </aside>
</template>

<style scoped>
.editor-inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: rgb(var(--editor-panel));
  color: rgb(var(--editor-text));
}
.inspector-tabs {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 var(--space-2);
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.inspector-tabs :deep(.ds-button) {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.inspector-tabs :deep(.ds-button:hover) {
  background: rgb(255 255 255 / 0.06);
  color: rgb(var(--editor-text));
}
.inspector-tabs :deep(.ds-button.active) {
  background: rgb(var(--editor-accent-soft));
  color: rgb(var(--editor-accent));
  font-weight: var(--weight-medium);
}
.inspector-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  height: 42px;
  padding: 0 var(--space-3-5);
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.inspector-heading strong {
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
}
.inspector-heading span {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.inspector-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  overflow-y: auto;
}
.inspector-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3-5);
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.inspector-section h3 {
  margin: 0;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.04em;
}
.selected-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.selected-name span {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.selected-name strong {
  overflow: hidden;
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}
.field-grid label,
.field,
.slider-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.field-grid label > span,
.field > span,
.slider-field > span {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}
.inspector-section details {
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.inspector-section details[open] > summary {
  margin-bottom: var(--space-2);
}
.slider-field output {
  color: rgb(var(--editor-text));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}
.readout,
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
}
.readout strong {
  color: rgb(var(--editor-text));
  font-family: var(--font-mono);
  font-weight: var(--weight-regular);
}
.toggle-row span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toggle-row strong {
  color: rgb(var(--editor-text));
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
}
.toggle-row small {
  color: rgb(var(--editor-muted));
}
.color-field {
  flex-direction: row;
  align-items: center;
}
.color-field > span {
  flex: 1;
}
.color-field code {
  color: rgb(var(--editor-muted));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}
.empty-copy {
  margin: 0;
  color: rgb(var(--editor-muted));
  font-size: var(--fs-xxxs);
  line-height: 1.6;
}
.padded {
  padding: var(--space-4) var(--space-3-5);
}
</style>
