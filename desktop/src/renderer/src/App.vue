<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CommandDescriptor, CommandSurface } from '@emperor/core/api'
import AppFrame from './components/shell/AppFrame.vue'
import ImageViewerHost from './components/ui/ImageViewerHost.vue'

import {
  goBack,
  goForward,
  installNavHistory,
} from './components/shell/navHistory'

import { useShortcuts } from './composables/useShortcuts'
import { useSettingsRoute } from './components/settings/useSettingsRoute'
import {
  pushToast,
  showErrorToast,
  visibleToasts,
  type ToastOptions,
} from './components/ui/toasts'
import { activeConfirm } from './components/ui/confirm'
import { sessionLocation } from './router'

import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import {
  commandCatalogOwner,
  createCommandCatalogLoader,
  createCommandCompleter,
} from './commandCatalog'
import { onMenuCommand } from './api/backend'
import { core } from './api/http'

import { useBootstrap } from './composables/useBootstrap'
import { useNotifications } from './composables/useNotifications'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useEditingWorkspace } from './components/editing/editingStore'
import { requestEditorAgentFocus } from './components/editing/editorAgentFocus'
import { useTokens } from './composables/useTokens'
import { useSlashCommands } from './composables/useSlashCommands'
import { provideAppContext } from './composables/useAppContext'

import { draftSessionOf } from './runtime/sessionDrafts'
import {
  notificationFromNotice,
  type RuntimeNotice,
} from './runtime/notifications'
import type { SessionInfo } from './types'

// The right workspace (git / files / xterm panes) and the settings modal are
// heavy and not needed for first paint: split them out of the initial chunk.
const SettingsModal = defineAsyncComponent(
  () => import('./components/settings/SettingsModal.vue'),
)
// The first-run guide: at launch with no model at all, or from the hero.
// The confirm() dialog loads on the first request (confirm.ts queues it).
// The toast stack's view loads with the first toast (the queue is eager).
const ToastStack = defineAsyncComponent(
  () => import('./components/ui/ToastStack.vue'),
)
const ConfirmHost = defineAsyncComponent(
  () => import('./components/ui/ConfirmHost.vue'),
)

const router = useRouter()
const route = useRoute()
const settingsRoute = useSettingsRoute()
const commandDescriptors = ref<CommandDescriptor[]>([])

function showToast(message: string, options?: ToastOptions) {
  pushToast(message, options)
}

function showError(error: unknown, context?: string) {
  showErrorToast(error, context)
}

const bootstrap = useBootstrap(showToast, {
  onSessionUnavailable: (sessionId) => void leaveUnavailableSession(sessionId),
})
const sessionStore = useSession()
const editingWorkspace = useEditingWorkspace()
const notifications = useNotifications()
const { boot, loading, error, loadBootstrap, refreshMemory } = bootstrap

const runtime = useRuntime({
  boot,
  refreshMemory,
  refreshCommands: () => loadCommands(),
  showToast,
  showError,
  resolveDraftSession: sessionStore.getSession,
  onSessionCreated: sessionStore.applySessionCreatedEvent,
  onSessionTitleUpdated: sessionStore.applySessionTitleUpdatedEvent,
  onSessionControlPendingChanged: sessionStore.applySessionControlPending,
  refreshSessions: sessionStore.load,
  onNotify: (notice) => notifyFromRuntime(notice),
})
const {
  queuedPrompts,
  pendingInteractionsBySession,
  busy,
  status,
  switchSession,
  pending,
  sessionId,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  dispose: disposeRuntime,
  connectSocket,
  sendMessage,
  manageQueuedPrompt,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  restoreRuntimeState,
  draftSession,
} = runtime

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  // A draft has no bootstrap; ConversationView shows its own plan mode and
  // preset (FIX-13).
  if (sessionStore.isDraftSessionId(id)) return
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreRuntimeState()
}

/**
 * The session was archived or deleted elsewhere (its bootstrap failed and a
 * plain one worked): go to the most recent session and say so (FIX-03).
 */
async function leaveUnavailableSession(sessionId: string): Promise<void> {
  showToast('这个会话已归档或不存在，已回到最近的会话')
  await sessionStore.load().catch(() => undefined)
  const next = sessionStore.sessions.value.find(
    (item) => !item.draft && item.id !== sessionId,
  )
  await router
    .push(next ? sessionLocation(next.id) : { name: 'editor' })
    .catch(() => undefined)
}

const tokensClient = useTokens(showToast)
const {
  data: tokensData,
  loading: tokensLoading,
  load: loadTokens,
} = tokensClient
const slashPaletteItems = computed(() =>
  buildSlashPaletteItems(commandDescriptors.value),
)

