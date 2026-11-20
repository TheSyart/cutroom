<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Clapperboard, LocateFixed } from 'lucide-vue-next'
import Button from '../ui/Button.vue'
import { core } from '../../api/http'
import { formatTimecode } from './editingViewModel'
import {
  editRunLabels,
  isEditing,
  type EditRunAction,
  type EditRunStatus,
} from './editorPrecisionRun'

const props = defineProps<{
  status: EditRunStatus
  sessionId: string
  currentRevision?: number
  busy: boolean
  failure?: { action: EditRunAction; message: string } | null
}>()
const emit = defineEmits<{
  action: [action: EditRunAction]
  seek: [time: number]
}>()

const previewDetails = ref<HTMLDetailsElement | null>(null)
const preview = ref<HTMLVideoElement | null>(null)
const previewUrl = ref('')
const previewError = ref('')
const loadingPreview = ref(false)
let pendingCue: number | null = null

watch([() => props.sessionId, () => props.status.previewPath], () => {
  previewUrl.value = ''
  previewError.value = ''
  loadingPreview.value = false
  pendingCue = null
  if (previewDetails.value) previewDetails.value.open = false
})

async function openPreview(): Promise<void> {
  const path = props.status.previewPath
  const sessionId = props.sessionId
  if (
    !path ||
    !previewDetails.value?.open ||
    previewUrl.value ||
    loadingPreview.value
  )
    return
  loadingPreview.value = true
  previewError.value = ''
  try {
    const { url } = await core('files.mediaUrl', {
      source: 'project',
      sessionId,
      path,
    })
    if (path === props.status.previewPath && sessionId === props.sessionId)
      previewUrl.value = url
  } catch {
    if (path === props.status.previewPath && sessionId === props.sessionId)
      previewError.value = '无法载入审片预览，请重试。'
  } finally {
    if (path === props.status.previewPath && sessionId === props.sessionId)
      loadingPreview.value = false
  }
}

function togglePreview(): void {
  if (previewDetails.value?.open) void openPreview()
  else preview.value?.pause()
}

function previewPlaybackFailed(): void {
  previewUrl.value = ''
  previewError.value = '无法播放审片预览，请重试。'
}

function applyPreviewCue(): void {
  if (!preview.value?.readyState || pendingCue === null) return
  preview.value.pause()
  preview.value.currentTime = pendingCue
  pendingCue = null
}

function seek(time: number): void {
  if (reviewMatchesTimeline.value || !previewDetails.value) {
    emit('seek', time)
    return
  }
  pendingCue = time
  previewDetails.value.open = true
  void openPreview().then(() => nextTick(applyPreviewCue))
}

const stageLabel = computed(() =>
  props.status.canAdopt ? '精剪草稿待采用' : editRunLabels[props.status.state],
)
const canCancel = computed(
  () =>
    isEditing(props.status.state) ||
    props.status.state === 'awaiting_approval' ||
    props.status.state === 'paused' ||
    props.status.state === 'conflict',
)
const reviewMatchesTimeline = computed(
  () =>
    props.status.state === 'delivered' &&
    (props.status.revision === undefined ||
      props.status.revision === props.currentRevision),
)
const revisionLabel = computed(() => {
  const { revision, duration } = props.status
  return [
    revision !== undefined ? `r${revision}` : '',
    duration !== undefined ? formatTimecode(duration) : '',
  ]
    .filter(Boolean)
    .join(' · ')
})
</script>

