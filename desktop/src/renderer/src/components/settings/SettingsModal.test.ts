// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { answerConfirmsForTest } from '../ui/confirm'
import SettingsModal from './SettingsModal.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null

function makeContext() {
  return {
    boot: ref({
      model: 'demo-model',
      projects: [],
      tools: [],
      skills: [],
      memory: {
        long_term: '长期记忆原文',
        episodes: [],
        versions: { versions: [] },
      },
    }),
    configContent: ref(''),
    loadConfig: vi.fn(async () => {}),
    saveMemory: vi.fn(async () => {}),
    refreshMemory: vi.fn(async () => {}),
    runtimeText: () => '运行中',
    showToast: vi.fn(),
    refreshAll: vi.fn(async () => {}),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
    // The tokens section renders once its chunk resolves mid-test.
    tokens: ref(null),
    tokensLoading: ref(false),
    loadTokens: vi.fn(async () => {}),
  }
}

async function mount(path: string): Promise<{ router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/editor',
        name: 'editor',
        component: defineComponent({ render: () => h('div') }),
      },
      {
        path: '/chat/:sessionId?',
        name: 'chat',
        component: defineComponent({ render: () => h('div') }),
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(SettingsModal))
  app.use(router)
  app.provide(APP_CONTEXT_KEY, makeContext() as never)
  app.mount(container)
  await flushPromises()
  return { router }
}

function modal(): HTMLElement | null {
  return document.body.querySelector('[data-testid="settings-modal"]')
}

beforeEach(() => {
  core.mockResolvedValue([])
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  core.mockReset()
  answerConfirmsForTest(null)
})

describe('Cutroom settings', () => {
  it('stays closed until there is a settings query', async () => {
    await mount('/editor')
    expect(modal()).toBeNull()
  })
  it('shows all editing sections and navigates in the same project', async () => {
    const { router } = await mount('/editor?settings=model&projectSession=s')
    const buttons = [
      ...modal()!.querySelectorAll<HTMLButtonElement>('button[data-section]'),
    ]
    expect(buttons.map((b) => b.dataset.section)).toEqual([
      'model',
      'skills',
      'voice',
      'media',
      'tokens',
    ])
    buttons.at(-1)!.click()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({
      settings: 'tokens',
      projectSession: 's',
    })
    expect(modal()?.querySelector('.nav-cell.active')?.textContent).toContain(
      'Token 用量',
    )
  })
  it('closes on Escape, the close button and a mask click', async () => {
    const { router } = await mount('/editor?settings=tokens&foo=1')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ foo: '1' })
    expect(modal()).toBeNull()

    await router.push('/editor?settings=tokens')
    await nextTick()
    modal()?.querySelector<HTMLButtonElement>('.settings-close')?.click()
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBeUndefined()

    await router.push('/editor?settings=model')
    await nextTick()
    document.body
      .querySelector<HTMLElement>('.settings-mask')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(router.currentRoute.value.query.settings).toBeUndefined()
  })
})
