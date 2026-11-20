import { ref } from 'vue'
import { core } from '../api/http'
import type { BootstrapPayload } from '../types'

export interface BootstrapOptions {
  /**
   * The session asked for could not be bootstrapped (archived or deleted
   * elsewhere) and a plain bootstrap worked instead: move off it (FIX-03).
   */
  onSessionUnavailable?: (sessionId: string) => void
}

/**
 * The app's bootstrap payload and the actions that reload it (FIX-03):
 * only a failed first start replaces the app with the full-screen error;
 * a refresh that fails later keeps the shell and toasts. A bootstrap for a
 * session that fails is retried once without it, and the session reported
 * unavailable; 「重新连接」 (`retry`) always starts without a session.
 */
export function useBootstrap(
  showToast: (message: string) => void,
  options: BootstrapOptions = {},
) {
  const boot = ref<BootstrapPayload | null>(null)
  const loading = ref(true)
  const error = ref('')
  async function fetchBootstrap(sessionId: string): Promise<void> {
    const payload = await core('bootstrap', {
      sessionId: sessionId || null,
    })
    boot.value = {
      ...payload,
      control: payload.control as unknown as BootstrapPayload['control'],
    }
  }

  /** Load the payload; false when it failed (shown as described above). */
  async function loadBootstrap(
    showLoading = true,
    sessionId = '',
  ): Promise<boolean> {
    const started = boot.value !== null
    try {
      if (showLoading) loading.value = true
      if (!started) error.value = ''
      try {
        await fetchBootstrap(sessionId)
      } catch (first) {
        if (!sessionId) throw first
        await fetchBootstrap('')
        options.onSessionUnavailable?.(sessionId)
      }
      error.value = ''
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (started) showToast(`刷新失败：${message}`)
      else error.value = message
      return false
    } finally {
      loading.value = false
    }
  }

  /** 「重新连接」: a plain bootstrap, never the session that failed. */
  function retry(): Promise<boolean> {
    return loadBootstrap(false, '')
  }

  async function refreshMemory(shouldToast = true) {
    if (!boot.value) return
    boot.value.memory = await core('memory.get')
    if (shouldToast) showToast('记忆与 Token 统计已刷新')
  }

  return { boot, loading, error, loadBootstrap, retry, refreshMemory }
}