<template>
  <section class="precision-run" aria-label="精剪任务">
    <details
      class="run-details"
      :open="
        status.state === 'awaiting_approval' ||
        status.canAdopt ||
        status.canResume
      "
    >
      <summary class="run-heading" aria-live="polite" aria-atomic="true">
        <span class="run-title">
          <Clapperboard :size="16" />
          <strong>{{ stageLabel }}</strong>
          <span v-if="revisionLabel" class="revision">{{ revisionLabel }}</span>
          <span
            v-if="isEditing(status.state)"
            class="activity"
            aria-hidden="true"
          />
          <span class="disclosure" aria-hidden="true">›</span>
        </span>
        <span
          v-if="status.message && status.message !== stageLabel"
          class="run-message"
          >{{ status.message }}</span
        >
      </summary>
      <p v-if="status.captionReview" class="run-hint">
        字幕成片检查 {{ status.captionReview.checked }} /
        {{ status.captionReview.total }} 条
      </p>
      <p v-if="reviewMatchesTimeline" class="run-hint">
        可以在预览中播放、在时间线上继续修改，完成后从工具栏导出。
      </p>
      <p v-else-if="status.state === 'delivered'" class="run-hint">
        已交付版本可在审片预览中回看。工具栏导出使用当前时间线。
      </p>
      <p v-if="failure" class="action-error" role="alert">
        {{ failure.message }}
      </p>
      <div class="actions">
        <Button
          v-if="status.canResume"
          type="button"
          size="sm"
          variant="primary"
          :disabled="busy"
          @click="emit('action', 'resume')"
        >
          {{ failure?.action === 'resume' ? '重试继续精剪' : '继续精剪' }}
        </Button>
        <Button
          v-if="status.canAdopt"
          type="button"
          size="sm"
          :variant="status.canResume ? 'secondary' : 'primary'"
          :disabled="busy"
          @click="emit('action', 'adopt')"
        >
          {{
            failure?.action === 'adopt' ? '重试采用精剪草稿' : '采用精剪草稿'
          }}
        </Button>
        <Button
          v-if="status.canRestore"
          type="button"
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="emit('action', 'restore')"
        >
          {{
            failure?.action === 'restore'
              ? '重试恢复精剪前版本'
              : '恢复精剪前版本'
          }}
        </Button>
        <Button
          v-if="canCancel"
          type="button"
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="emit('action', 'cancel')"
        >
          {{
            failure?.action === 'cancel'
              ? '重试取消'
              : status.state === 'conflict'
                ? '保留当前时间线'
                : '取消精剪'
          }}
        </Button>
      </div>
      <details
        v-if="status.treatment"
        :open="status.state === 'awaiting_approval'"
      >
        <summary>剪辑思路</summary>
        <div class="run-content">
          <p>{{ status.treatment.summary }}</p>
          <dl>
            <template v-if="status.treatment.sections?.length">
              <dt>段落</dt>
              <dd>
                <ul>
                  <li
                    v-for="(section, index) in status.treatment.sections"
                    :key="index"
                  >
                    {{ section }}
                  </li>
                </ul>
              </dd>
            </template>
            <template v-if="status.treatment.mustKeep.length">
              <dt>保留</dt>
              <dd>
                <ul>
                  <li
                    v-for="(item, index) in status.treatment.mustKeep"
                    :key="index"
                  >
                    {{ item }}
                  </li>
                </ul>
              </dd>
            </template>
            <dt>节奏</dt>
            <dd>{{ status.treatment.pacing }}</dd>
            <dt>画面</dt>
            <dd>{{ status.treatment.picture }}</dd>
          </dl>
        </div>
      </details>
      <details v-if="status.issues?.length || status.bookmarks?.length" open>
        <summary v-if="status.issues?.length">
          审片问题 · {{ status.issues.length }}
        </summary>
        <summary v-else>审片标记</summary>
        <div class="run-content cue-list">
          <Button
            v-for="(issue, index) in status.issues"
            :key="`${issue.code}-${index}`"
            type="button"
            size="sm"
            variant="ghost"
            :data-severity="issue.severity"
            class="cue"
            @click="seek(issue.start)"
          >
            <template #icon><LocateFixed :size="12" /></template>
            <time>{{ formatTimecode(issue.start) }}</time>
            {{ issue.message }}
          </Button>
          <Button
            v-for="(bookmark, index) in status.bookmarks"
            :key="`bookmark-${index}`"
            type="button"
            size="sm"
            variant="ghost"
            class="cue"
            @click="seek(bookmark.time)"
          >
            <template #icon><LocateFixed :size="12" /></template>
            <time>{{ formatTimecode(bookmark.time) }}</time>
            {{ bookmark.label }}
          </Button>
        </div>
      </details>
      <details
        v-if="status.previewPath"
        ref="previewDetails"
        @toggle="togglePreview"
      >
        <summary>播放审片预览</summary>
        <div class="run-content">
          <video
            v-if="previewUrl"
            ref="preview"
            :src="previewUrl"
            aria-label="精剪审片预览"
            controls
            playsinline
            preload="metadata"
            @loadedmetadata="applyPreviewCue"
            @error="previewPlaybackFailed"
          />
          <p v-if="loadingPreview" role="status">正在加载审片预览…</p>
          <p v-if="previewError" role="alert">{{ previewError }}</p>
          <Button
            v-if="previewError"
            type="button"
            size="sm"
            variant="ghost"
            @click="openPreview"
            >重试</Button
          >
        </div>
      </details>
    </details>
  </section>
</template>

<style scoped>
.precision-run {
  min-width: 0;
  padding: var(--space-2) var(--space-2-5);
  border: 0.5px solid rgb(var(--editor-line));
  border-radius: var(--r-sm);
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
  font-size: var(--fs-xxs);
  line-height: 1.5;
}
.run-title,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
}
.run-heading {
  cursor: pointer;
  list-style: none;
}
.run-heading::-webkit-details-marker {
  display: none;
}
.run-title > svg {
  color: rgb(var(--editor-accent));
}
.disclosure {
  font-size: 17px;
  line-height: 1;
}
.run-details[open] .disclosure {
  transform: rotate(90deg);
}
.run-title strong {
  flex: 1;
  font-weight: var(--weight-semibold);
}
.revision,
.run-hint,
dt {
  color: rgb(var(--editor-muted));
}
.run-message {
  display: block;
  color: rgb(var(--editor-muted));
}
.action-error {
  margin: var(--space-2) 0;
  color: rgb(var(--error));
}
.activity {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(var(--accent));
  box-shadow: 0 0 0 3px rgb(var(--accent) / 0.14);
}
.run-message,
.run-hint {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
}
video {
  display: block;
  width: 100%;
}
.run-details > details,
.actions {
  margin-top: var(--space-2);
}
.actions:empty {
  display: none;
}
summary {
  cursor: pointer;
}
.run-content {
  margin: var(--space-1-5) 0 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--r-sm);
  background: rgb(var(--surface-base));
  overflow-wrap: anywhere;
}
.run-content p,
.run-content ul,
dl,
dd {
  margin: 0;
}
dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  padding-top: var(--space-1);
}
.run-content ul {
  padding-left: var(--space-3);
}
.cue-list {
  display: grid;
  gap: var(--space-1);
}
.cue {
  justify-content: flex-start;
  gap: var(--space-1);
  width: 100%;
  height: auto;
  min-height: 26px;
  text-align: left;
  white-space: normal;
}
.cue time {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-3));
}
.cue[data-severity='error'] time {
  color: rgb(var(--error));
}
</style>
