<script setup lang="ts">
/** Generate one subtitle lane from the configured transcription provider. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import { buildSubtitleCues } from '@emperor/core/editing'
import { subtitleReplacement } from './subtitleReplacement'
import Button from '../ui/Button.vue'
import Modal from '../ui/Modal.vue'
import Switch from '../ui/Switch.vue'
import { core } from '../../api/http'
import { onCoreEvent } from '../../api/backend'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import { useEditingWorkspace } from './editingStore'

type AnalysisStatus = CoreOperationResult<'videoProject.analysisStatus'>

const open = defineModel<boolean>('open', { default: false })
const workspace = useEditingWorkspace()
const settings = useSettingsRoute()
const status = ref<AnalysisStatus | null>(null)
const cloud = computed(() => status.value?.transcriptionProvider === 'fun-asr')
const setupHint = computed(() => {
  const items = []
  if (!status.value?.ffmpegPath) items.push('FFmpeg')
  if (cloud.value) {
    if (!status.value?.funAsrConfigured) items.push('阿里云北京地域的 API Key')
  } else {
    if (!status.value?.whisperPath) items.push('whisper-cli')
    if (!status.value?.modelPath) items.push('ggml 模型')
  }
  return items.length
    ? `请在设置中检查 ${items.join('、')}。`
    : '请检查设置中的转写服务。'
})
const scope = ref<'selected' | 'all'>('selected')
const force = ref(false)
const busy = ref(false)
const error = ref('')
const stage = ref('')
const progress = ref(0)
const statusError = ref('')
const checking = ref(false)
let statusRequest = 0
let job = 0
let activeAssetId = ''
let unsubscribe: (() => void) | null = null

const project = computed(() => workspace.state.project)
const videoClips = computed(() => {
  if (!project.value) return []
  return project.value.clips.filter(
    (clip) =>
      project.value?.assets.find((asset) => asset.id === clip.assetId)?.kind !==
      'image',
  )
})
const selectedClip = computed(() =>
  videoClips.value.find((clip) => clip.id === workspace.state.selectedClipId),
)
const targetClips = computed(() =>
  scope.value === 'all'
    ? videoClips.value
    : selectedClip.value
      ? [selectedClip.value]
      : [],
)

const stageLabel = computed(() => {
  switch (stage.value) {
    case 'extract-audio':
      return '提取音频'
    case 'transcribe':
      return cloud.value ? 'Fun-ASR 转写中' : '本地转写中'
    case 'cache':
      return '写入缓存'
    default:
      return '准备中'
  }
})

async function loadStatus(): Promise<void> {
  const request = ++statusRequest
  checking.value = true
  status.value = null
  statusError.value = ''
  try {
    const next = await core('videoProject.analysisStatus')
    if (request === statusRequest) status.value = next
  } catch (cause) {
    if (request === statusRequest)
      statusError.value =
        cause instanceof Error ? cause.message : '无法读取转写设置。'
  } finally {
    if (request === statusRequest) checking.value = false
  }
}

async function generate(): Promise<void> {
  if (
    !project.value ||
    busy.value ||
    !targetClips.value.length ||
    !status.value?.ready
  )
    return
  busy.value = true
  error.value = ''
  progress.value = 0
  const id = ++job
  const origin = workspace.captureProject()
  const snapshot = project.value
  const clips = [...targetClips.value]
  const transcripts = new Map<
    string,
    { start: number; end: number; text: string }[]
  >()
  const failures: string[] = []
  const current = () => id === job && workspace.isCurrent(origin)
  try {
    for (const assetId of new Set(clips.map((clip) => clip.assetId))) {
      if (!current()) return
      activeAssetId = assetId
      const name =
        snapshot.assets.find((asset) => asset.id === assetId)?.displayName ??
        assetId
      stage.value = ''
      progress.value = 0
      try {
        const result = await core('videoProject.transcribe', {
          sessionId: origin.sessionId,
          assetId,
          language: status.value?.language,
          force: force.value,
        })
        const segments = result.transcript.segments
        if (!segments.length) throw new Error('没有识别到语音')
        transcripts.set(assetId, segments)
      } catch (cause) {
        failures.push(
          `${name}：${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    if (!current()) return
    if (snapshot.revision !== project.value?.revision) {
      error.value = '转写期间时间线已变化。请核对片段后重新生成。'
      return
    }
    const successful = clips.filter((clip) => {
      if (buildSubtitleCues({ clips: [clip] }, transcripts).length) return true
      if (transcripts.has(clip.assetId))
        failures.push(`片段 ${clip.id}：范围内没有语音`)
      return false
    })
    const cues = buildSubtitleCues({ clips: successful }, transcripts)
    if (cues.length) {
      await workspace.mutateDerived(
        subtitleReplacement(snapshot.subtitles, successful, cues),
        origin,
      )
      if (!current()) return
    }
    if (failures.length) error.value = failures.join('；')
    else if (cues.length) open.value = false
    else error.value = '没有识别到可用的语音内容。'
  } catch (cause) {
    if (current())
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (id === job) {
      busy.value = false
      activeAssetId = ''
      stage.value = ''
      progress.value = 0
    }
  }
}

function handleEvent(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const data = event as Record<string, unknown>
  if (
    !busy.value ||
    data.asset_id !== activeAssetId ||
    data.event !== 'video_project_analysis' ||
    data.session_id !== workspace.state.sessionId
  )
    return
  stage.value = typeof data.stage === 'string' ? data.stage : ''
  progress.value =
    typeof data.progress === 'number'
      ? Math.max(0, Math.min(100, data.progress))
      : 0
}

watch(open, (value) => {
  if (!value) {
    ++statusRequest
    ++job
    busy.value = false
    activeAssetId = ''
    return
  }
  error.value = ''
  status.value = null
  if (!selectedClip.value) scope.value = 'all'
  void loadStatus()
})
watch(settings.open, (visible, previous) => {
  if (open.value && previous && !visible) void loadStatus()
})
onMounted(() => {
  unsubscribe = onCoreEvent(handleEvent)
})
onBeforeUnmount(() => {
  ++job
  ++statusRequest
  unsubscribe?.()
})
</script>

<template>
  <Modal v-model:open="open" title="转写并生成字幕" :width="460">
    <div v-if="!videoClips.length" class="dialog-copy">
      先把视频或音频添加到时间线，再生成字幕。
    </div>
    <div v-else class="dialog-form">
      <p class="dialog-copy">
        <template v-if="status">
          {{
            cloud
              ? '使用阿里云 Fun-ASR 识别台词。转写时只发送提取的音频，视频文件保留在本机。'
              : '使用本地 Whisper 识别台词，转写音频留在本机。'
          }}
        </template>
        生成后会替换所选片段时间范围内的字幕。
      </p>
      <div class="scope">
        <Button
          type="button"
          size="sm"
          :class="{ active: scope === 'selected' }"
          :disabled="!selectedClip || busy"
          @click="scope = 'selected'"
        >
          当前片段
        </Button>
        <Button
          type="button"
          size="sm"
          :class="{ active: scope === 'all' }"
          :disabled="busy"
          @click="scope = 'all'"
        >
          全部音视频片段
        </Button>
      </div>
      <label class="toggle-row">
        <span>重新转写<small>忽略已有缓存</small></span>
        <Switch v-model="force" aria-label="重新转写" :disabled="busy" />
      </label>
      <p v-if="checking" class="dialog-copy" role="status">正在检查转写设置…</p>
      <div v-else-if="statusError" class="setup-warning" role="alert">
        <strong>无法读取转写设置</strong>
        <span>{{ statusError }}</span>
        <Button size="sm" @click="loadStatus">重试</Button>
      </div>
      <div v-else-if="status && !status.ready" class="setup-warning">
        <strong>转写尚未配置完成</strong>
        <span>{{ setupHint }}</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          @click="settings.openSettings('media')"
        >
          打开设置
        </Button>
      </div>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div v-if="busy" class="progress">
        <span>{{ stageLabel }}</span>
        <div class="progress-track">
          <i :style="{ width: `${progress}%` }" />
        </div>
      </div>
    </div>
    <template #footer>
      <Button type="button" size="sm" :disabled="busy" @click="open = false">
        取消
      </Button>
      <Button
        type="button"
        size="sm"
        variant="primary"
        :disabled="busy || !targetClips.length || !status?.ready"
        @click="generate"
      >
        {{ busy ? '生成中…' : error ? '重新生成' : '生成字幕' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.dialog-copy,
.dialog-note {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xs);
}
.dialog-note {
  color: rgb(var(--text-2));
}
.scope {
  display: flex;
  gap: var(--space-1);
}
.scope :deep(.ds-button) {
  height: 28px;
  padding: 0 var(--space-3);
  border: 0.5px solid var(--stroke-1);
  border-radius: var(--r-sm);
  background: transparent;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxxs);
  cursor: pointer;
}
.scope :deep(.ds-button.active) {
  border-color: rgb(var(--editor-accent));
  background: rgb(var(--editor-accent-soft));
  color: rgb(var(--editor-accent));
}
.scope :deep(.ds-button:disabled) {
  opacity: 0.4;
  cursor: default;
}
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
}
.toggle-row small {
  display: block;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}
.setup-warning {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--r-sm);
  background: rgb(var(--warn-soft));
  color: rgb(var(--text-1));
  font-size: var(--fs-xxxs);
}
.dialog-error {
  margin: 0;
  color: rgb(var(--error));
  font-size: var(--fs-xxxs);
}
.progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}
.progress-track {
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--surface-hover);
}
.progress-track i {
  display: block;
  height: 100%;
  background: rgb(var(--editor-accent));
}
</style>
