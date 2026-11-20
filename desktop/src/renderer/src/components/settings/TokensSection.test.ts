// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import type { TokensPayload } from '../../types'
import TokensSection from './TokensSection.vue'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'

const row = (input: number, output: number, cacheRead = 0, calls = 1) => ({
  input,
  output,
  cache_read: cacheRead,
  cache_create: 0,
  calls,
})

function payload(): TokensPayload {
  const model = {
    ...row(700, 340, 900, 4),
    provider: 'deepseek',
    model: 'deepseek-chat',
  }
  return {
    totals: row(700, 340, 900, 4),
    byDate: { '2026-10-18': row(700, 340, 900, 4) },
    byModel: { 'deepseek/deepseek-chat': model },
    byUsageType: { main_agent: row(700, 340, 900, 4) },
    byDateModel: { '2026-10-18': { 'deepseek/deepseek-chat': model } },
    byHour: { '14': row(700, 340) },
    streak: {} as TokensPayload['streak'],
    sessions: 2,
  } as unknown as TokensPayload
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null

function mount(): { header: SettingsHeaderHost } {
  const header = createSettingsHeader()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(TokensSection))
  app.provide(APP_CONTEXT_KEY, {
    tokens: ref(payload()),
    tokensLoading: ref(false),
    loadTokens: vi.fn(async () => {}),
    runSafely: async (task: () => Promise<void>) => await task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(container)
  return { header }
}

function views(): string[] {
  return [...(container?.querySelectorAll('[data-view]') ?? [])].map(
    (view) => view.getAttribute('data-view') ?? '',
  )
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('TokensSection (UI-S07)', () => {
  it('opens directly on activity with metrics and a single level of navigation', async () => {
    const { header } = mount()
    await flushPromises()
    expect(
      container?.querySelector('[data-testid="token-metrics"]'),
    ).not.toBeNull()
    expect(container?.querySelector('[data-testid="usage-details"]')).toBeNull()
    expect(views()).toEqual(['activity'])
    expect(header.trail.value).toBeNull()
  })

  it('switches the detail views in place and retains the selected time range', async () => {
    const { header } = mount()
    await flushPromises()
    const buttons = (label: string) => [
      ...container!.querySelectorAll<HTMLButtonElement>(
        '[aria-label="' + label + '"] [role="radio"]',
      ),
    ]
    const ranges = buttons('统计范围')
    ranges.at(-1)!.click()
    const options = buttons('用量视图')
    expect(options.map((button) => button.textContent?.trim())).toEqual([
      '活跃度',
      '模型',
      '缓存',
    ])
    for (const [i, view] of ['activity', 'models', 'cache'].entries()) {
      options[i]!.click()
      await flushPromises()
      expect(views()).toEqual([view])
      expect(ranges.at(-1)!.getAttribute('aria-checked')).toBe('true')
      expect(header.page.value).toBeNull()
    }
  })
})
