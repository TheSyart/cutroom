<script setup lang="ts">
/** Settings › 媒体分析与语音转写。 */
import { computed, onMounted, ref } from 'vue'
import { Cloud, HardDrive } from 'lucide-vue-next'
import type { CoreOperationArgs, CoreOperationResult } from '@emperor/core/api'
import {
  Badge,
  Notice,
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Switch,
  TextArea,
  TextField,
  refreshAction,
  useSettingsHeader,
} from '../ui'
import Button from '../../ui/Button.vue'
import { core } from '../../../api/http'
import { selectFile } from '../../../api/backend'

type AnalysisStatus = CoreOperationResult<'videoProject.analysisStatus'>
type AnalysisConfig = CoreOperationResult<'videoProject.getAnalysisConfig'>
type AnalysisPatch = CoreOperationArgs<'videoProject.setAnalysisConfig'>[0]

const cacheUsage =
  ref<CoreOperationResult<'videoProject.mediaCacheUsage'> | null>(null)
const cacheFeedback = ref('')
const cacheBusy = ref(false)
const formatBytes = (size: number) =>
  size < 1024
    ? size + ' B'
    : size < 1024 ** 2
      ? (size / 1024).toFixed(1) + ' KiB'
      : (size / 1024 ** 2).toFixed(1) + ' MiB'

async function refreshCache(clear = false) {
  cacheBusy.value = true
  try {
    const usage = clear
      ? await core('videoProject.clearMediaCache')
      : await core('videoProject.mediaCacheUsage')
    cacheUsage.value = usage
    cacheFeedback.value = clear
      ? `已清理 ${formatBytes(usage.removedBytes)}，跳过 ${usage.skipped} 项。`
      : ''
  } catch (cause) {
    cacheFeedback.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    cacheBusy.value = false
  }
}

const status = ref<AnalysisStatus | null>(null)
const config = ref<AnalysisConfig | null>(null)
const loading = ref(false)
const error = ref('')
const apiKey = ref('')
const hotwords = ref('')
const cloud = computed(() => config.value?.transcriptionProvider === 'fun-asr')
const cloudConfigured = computed(() => status.value?.funAsrConfigured === true)
const parsedHotwords = computed(() => [
  ...new Set(
    hotwords.value
      .split(/[,，\n]/)
      .map((word) => word.trim())
      .filter(Boolean),
  ),
])
const providerOptions = [
  { value: 'whisper', label: '本地 Whisper' },
  { value: 'fun-asr', label: '阿里云 Fun-ASR' },
]
const languageOptions = [
  { value: 'zh', label: '中文' },
  { value: 'auto', label: '自动识别' },
  { value: 'en', label: '英文' },
]
const modelName = computed(
  () => status.value?.modelPath?.split('/').filter(Boolean).at(-1) ?? '',
)
const missing = computed(() => {
  const value = status.value
  if (!value) return []
  const items: string[] = []
  if (!value.ffmpegPath) items.push('ffmpeg')
  if (!cloud.value && !value.whisperPath) items.push('whisper-cli')
  if (!cloud.value && !value.modelPath) items.push('Whisper 模型')
  return items
})

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const [nextStatus, nextConfig] = await Promise.all([
      core('videoProject.analysisStatus'),
      core('videoProject.getAnalysisConfig'),
    ])
    status.value = nextStatus
    config.value = nextConfig
    hotwords.value = nextConfig.funAsrHotwords?.join('\n') ?? ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function save(patch: AnalysisPatch): Promise<void> {
  if (loading.value || !config.value) return
  loading.value = true
  error.value = ''
  try {
    config.value = await core('videoProject.setAnalysisConfig', {
      ...config.value,
      ...patch,
    })
    if (patch.funAsrApiKey !== undefined) apiKey.value = ''
    if (patch.funAsrHotwords)
      hotwords.value = config.value.funAsrHotwords?.join('\n') ?? ''
    status.value = null
    status.value = await core('videoProject.analysisStatus')
  } catch (cause) {
    error.value =
      patch.funAsrApiKey === undefined
        ? cause instanceof Error
          ? cause.message
          : String(cause)
        : '密钥设置未能更新。请刷新后查看状态，并确认系统密钥存储可用。'
  } finally {
    loading.value = false
  }
}

