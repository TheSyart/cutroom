import type { ControlPayload } from '../types'

export type ComposerLifecycleMode = 'plan' | null
export interface LifecycleTransitionResult {
  ok: boolean
  changed: boolean
  mode: ComposerLifecycleMode
  message?: string
  error?: string
}

export function composerLifecycleMode(
  control: ControlPayload | null | undefined,
): ComposerLifecycleMode {
  return control?.plan ? 'plan' : null
}

export function createComposerLifecycleController(options: {
  currentControl: () => ControlPayload | null | undefined
  agentBusy: () => boolean
  setPlanEnabled: (enabled: boolean) => Promise<void>
}) {
  let transitioning = false
  async function change(enabled: boolean): Promise<LifecycleTransitionResult> {
    const mode = composerLifecycleMode(options.currentControl())
    if ((mode === 'plan') === enabled) return { ok: true, changed: false, mode }
    if (transitioning || options.agentBusy())
      return {
        ok: false,
        changed: false,
        mode,
        error: '当前任务运行中，请先停止后再切换模式。',
      }
    transitioning = true
    try {
      await options.setPlanEnabled(enabled)
      return { ok: true, changed: true, mode: enabled ? 'plan' : null }
    } catch (error) {
      return {
        ok: false,
        changed: false,
        mode,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      transitioning = false
    }
  }
  return {
    activatePlan: () => change(true),
    deactivatePlan: () => change(false),
    dismissLifecycle: () => change(false),
  }
}
