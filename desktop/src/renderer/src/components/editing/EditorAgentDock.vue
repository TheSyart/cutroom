<script setup lang="ts">
import { writableReferences } from '../composer/editor/referenceText'
import type { MessageReference } from '../../types'
/** Project-scoped editing controls around the shared conversation. */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { EDITING_AGENT_NAME } from '../../../../shared/app-brand'
import { Spline } from 'lucide-vue-next'
import Button from '../ui/Button.vue'
import MenuItem from '../ui/MenuItem.vue'
import ChatTimeline from '../conversation/ChatTimeline.vue'
import TakeoverSeat from '../conversation/takeover/TakeoverSeat.vue'
import { activeTakeover } from '../conversation/takeover/takeoverModel'
import { invokeCore, onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useSessionConversation } from '../../composables/useSessionConversation'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import { useEditingWorkspace } from './editingStore'
import ComposerCard from '../composer/ComposerCard.vue'
import { activateModelEntry, setModelReasoningEffort } from '../../api/model'
import { applyModelConfig } from '../../model/applyModelConfig'
import EditorPrecisionRun from './EditorPrecisionRun.vue'
import {
  isEditing,
  type EditRunAction,
  type EditRunStatus,
} from './editorPrecisionRun'
import { confirm } from '../ui/confirm'
import { clearEditorAgentFocus, editorAgentFocus } from './editorAgentFocus'
import {
  editorTimelineHandoff,
  takeTimelineReferences,
} from './editorTimelineHandoff'
import type {
  ChatSendPayload,
  ControlInteraction,
  ControlPayload,
  PermissionPreset,
} from '../../types'

const props = defineProps<{
  captureFrame?: () => Promise<File>
  sessionId: string
}>()

const ctx = useAppContext()
const settingsRoute = useSettingsRoute()
const workspace = useEditingWorkspace()
const conversation = useSessionConversation(() => props.sessionId)
const composer = ref<InstanceType<typeof ComposerCard> | null>(null)
const timeline = ref<InstanceType<typeof ChatTimeline> | null>(null)
const control = ref<ControlPayload | null>(null)
const hydratedPending = ref<ControlInteraction | null>(null)
const sending = ref(false)
const stopping = ref(false)
const error = ref('')
const editRun = ref<EditRunStatus | null>(null)
const editAction = ref<EditRunAction | null>(null)
const actionFailure = ref<{
  runId: string
  action: EditRunAction
  message: string
} | null>(null)
let poll: number | undefined
let polling = false
let statusGeneration = 0
let stopGeneration = 0
let pendingGeneration = 0
let stopCoreEvents: (() => void) | undefined
let awaitingMessage: {
  sessionId: string
  clientMessageId: string
  accepted: boolean
} | null = null