function selectProvider(value: string): void {
  apiKey.value = ''
  void save({
    transcriptionProvider: value === 'fun-asr' ? 'fun-asr' : 'whisper',
  })
}

async function chooseModel(): Promise<void> {
  try {
    const path = await selectFile({
      title: '选择 Whisper 模型（ggml-small.bin 等）',
      filters: [{ name: 'Whisper 模型', extensions: ['bin'] }],
    })
    if (path) await save({ modelPath: path })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

useSettingsHeader({
  actions: () => [refreshAction(load, { disabled: loading.value })],
})
onMounted(load)
onMounted(() => refreshCache())
</script>

<template>
  <SettingsSection>
    <Notice
      v-if="error"
      tone="error"
      title="媒体设置未能更新"
      :description="error"
    >
      <template #actions
        ><Button size="sm" variant="secondary" :disabled="loading" @click="load"
          >重新读取</Button
        ></template
      >
    </Notice>
    <p v-if="loading && !config" role="status" class="hint">
      正在读取转写设置…
    </p>
    <template v-if="config">
      <div class="analysis-service" data-testid="analysis-service">
        <span class="service-icon"
          ><component
            :is="cloud ? Cloud : HardDrive"
            :size="20"
            aria-hidden="true"
        /></span>
        <div class="service-copy">
          <label for="analysis-provider">转写服务</label>
          <span>{{
            cloud
              ? '发送提取的音频至阿里云北京地域。'
              : '音频与识别过程均在本机。'
          }}</span>
        </div>
        <Select
          id="analysis-provider"
          :model-value="config.transcriptionProvider"
          :options="providerOptions"
          :disabled="loading"
          @update:model-value="(value) => value && selectProvider(value)"
        />
        <div class="service-state" role="status">
          <Badge
            :tone="status ? (status.ready ? 'ok' : 'warn') : 'neutral'"
            variant="dot-label"
          >
            {{ status ? (status.ready ? '已就绪' : '尚未就绪') : '状态待确认' }}
          </Badge>
          <span v-if="cloud && status && !cloudConfigured"
            >请填写北京地域的 API Key。</span
          >
        </div>
      </div>
      <Notice v-if="missing.length" tone="warn">
        缺少 {{ missing.join('、') }}。
        <template v-if="!status?.ffmpegPath">
          请安装 <code>ffmpeg-full</code>，以支持带字幕导出。
        </template>
        <template v-if="!cloud && !status?.whisperPath">
          请安装 <code>whisper-cpp</code>。
        </template>
        <template v-if="!cloud && !status?.modelPath"
          >请选择 ggml 模型文件。</template
        >
      </Notice>

      <SettingsGroup title="转写偏好">
        <SettingsRow title="默认语言" label-for="analysis-language">
          <Select
            id="analysis-language"
            :model-value="config?.language"
            :options="languageOptions"
            :disabled="loading || !config"
            @update:model-value="
              (value) =>
                value && save({ language: value as 'auto' | 'zh' | 'en' })
            "
          />
        </SettingsRow>
        <SettingsRow
          title="导入后自动转写"
          :description="
            cloud
              ? '视频导入后交给 Fun-ASR 转写并缓存。'
              : '视频导入后在本机转写并缓存。'
          "
        >
          <Switch
            aria-label="导入后自动转写"
            :model-value="config?.autoTranscribe === true"
            :disabled="loading || !config"
            @update:model-value="(value) => save({ autoTranscribe: value })"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        v-if="cloud"
        title="阿里云 Fun-ASR"
        description="使用 Fun-ASR 时，只向阿里云北京地域发送提取的音频，视频文件保留在本机。"
      >
        <SettingsRow
          title="API Key"
          label-for="analysis-fun-asr-key"
          :description="
            cloudConfigured
              ? '密钥已保存，可输入新密钥替换。'
              : '请填写阿里云北京地域的 API Key。'
          "
          layout="stacked"
        >
          <TextField
            id="analysis-fun-asr-key"
            v-model="apiKey"
            type="password"
            autocomplete="off"
            spellcheck="false"
            maxlength="4096"
            :disabled="loading"
            @keydown.enter.prevent="
              apiKey.trim() && save({ funAsrApiKey: apiKey.trim() })
            "
          />
          <template #below>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              :disabled="loading || !apiKey.trim()"
              @click="save({ funAsrApiKey: apiKey.trim() })"
            >
              保存密钥
            </Button>
          </template>
        </SettingsRow>
        <SettingsRow v-if="cloudConfigured" title="已保存密钥">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            :disabled="loading"
            @click="save({ funAsrApiKey: null })"
          >
            移除密钥
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup v-if="!cloud && status" title="本地识别模型">
        <SettingsRow
          title="Whisper 模型"
          :description="modelName || '未选择模型文件'"
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            :disabled="loading || !config"
            @click="chooseModel"
          >
            选择模型
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <details class="analysis-advanced">
        <summary>{{ cloud ? '热词与工具路径' : '工具路径' }}</summary>
        <SettingsGroup v-if="cloud">
          <SettingsRow
            title="识别热词"
            label-for="analysis-fun-asr-hotwords"
            description="填写人名、产品名等常用词，用逗号或换行分隔。"
            layout="stacked"
          >
            <TextArea
              id="analysis-fun-asr-hotwords"
              v-model="hotwords"
              :min-rows="2"
              :max-rows="5"
              :disabled="loading"
            />
            <template #below>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                :disabled="
                  loading ||
                  hotwords === (config?.funAsrHotwords?.join('\n') ?? '')
                "
                @click="save({ funAsrHotwords: parsedHotwords })"
              >
                保存热词
              </Button>
            </template>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="路径覆盖">
          <SettingsRow title="ffmpeg 路径" layout="stacked">
            <TextField
              :disabled="loading || !config"
              :model-value="config?.ffmpegPath ?? ''"
              placeholder="留空则自动查找"
              @change="
                (event: Event) =>
                  save({
                    ffmpegPath:
                      (event.target as HTMLInputElement).value || undefined,
                  })
              "
            />
          </SettingsRow>
          <SettingsRow v-if="!cloud" title="whisper-cli 路径" layout="stacked">
            <TextField
              :disabled="loading || !config"
              :model-value="config?.whisperPath ?? ''"
              placeholder="留空则自动查找"
              @change="
                (event: Event) =>
                  save({
                    whisperPath:
                      (event.target as HTMLInputElement).value || undefined,
                  })
              "
            />
          </SettingsRow>
        </SettingsGroup>
      </details>
    </template>
    <SettingsGroup title="媒体缓存">
      <SettingsRow
        title="预览代理、缩略图、波形与抽帧"
        :description="
          cacheUsage
            ? '当前配置占用 ' +
              formatBytes(cacheUsage.bytes) +
              '，共 ' +
              cacheUsage.files +
              ' 个文件。'
            : '查看当前配置的本机缓存。'
        "
      >
        <Button
          size="sm"
          variant="secondary"
          :disabled="cacheBusy"
          @click="refreshCache()"
          >刷新</Button
        >
        <Button
          size="sm"
          variant="secondary"
          :disabled="cacheBusy || !cacheUsage?.files"
          @click="refreshCache(true)"
          >清理缓存</Button
        >
      </SettingsRow>
      <p v-if="cacheFeedback" role="status" class="hint">{{ cacheFeedback }}</p>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.analysis-advanced {
  margin-top: var(--space-5);
  color: rgb(var(--text-2));
}
.analysis-advanced summary {
  cursor: pointer;
  font-weight: var(--weight-medium);
  font-size: var(--fs-xs);
}
.analysis-advanced summary:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.analysis-service {
  display: grid;
  gap: var(--space-2) var(--space-3);
  align-items: center;
  grid-template-columns: auto minmax(0, 1fr) auto;
  padding: var(--space-4);
  margin-bottom: var(--space-3);
  border-radius: var(--radius-card);
  background: rgb(var(--editor-accent-soft));
}
.service-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-row);
  background: rgb(var(--editor-accent) / 0.13);
  color: rgb(var(--editor-accent));
}
.service-copy {
  display: grid;
  min-width: 0;
}
.service-copy label {
  font-weight: var(--weight-semibold);
  color: rgb(var(--editor-text));
}
.service-copy span,
.service-state {
  font-size: var(--fs-xxs);
  color: rgb(var(--editor-muted));
}
.service-state {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
  grid-column: 2 / -1;
}
@container (max-width: 440px) {
  .analysis-service {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .analysis-service :deep(.ds-select),
  .service-state {
    grid-column: 2;
  }
}

.hint {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
}
</style>
