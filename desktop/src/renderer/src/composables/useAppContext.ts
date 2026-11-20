import {
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import type {
  BootstrapPayload,
  ChatSendPayload,
  ControlInteraction,
  PendingState,
  QueuedPromptItem,
  RuntimeStatus,
  PermissionPreset,
  TokensPayload,
} from '../types'
import type { SlashPaletteItem } from '../commands'
import type { CommandCompletion } from '@emperor/core/api'
import type { LifecycleTransitionResult } from './composerLifecycle'
import type { ToastOptions } from '../components/ui/toasts'

export interface AppContext {
  boot: Ref<BootstrapPayload | null>
  loading: Ref<boolean>
  error: Ref<string>

  queuedPrompts: Ref<QueuedPromptItem[]>
  pendingInteractionsBySession: Record<string, ControlInteraction>
  busy: Ref<boolean>
  status: Ref<RuntimeStatus>
  pending: PendingState
  sessionId: Ref<string>
  sessionRuntimeStates: Record<string, { running: boolean; attention: boolean }>
  runtimeText: () => string
  eventTransportText: () => string

  commands: ComputedRef<SlashPaletteItem[]>
  refreshCommands: () => Promise<void>
  completeSlashCommand: (
    commandId: string,
    rawArgs: string,
    cursor: number,
  ) => Promise<CommandCompletion[]>

  refreshAll: () => Promise<void>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  /** Open the first-run guide (the hero's 开始接入, UI-S17). */
  openModelSetup: () => void

  setPermissionMode: (
    preset: PermissionPreset,
  ) => Promise<{ ok: boolean; error?: string }>
  activatePlan: () => Promise<LifecycleTransitionResult>
  dismissLifecycle: () => Promise<LifecycleTransitionResult>
  sendMessage: (payload: string | ChatSendPayload) => boolean | Promise<boolean>
  manageQueuedPrompt: (
    promptId: string,
    action: 'cancel' | 'interject' | 'send',
  ) => Promise<boolean>
  sendInteractionAnswer: (
    interactionId: string,
    answers: Record<string, unknown>,
  ) => boolean
  sendPlanComment: (interactionId: string, comment: string) => boolean
  approvePlan: (interactionId: string) => boolean
  cancelInteraction: (interactionId: string) => boolean
  stopActive: () => Promise<boolean>
  /** Resolves `true` once the message or command was accepted. */
  submitFromComposer: (payload: string | ChatSendPayload) => Promise<boolean>

  /** Queue a toast (ui/toasts): info by default, 4 s, at most 3 shown. */
  showToast: (message: string, options?: ToastOptions) => void
  /**
   * Show a failure as a sticky error toast with 「复制详情」; `context`
   * names what failed (「保存记忆失败」). Keeps a Core error's errorId.
   */
  showError: (error: unknown, context?: string) => void
  runSafely: (task: () => Promise<void>) => Promise<void>

  tokens: Ref<TokensPayload | null>
  tokensLoading: Ref<boolean>
  loadTokens: (silent?: boolean) => Promise<void>
}

export const APP_CONTEXT_KEY: InjectionKey<AppContext> = Symbol(
  'emperor-agent:app-context',
)

export function provideAppContext(context: AppContext) {
  provide(APP_CONTEXT_KEY, context)
}

export function useAppContext(): AppContext {
  const ctx = inject(APP_CONTEXT_KEY)
  if (!ctx) {
    throw new Error(
      'useAppContext() called outside of <App>; provideAppContext must run first.',
    )
  }
  return ctx
}