const running = computed(() => conversation.value?.running.value ?? false)
const pending = computed(
  () =>
    ctx.pendingInteractionsBySession[props.sessionId] ??
    hydratedPending.value ??
    null,
)
const takeover = computed(() => activeTakeover(pending.value))
const model = computed(() => ctx.boot.value?.modelConfig?.current ?? null)
const vision = computed(
  () => ctx.boot.value?.modelConfig?.current?.capabilities?.vision === true,
)
const modelEntries = computed(() => ctx.boot.value?.modelConfig?.models ?? [])
const providerOptions = computed(
  () => ctx.boot.value?.modelConfig?.providerOptions ?? [],
)
const modelUsable = computed(
  () =>
    Boolean(model.value) &&
    ctx.boot.value?.modelConfig?.availability?.usable !== false,
)
const disabledReason = computed(() => {
  if (!modelUsable.value)
    return (
      ctx.boot.value?.modelConfig?.availability?.message ||
      '还没有可用的剪辑模型，请先配置 DeepSeek。'
    )
  return ''
})
const workingOnEdit = computed(() => isEditing(editRun.value?.state))
const busy = computed(
  () =>
    running.value ||
    workingOnEdit.value ||
    editRun.value?.state === 'awaiting_approval' ||
    Boolean(editAction.value),
)
const preparationLabels: Record<string, string> = {
  video_project_read: '正在读取工程时间线',
  video_start_precision_edit: '正在启动整片精剪',
  video_transcribe: '正在转写素材原声',
  video_inspect_frames: '正在检查素材画面',
  video_motion_read: '正在读取动效场景',
  video_motion_begin: '正在建立动效场景',
  video_motion_object: '正在绘制动效对象',
  video_motion_finish: '正在检查动效并保存',
  video_motion_cancel: '正在撤回未完成的绘制',
  video_edit_preview: '正在预演时间线修改',
  video_edit_apply: '正在修改时间线',
  video_edit_history: '正在恢复工程版本',
  video_project_focus: '正在定位播放头',
  video_analyze_workspace: '正在分析精剪工程',
  video_read_video: '正在查看视频画面',
  video_read_evidence: '正在核对指定帧',
  video_read_source_notes: '正在读取素材笔记',
  video_record_source_notes: '正在保存素材笔记',
  video_propose_treatment: '正在提交精剪方案',
  video_review_draft: '正在复检精剪草稿',
  video_preview_edit: '正在检查草稿修改',
  video_stage_edit: '正在保存草稿修改',
  video_finish_draft: '正在提交精剪草稿',
}
const preparationCalls = reactive(new Map<string, string>())
const hiddenWorkId = ref('')
let observedWorkId = ''
watch(
  () => workspace.state.motionWork,
  (work) => {
    if (!work) return
    if (work.status === 'preparing' || work.status === 'drawing')
      observedWorkId = work.id
    else if (
      work.id !== observedWorkId &&
      (sending.value || running.value || workingOnEdit.value)
    )
      hiddenWorkId.value = work.id
  },
  { immediate: true, flush: 'sync' },
)
let preparationTurn = ''
function beginPreparation(turn = ''): void {
  preparationTurn = turn
  preparationCalls.clear()
  const work = workspace.state.motionWork
  if (work && !['drawing', 'preparing'].includes(work.status))
    hiddenWorkId.value = work.id
}
const motionStatus = computed(() => {
  const work = workspace.state.motionWork
  if (work && work.id !== hiddenWorkId.value)
    return {
      status: work.status,
      message: (work.target === 'draft' ? '草稿 · ' : '') + work.message,
    }
  if (
    !workspace.state.motionEnabled ||
    takeover.value ||
    editRun.value?.state === 'awaiting_approval'
  )
    return null
  const call = [...preparationCalls.values()].at(-1)
  if (call) return { status: 'tool', message: call }
  return (sending.value || running.value || workingOnEdit.value) &&
    !stopping.value
    ? { status: 'waiting', message: '正在等待模型响应' }
    : null
})
function updatePreparation(data: Record<string, unknown>): void {
  if (data.event === 'turn_phase' && data.phase === 'started') {
    beginPreparation(typeof data.turn_id === 'string' ? data.turn_id : '')
    return
  }
  if (preparationTurn && data.turn_id && data.turn_id !== preparationTurn)
    return
  if (
    (data.event === 'turn_phase' && data.phase === 'interrupted') ||
    data.event === 'assistant_done' ||
    data.event === 'error'
  ) {
    preparationCalls.clear()
    return
  }
  if (typeof data.id !== 'string') return
  if (
    (data.event === 'tool_call' || data.event === 'tool_run_started') &&
    typeof data.name === 'string'
  )
    preparationCalls.set(
      data.id,
      preparationLabels[data.name] ?? '正在执行工具',
    )
  else if (
    [
      'tool_result',
      'tool_error',
      'tool_run_completed',
      'tool_run_failed',
      'tool_run_cancelled',
    ].includes(String(data.event))
  )
    preparationCalls.delete(data.id)
}
async function refreshEditRun(): Promise<void> {
  if (polling || editAction.value || sending.value) return
  const sessionId = props.sessionId
  const generation = statusGeneration
  polling = true
  try {
    const result = await invokeCore('videoProject.editRunStatus', {
      sessionId,
    })
    if (sessionId === props.sessionId && generation === statusGeneration)
      editRun.value = result?.runId ? result : null
  } catch {
    // An unavailable status operation should not interrupt ordinary editing.
  } finally {
    polling = false
    if (sessionId !== props.sessionId && poll !== undefined)
      void refreshEditRun()
  }
}

async function changeEditRun(action: EditRunAction): Promise<void> {
  const runId = editRun.value?.runId
  if (!runId || editAction.value || sending.value) return
  const sessionId = props.sessionId
  const generation = ++statusGeneration
  error.value = ''
  actionFailure.value = null
  editAction.value = action
  try {
    if (action === 'restore' || action === 'adopt') {
      const restore = action === 'restore'
      const accepted = await confirm({
        title: restore ? '恢复到本次精剪开始前？' : '采用本次精剪草稿？',
        body: restore
          ? '整个工程将恢复到这次精剪开始前的版本。'
          : '将用这份精剪草稿替换当前时间线。',
        confirmLabel: restore ? '恢复工程' : '采用草稿',
      })
      if (!accepted || generation !== statusGeneration) return
    }
    if (action === 'cancel') workspace.interruptMotion()
    const result = await invokeCore('videoProject.editRunAction', {
      sessionId,
      runId,
      action,
    })
    if (generation === statusGeneration) editRun.value = result
  } catch (cause: unknown) {
    if (generation === statusGeneration)
      actionFailure.value = {
        runId,
        action,
        message: cause instanceof Error ? cause.message : String(cause),
      }
  } finally {
    if (generation === statusGeneration) editAction.value = null
  }
}