onMounted(async () => {
  await runInitialStartup({
    sessionStore,
    bootstrap,
    switchSession,
    restoreRuntimeState,
    connectSocket,
  })
  startupDone.value = true
  await loadCommands()
})

onBeforeUnmount(() => disposeRuntime())

async function refreshAll() {
  // A failed refresh toasts and keeps the shell (useBootstrap, FIX-03).
  if (!(await loadBootstrap(false, sessionStore.backendSessionId()))) return
  connectSocket()
  await loadCommands()
  showToast('工作台已刷新')
}

/**
 * 「重新连接」 on the start-failure screen: a plain bootstrap (never the
 * session that failed), then every open conversation reread from its tail,
 * since live events may have been missed meanwhile (FIX-03).
 */
async function reconnect() {
  if (!(await bootstrap.retry())) return
  restoreRuntimeState()
  connectSocket()
  // The conversation store stays in the chat chunk (first-load budget).
  const { defaultConversationStore } = await import('./conversation/store')
  await defaultConversationStore().resyncAll()
  await loadCommands()
}

/**
 * The session on screen, or the start-page draft with its own mode and
 * project — never another session's catalog (FIX-14).
 */
function commandOwner() {
  const id =
    route.name === 'editor'
      ? editingWorkspace.state.sessionId
      : sessionStore.activeId.value
  return commandCatalogOwner(id, sessionStore.getSession(id))
}

// Another session, draft or draft project: another catalog.
watch(
  () => JSON.stringify(commandOwner()),
  () => void loadCommands(),
)

const commandCatalog = createCommandCatalogLoader({
  currentOwner: commandOwner,
  list: (owner) =>
    core('commands.list', {
      ...owner,
      includeUnavailable: false,
      invocationSource: 'desktop',
    }),
  apply: (commands) => {
    commandDescriptors.value = commands
  },
  onError: (cause) => console.warn('Unable to refresh slash commands', cause),
})

async function loadCommands(): Promise<void> {
  await commandCatalog.refresh()
}

async function resolveCommandSessionId(): Promise<string> {
  const current = sessionStore.backendSessionId()
  if (current) return current
  const draftId = sessionId.value
  // A first message is already creating this draft's session (FIX-13).
  const sending = await draftSession(draftId)
  if (sending) return sending
  const draft = sessionStore.getSession(draftId)
  const { mode, project, ...settings } = draftSessionOf(draft)
  const created = await core('sessions.create', {
    title: draft?.title || '新会话',
    mode,
    project: mode === 'build' ? project : null,
    ...settings,
  })
  // Same promotion path as a first message: swap the draft row in place so the
  // route watcher follows to the real session instead of losing the draft id.
  sessionStore.promoteDraft(draftId, created)
  await onSessionActivate(created.id)
  await loadCommands()
  return created.id
}

const completeSlashCommand = createCommandCompleter({
  currentOwner: commandOwner,
  complete: (input) =>
    core('commands.complete', { ...input, invocationSource: 'desktop' }),
})

async function activateTransitionedSession(
  session: SessionInfo,
): Promise<void> {
  await sessionStore.load()
  await onSessionActivate(session.id)
  await router.push(sessionLocation(session.id)).catch(() => undefined)
  await loadCommands()
}

async function openCommandSurface(
  surface: CommandSurface,
  _params: Record<string, unknown> = {},
): Promise<void> {
  if (surface === 'model' || surface === 'reasoning') {
    await settingsRoute.openSettings('model')
    return
  }
  if (surface === 'permissions') {
    await settingsRoute.openSettings('model')
    return
  }
  if (surface === 'plan') {
    await activatePlan()
    return
  }
}

function openModelSetup() {
  void settingsRoute.openSettings('model')
}

async function runSafely(task: () => Promise<void>) {
  try {
    await task()
  } catch (err) {
    showError(err)
  }
}

const {
  submitFromComposer,
  setPermissionMode,
  activatePlan,
  dismissLifecycle,
} = useSlashCommands({
  boot,
  busy,
  commandDescriptors,
  resolveSessionId: resolveCommandSessionId,
  controlSessionId: () => sessionStore.backendSessionId() || null,
  draftId: () =>
    sessionStore.backendSessionId() ? null : sessionStore.activeId.value,
  updateDraft: sessionStore.updateDraft,
  sendMessage,
  ensureCommands: (timeoutMs) =>
    commandDescriptors.value.length
      ? Promise.resolve()
      : Promise.race([
          loadCommands(),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]),
  refreshAll,
  openCommandSurface,
  activateTransitionedSession,
  showToast,
  showError,
})