function appendTimelineReferences(): void {
  const input = composer.value
  if (!input) return
  for (const reference of takeTimelineReferences(props.sessionId))
    input.insertTimelineReference(reference)
}

async function hydratePending(): Promise<void> {
  const sessionId = props.sessionId
  const generation = ++pendingGeneration
  hydratedPending.value = null
  try {
    const result = (await core(
      'control.get',
      sessionId,
    )) as unknown as ControlPayload | null
    if (sessionId === props.sessionId && generation === pendingGeneration) {
      control.value = result
      if (result?.pending?.status === 'waiting')
        hydratedPending.value = result.pending
    }
  } catch {
    // The live event stream still delivers a later interaction.
  }
}

function handleCoreEvent(event: unknown): void {
  if (!event || typeof event !== 'object') return
  const data = event as Record<string, unknown>
  if (data.session_id !== props.sessionId) return
  updatePreparation(data)
  if (data.event === 'control_mode_update' && data.control) {
    pendingGeneration++
    control.value = data.control as ControlPayload
    return
  }
  if (
    data.event === 'user_message' &&
    awaitingMessage?.sessionId === props.sessionId &&
    data.client_message_id === awaitingMessage.clientMessageId
  ) {
    awaitingMessage.accepted = true
    return
  }
  if (data.event === 'video_edit_draft_changed') {
    void refreshEditRun()
    return
  }
  if (
    data.event === 'ask_answered' ||
    data.event === 'plan_comment_added' ||
    data.event === 'plan_approved' ||
    data.event === 'interaction_cancelled'
  ) {
    const interactionId = (data.interaction as { id?: string } | undefined)?.id
    if (
      !interactionId ||
      !hydratedPending.value ||
      interactionId === hydratedPending.value.id
    ) {
      pendingGeneration++
      hydratedPending.value = null
    }
    void refreshEditRun()
  }
}

async function send(payload: ChatSendPayload): Promise<boolean> {
  if (busy.value || sending.value || disabledReason.value) return false
  const attachments = payload.attachments ?? []
  const sessionId = props.sessionId
  const generation = ++statusGeneration
  const receipt = {
    sessionId,
    clientMessageId: `editor-${crypto.randomUUID()}`,
    accepted: false,
  }
  beginPreparation()
  sending.value = true
  error.value = ''
  try {
    awaitingMessage = receipt
    await invokeCore('chat.submit', {
      sessionId,
      content: payload.content,
      displayContent: payload.displayContent || payload.content,
      clientMessageId: receipt.clientMessageId,
      ...(attachments.length
        ? { attachments: attachments.map((file) => file.id) }
        : {}),
      ...(payload.requestedSkills?.length
        ? { requestedSkills: payload.requestedSkills }
        : {}),
      ...(payload.references?.length
        ? { references: writableReferences(payload.references) }
        : {}),
    })
    return true
  } catch (cause: unknown) {
    if (generation === statusGeneration && sessionId === props.sessionId)
      error.value = cause instanceof Error ? cause.message : String(cause)
    return receipt.accepted
  } finally {
    if (awaitingMessage === receipt) awaitingMessage = null
    if (generation === statusGeneration && sessionId === props.sessionId) {
      sending.value = false
      void refreshEditRun()
    }
  }
}

function stop(): void {
  if (stopping.value || editAction.value) return
  if (workingOnEdit.value || editRun.value?.state === 'awaiting_approval') {
    void changeEditRun('cancel')
    return
  }
  workspace.interruptMotion()
  stopping.value = true
  const generation = ++stopGeneration
  error.value = ''
  void invokeCore('chat.stopRuntime', { sessionId: props.sessionId })
    .catch((cause: unknown) => {
      if (generation === stopGeneration)
        error.value = cause instanceof Error ? cause.message : String(cause)
    })
    .finally(() => {
      if (generation === stopGeneration) stopping.value = false
    })
}

function openModelSettings(): void {
  if (!ctx.boot.value?.modelConfig?.current) ctx.openModelSetup()
  else void settingsRoute.openSettings('model')
}