const startupDone = ref(false)
const viewedSessionId = computed(() => editingWorkspace.state.sessionId || '')
watch(
  [startupDone, () => route.query.projectSession],
  async ([ready, id]) => {
    if (!ready || typeof id !== 'string') return
    const { projectSession: _projectSession, ...query } = route.query
    await router.replace({ name: 'editor', query })
    try {
      await editingWorkspace.openProject({ sessionId: id })
    } catch {
      showToast('这个链接对应的剪辑工程不可用')
    }
  },
  { immediate: true },
)

function windowHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  )
}

function notifyFromRuntime(notice: RuntimeNotice): void {
  const hidden = windowHidden()
  const input = notificationFromNotice(notice, {
    sessionTitle: (id) => sessionStore.getSession(id)?.title || '',
    viewedSessionId: hidden ? '' : viewedSessionId.value,
    schedulerPageOpen: false,
  })
  if (input) notifications.add(input)
}

// Opening a session (or returning to the window showing it) reads its
// notifications.
watch(viewedSessionId, (id) => notifications.markSessionRead(id), {
  immediate: true,
})

function onVisibilityChange(): void {
  if (!windowHidden()) notifications.markSessionRead(viewedSessionId.value)
}
onMounted(() =>
  document.addEventListener('visibilitychange', onVisibilityChange),
)
onBeforeUnmount(() =>
  document.removeEventListener('visibilitychange', onVisibilityChange),
)

const stopNavHistory = installNavHistory(router)
onBeforeUnmount(stopNavHistory)

async function openWorkspaceConversation(): Promise<void> {
  await router.push({ name: 'editor' }).catch(() => undefined)
  requestEditorAgentFocus(
    editingWorkspace.state.sessionId ? 'composer' : 'setup',
  )
}

useShortcuts({
  'session.new': () => runSafely(openWorkspaceConversation),
  'nav.back': () => goBack(router),
  'nav.forward': () => goForward(router),
})

// 应用菜单 › 偏好设置… (⌘,).
const stopMenuCommands = onMenuCommand((command) => {
  if (command === 'open-settings') void settingsRoute.openSettings('model')
})
onBeforeUnmount(stopMenuCommands)

provideAppContext({
  boot,
  loading,
  error,
  queuedPrompts,
  pendingInteractionsBySession,
  busy,
  status,
  pending,
  sessionId,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  commands: slashPaletteItems,
  refreshCommands: loadCommands,
  completeSlashCommand,
  refreshAll,
  refreshMemory,
  openModelSetup,
  setPermissionMode,
  activatePlan,
  dismissLifecycle,
  sendMessage,
  manageQueuedPrompt,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  submitFromComposer,
  showToast,
  showError,
  runSafely,
  tokens: tokensData,
  tokensLoading,
  loadTokens,
})
</script>

<template>
  <div v-if="loading" class="boot-screen">
    <div class="boot-card" role="status">
      <span class="boot-dot" />正在连接本地智能体服务
    </div>
  </div>

  <div v-else-if="error" class="boot-screen">
    <div class="boot-card boot-error" role="alert">
      <strong>桌面端启动失败</strong>
      <p>{{ error }}</p>
      <button type="button" class="boot-retry" @click="reconnect">
        重新连接
      </button>
    </div>
  </div>

  <template v-else>
    <AppFrame :workspace-available="false" :center-min="0">
      <router-view v-slot="{ Component }">
        <keep-alive :max="6">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </AppFrame>
    <ImageViewerHost :owner="viewedSessionId" />
    <SettingsModal editing-only />
  </template>

  <ToastStack v-if="visibleToasts.length" />
  <ConfirmHost v-if="activeConfirm" />
</template>

<style scoped>
.boot-screen {
  display: grid;
  place-items: center;
  height: 100dvh;
  background: rgb(var(--surface-canvas));
  color: rgb(var(--text-2));
}

.boot-card {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 420px;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-takeover);
  background: rgb(var(--surface-base));
  box-shadow: var(--shadow-lv2);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  text-align: center;
}

.boot-card:not(.boot-error) {
  flex-direction: row;
}

.boot-dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
  animation: ds-fade-in 1s ease-in-out infinite alternate;
}

.boot-error strong {
  color: rgb(var(--text-1));
  font-size: var(--fs-base);
  font-weight: var(--weight-medium);
}

.boot-error p {
  margin: 0;
  color: rgb(var(--error));
  word-break: break-word;
}

.boot-retry {
  height: calc(var(--space-8) + var(--space-1));
  padding: 0 var(--space-3-5);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--button-primary-fill));
  color: rgb(var(--button-primary-fg));
  font-size: var(--fs-s);
  cursor: pointer;
}
</style>