function editMessage(
  text: string,
  references?: readonly MessageReference[],
): void {
  composer.value?.setDraft(text, references)
}

async function setPlanMode(enabled: boolean): Promise<void> {
  const sessionId = props.sessionId
  if (busy.value || sending.value) return
  try {
    const result = await core(
      'control.setMode',
      enabled ? 'plan' : 'default',
      sessionId,
    )
    if (sessionId === props.sessionId)
      control.value = result.control as unknown as ControlPayload
  } catch (cause) {
    if (sessionId === props.sessionId)
      error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function changePermission(preset: PermissionPreset): Promise<void> {
  const sessionId = props.sessionId
  try {
    const result = (await core(
      'control.setPermissionMode',
      preset,
      sessionId,
    )) as unknown as ControlPayload
    if (sessionId === props.sessionId) control.value = result
  } catch (cause: unknown) {
    if (sessionId === props.sessionId)
      error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function switchModel(entryId: string): void {
  if (model.value?.entryId === entryId) return
  void ctx.runSafely(async () => {
    applyModelConfig(ctx.boot.value, await activateModelEntry(entryId))
  })
}

function changeReasoning(level: string | null): void {
  const entryId = model.value?.entryId
  if (!entryId || (model.value?.reasoningEffort ?? null) === level) return
  void ctx.runSafely(async () => {
    applyModelConfig(
      ctx.boot.value,
      await setModelReasoningEffort(entryId, level),
    )
  })
}

function seekConversationLink(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest(
    'a[href^="#ve-cut-"]',
  )
  const match =
    anchor &&
    /^#ve-cut-(\d+(?:\.\d+)?)$/.exec(anchor.getAttribute('href') ?? '')
  if (!match) return
  const time = Number(match[1])
  if (!Number.isFinite(time)) return
  event.preventDefault()
  event.stopPropagation()
  workspace.applyAgentFocus({ time })
}

function focusComposer(): void {
  const request = editorAgentFocus.value
  if (!request || request.target !== 'composer') return
  void nextTick(() => {
    composer.value?.focusInput()
    clearEditorAgentFocus(request.id)
  })
}

watch(
  () => props.sessionId,
  () => {
    preparationCalls.clear()
    preparationTurn = ''
    hiddenWorkId.value = ''
    observedWorkId = ''
    statusGeneration++
    awaitingMessage = null
    error.value = ''
    sending.value = false
    editRun.value = null
    editAction.value = null
    stopGeneration++
    stopping.value = false
    actionFailure.value = null
    control.value = null
    hydratedPending.value = null
    void hydratePending()
    void refreshEditRun()
  },
)

watch(editorAgentFocus, () => focusComposer(), { flush: 'post' })

watch(
  [composer, () => editorTimelineHandoff.get(props.sessionId)],
  () => void nextTick(appendTimelineReferences),
  { flush: 'post' },
)

watch(
  [running, workingOnEdit],
  ([chat, precision]) => {
    if (!chat && !precision) preparationCalls.clear()
  },
  { flush: 'post' },
)
watch([running, pending], () => void refreshEditRun())

onMounted(() => {
  stopCoreEvents = onCoreEvent(handleCoreEvent)
  void hydratePending()
  void refreshEditRun()
  poll = window.setInterval(() => void refreshEditRun(), 2_000)
  focusComposer()
})
onBeforeUnmount(() => {
  stopCoreEvents?.()
  pendingGeneration++
  statusGeneration++
  window.clearInterval(poll)
  poll = undefined
})
</script>

<template>
  <section class="agent-dock" :aria-label="EDITING_AGENT_NAME">
    <div
      v-if="editRun && !takeover"
      class="dock-tasks"
      data-testid="editor-current-tasks"
    >
      <EditorPrecisionRun
        :key="editRun.runId"
        :status="editRun"
        :session-id="sessionId"
        :current-revision="workspace.state.project?.revision"
        :busy="Boolean(editAction) || sending"
        :failure="actionFailure?.runId === editRun.runId ? actionFailure : null"
        @action="changeEditRun"
        @seek="workspace.applyAgentFocus({ time: $event })"
      />
    </div>
    <div class="dock-body" @click.capture="seekConversationLink">
      <ChatTimeline
        :key="sessionId"
        ref="timeline"
        :session-id="sessionId"
        :root-session-id="sessionId"
        @inspect="timeline?.revealCall($event)"
        @edit-message="editMessage"
      />
    </div>
    <div class="dock-composer" data-testid="editor-agent-composer">
      <div
        v-if="motionStatus"
        class="motion-status"
        data-testid="motion-work-status"
        :data-status="motionStatus.status"
        role="status"
      >
        {{ motionStatus.message }}
      </div>
      <div v-if="disabledReason" class="composer-notice">
        <span>{{ disabledReason }}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          @click="openModelSettings"
          >配置模型</Button
        >
      </div>
      <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
      <TakeoverSeat v-if="takeover" :interaction="takeover.interaction" />
      <ComposerCard
        v-show="!takeover"
        :key="sessionId"
        ref="composer"
        :capture-frame="captureFrame"
        :dictation-chat="sessionId"
        :busy="busy || stopping"
        :interaction-blocked="Boolean(takeover)"
        :send-blocked-reason="
          disabledReason || (busy || sending ? '等当前任务结束后再发送。' : '')
        "
        :commands="ctx.commands?.value ?? []"
        :context-used="0"
        :context-max="0"
        :control="control"
        :lifecycle-mode="control?.plan ? 'plan' : null"
        :current-model="model"
        :model-entries="modelEntries"
        :provider-options="providerOptions"
        :supports-vision="vision"
        :complete-command="ctx.completeSlashCommand"
        :refresh-commands="ctx.refreshCommands"
        @send="send"
        @stop="stop"
        @error="error = $event"
        @set-permission="changePermission"
        @activate-plan="setPlanMode(true)"
        @dismiss-lifecycle="setPlanMode(false)"
        @switch-model="switchModel"
        @set-reasoning-effort="changeReasoning"
      >
        <template v-slot:add-menu-items>
          <MenuItem
            role="menuitemcheckbox"
            class="motion-option"
            data-testid="motion-enabled"
            :aria-checked="Boolean(workspace.state.motionEnabled)"
            :aria-disabled="workspace.state.motionSettingsBusy || undefined"
            keep-open
            @select="workspace.setMotionEnabled(!workspace.state.motionEnabled)"
          >
            <template #icon><Spline :size="16" /></template>
            动效绘制
            <template #trailing
              ><span class="switch-track" aria-hidden="true"
            /></template>
          </MenuItem>
        </template>
      </ComposerCard>
    </div>
  </section>
</template>

<style scoped>
.agent-dock {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  background: rgb(var(--editor-panel));
}
.dock-tasks {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 55%;
  padding: var(--space-2);
  overflow: auto;
  overscroll-behavior: contain;
  border-bottom: 0.5px solid rgb(var(--editor-line));
}
.dock-composer :deep([data-takeover]) {
  padding: 0;
}
.dock-composer :deep([data-takeover] .card) {
  display: flex;
  flex-direction: column;
  max-height: min(35vh, 350px);
}
.dock-composer :deep([data-takeover] .body) {
  min-height: 0;
  overflow-y: auto;
}
.dock-composer :deep([data-takeover] .actions),
.dock-composer :deep([data-takeover] .strip) {
  flex: none;
}
.dock-body {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.dock-body :deep(.scroller) {
  padding-inline: clamp(11px, 4%, var(--space-5));
  padding-bottom: var(--space-3);
}
.dock-composer {
  flex: none;
  min-width: 0;
  margin: var(--space-1-5) var(--space-2) var(--space-2);
}
.dock-composer :deep(.composer-editor) {
  max-height: min(22vh, 140px);
  overflow-y: auto;
}
.motion-status {
  min-width: 0;
  max-height: 3em;
  margin-bottom: var(--space-1-5);
  overflow: auto;
  overflow-wrap: anywhere;
  font: var(--font-xxs);
  line-height: 1.5;
  color: rgb(var(--editor-text));
}
.motion-status[data-status='failed'] {
  color: rgb(var(--error));
}
.motion-option[aria-disabled='true'] {
  opacity: 0.5;
  cursor: default;
}
.switch-track {
  width: 22px;
  height: 12px;
  padding: 2px;
  box-sizing: border-box;
  border-radius: var(--r-full);
  background: rgb(var(--editor-muted));
}
.switch-track::after {
  content: '';
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--switch-thumb));
}
.motion-option[aria-checked='true'] .switch-track {
  background: rgb(var(--editor-accent));
}
.motion-option[aria-checked='true'] .switch-track::after {
  transform: translateX(10px);
}
.composer-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  font: var(--font-xxs);
  color: rgb(var(--text-2));
}
.composer-error {
  margin: 0 0 var(--space-1);
  color: rgb(var(--error));
  font: var(--font-xxs);
}
</style>
