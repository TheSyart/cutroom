// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { loadKernelLog } from '../../conversation/testing/fixtures'
import { ConversationStore } from '../../conversation/store'
import type { SessionHistoryPage } from '@emperor/core/runtime-contract'
import ChatTimeline from './ChatTimeline.vue'
import {
  reloadUiPreferences,
  setUiPreference,
} from '../../composables/useUiPreferences'
import { createFixtureStore, type FixtureStore } from './gallery/fixtureStore'
import { showcaseScenario, streamingScenario } from './gallery/scenarios'
import {
  closingAssistantKeys,
  splitMarkdownFences,
  turnStatusLabel,
} from './timelineModel'

// vue-virtual-scroller's visibility directive expects IntersectionObserver.
globalThis.IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
} as unknown as typeof IntersectionObserver

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null
let fixture: FixtureStore | null = null
let router: Router
let delayedStore: ConversationStore | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  fixture?.dispose()
  delayedStore?.dispose()
  delayedStore = null
  container = null
  app = null
  fixture = null
  localStorage.clear()
  reloadUiPreferences()
})

/** Open the (single) process group of the mounted timeline. */
async function openProcess(root: HTMLElement): Promise<void> {
  const header = root.querySelector<HTMLElement>('[data-process-header]')
  if (header?.getAttribute('aria-expanded') === 'false') header.click()
  await settle()
}

async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

const immediate = {
  frame: (callback: () => void) => queueMicrotask(callback),
  microtask: (callback: () => void) => queueMicrotask(callback),
}

function mount(
  sessionId: string,
  sessions: Parameters<typeof createFixtureStore>[0],
  events: Record<string, (value: string) => void> = {},
  customStore?: ConversationStore,
  extra: Record<string, unknown> = {},
): HTMLDivElement {
  fixture = createFixtureStore(sessions, { scheduler: immediate })
  container = document.createElement('div')
  document.body.append(container)
  const store = customStore ?? fixture.store
  app = createApp({
    render: () =>
      h(ChatTimeline, {
        sessionId,
        store,
        onInspect: events.inspect,
        'onOpen-subagent': events.openSubagent,
        ...extra,
      }),
  })
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/chat/:sessionId',
        name: 'chat',
        component: { render: () => null },
      },
      {
        path: '/chat/:sessionId/agents/:delegationId',
        name: 'external-agent',
        component: { render: () => null },
      },
    ],
  })
  app.use(router)
  app.mount(container)
  return container
}

describe('ChatTimeline over the recorded kernel log', () => {
  it.each(['resolve', 'reject'] as const)(
    'shows an initial loading transition until delayed history %ss',
    async (outcome) => {
      let resolve!: (page: SessionHistoryPage) => void
      let reject!: (error: Error) => void
      delayedStore = new ConversationStore({
        api: {
          history: () =>
            new Promise<SessionHistoryPage>((yes, no) => {
              resolve = yes
              reject = no
            }),
        },
        watch: async () => undefined,
        subscribe: () => () => {},
        scheduler: immediate,
      })
      const root = mount('delayed', [], {}, delayedStore)
      await settle()
      expect(root.querySelector('[aria-busy="true"]')).not.toBeNull()
      if (outcome === 'resolve')
        resolve({
          header: { version: 0, id: 'delayed', createdAt: 0 },
          events: [],
          hasMore: false,
          lastSeq: -1,
        } as SessionHistoryPage)
      else reject(new Error('history offline'))
      await settle()
      expect(root.querySelector('[aria-busy="true"]')).toBeNull()
      // FIX-03: the message, then 重试.
      expect(
        root.querySelector('[role="alert"] span')?.textContent?.trim() ?? '',
      ).toBe(outcome === 'reject' ? '会话记录读取失败：history offline' : '')
    },
  )

  it('renders every chat row kind of the fixture', async () => {
    const log = loadKernelLog()
    const root = mount('kernel', [
      { id: 'kernel', events: [...log.root.events] },
      ...log.children.map((child) => ({
        id: child.header.id,
        events: [...child.events],
      })),
    ])
    await settle()
    const kinds = () =>
      [...root.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')].map(
        (el) => el.dataset.chatFlowKind,
      )
    // UI-S03: the finished turn's steps fold into one process row; context
    // injections are hidden until 显示系统步骤.
    // UI-S14: the subagent is a row of its own after the process.
    expect(kinds()).toEqual([
      'user',
      'process',
      'agents',
      'assistant',
      'turnTail',
      'compaction',
    ])
    await openProcess(root)
    expect(kinds()).toEqual([
      'user',
      'process',
      'retry',
      'assistant',
      'tool',
      'tool',
      'tool',
      'agents',
      'assistant',
      'turnTail',
      'compaction',
    ])
    expect(root.querySelector('.user-bubble')?.textContent).toBe(
      'pick a color (shown)',
    )
    const tools = [...root.querySelectorAll('.tool-row')].map((el) =>
      el.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(tools[0]).toContain('bash')
    expect(tools[2]).toContain('已回答 1/1 · Which color?')
    expect(
      root.querySelector('[data-tool="subagent"]')?.getAttribute('data-state'),
    ).toBe('archived')
    expect(
      root.querySelector('[data-agent-entry], [data-agent-details]'),
    ).toBeNull()
    expect(root.textContent).toContain('已压缩 10 条消息')
    expect(root.querySelector('.turn-status')).toBeNull()
  })

  it('lets the reader inspect archived terminal input and output', async () => {
    setUiPreference('showTrajectory', true)
    const log = loadKernelLog()
    const inspected: string[] = []
    const root = mount(
      'kernel',
      [{ id: 'kernel', events: [...log.root.events] }],
      { inspect: (id) => inspected.push(id) },
    )
    await settle()
    await openProcess(root)
    const row = root.querySelector<HTMLElement>('[data-call-id="call_bash_a"]')!
    row.querySelector<HTMLElement>('[data-disclosure-row]')?.click()
    await settle()
    expect(row.textContent).toContain('IN')
    expect(row.textContent).toContain('OUT')
    expect(row.textContent).toContain('echo alpha')
    expect(row.getAttribute('data-state')).toBe('archived')
    row.querySelector<HTMLButtonElement>('.inspect')?.click()
    expect(inspected).toEqual(['call_bash_a'])
  })
})

describe('ChatTimeline live flow', () => {
  it('shows the turn status while running and streams new rows', async () => {
    const scenario = streamingScenario(Date.now(), 'all')
    const session = scenario.sessions[0]!
    const root = mount(session.id, [{ id: session.id, events: session.events }])
    await settle()
    expect(root.querySelector('.turn-status')?.textContent).toContain('思考中')
    fixture!.emit(session.id, session.live ?? [])
    await settle()
    // UI-S03: the running process is one live line, the status line itself.
    const live = root.querySelector('[data-process-group][data-live]')
    expect(live?.textContent).toContain('正在查看素材 interview.mp4')
    expect(root.querySelector('.turn-status')).toBeNull()
    await openProcess(root)
    expect(root.querySelector('.reasoning')).not.toBeNull()
    expect(root.textContent).toContain('会话持久化分三层')
    expect(
      root
        .querySelector('.tool-row[data-call-id="live_read"]')
        ?.getAttribute('data-state'),
    ).toBe('running')
  })

  it('renders the showcase turn with its tail and final markdown', async () => {
    const scenario = showcaseScenario(Date.now())
    const root = mount('showcase', scenario.sessions)
    await settle()
    expect(root.querySelector('[data-turn-tail]')).not.toBeNull()
    expect(root.querySelector('.ds-md table')).not.toBeNull()
    expect(root.querySelector('.ds-md .ds-code')).not.toBeNull()
    await openProcess(root)
    const lint = root.querySelector('.tool-row[data-call-id="call_lint"]')
    expect(lint?.getAttribute('data-state')).toBe('error')
  })
})

describe('ChatTimeline reveal', () => {
  it('scrolls to a loaded row by key and rejects unknown keys', async () => {
    const scenario = showcaseScenario(Date.now())
    fixture = createFixtureStore(scenario.sessions, { scheduler: immediate })
    container = document.createElement('div')
    document.body.append(container)
    const store = fixture.store
    const timeline = ref<{ scrollToKey: (key: string) => boolean } | null>(null)
    app = createApp({
      render: () =>
        h(ChatTimeline, { sessionId: 'showcase', store, ref: timeline }),
    })
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        {
          path: '/chat/:sessionId',
          name: 'chat',
          component: { render: () => null },
        },
        {
          path: '/chat/:sessionId/agents/:delegationId',
          name: 'external-agent',
          component: { render: () => null },
        },
      ],
    })
    app.use(router)
    app.mount(container)
    await settle()
    const key = container
      .querySelector<HTMLElement>('[data-chat-anchor-key]')
      ?.getAttribute('data-chat-anchor-key')
    expect(key).toBeTruthy()
    expect(timeline.value?.scrollToKey(key!)).toBe(true)
    expect(timeline.value?.scrollToKey('missing-key')).toBe(false)
  })
})

describe('timeline model', () => {
  it('splits markdown fences, keeping an open trailing fence as code', () => {
    expect(
      splitMarkdownFences('a\n\n```ts\nconst x = 1\n```\nb\n```sh\necho'),
    ).toEqual([
      { kind: 'markdown', text: 'a\n' },
      { kind: 'code', lang: 'ts', code: 'const x = 1', open: false },
      { kind: 'markdown', text: 'b' },
      { kind: 'code', lang: 'sh', code: 'echo', open: true },
    ])
  })

  it('labels the running turn from the flow tip', () => {
    const snap = (node: unknown) =>
      ({ order: ['a'], nodes: new Map([['a', node]]) }) as never
    expect(
      turnStatusLabel(
        snap({
          kind: 'assistant',
          data: { status: 'running', blocks: [{ kind: 'text', text: 'x' }] },
        }),
      ),
    ).toBe('正在回复…')
    expect(
      turnStatusLabel(
        snap({
          kind: 'assistant',
          data: {
            status: 'running',
            blocks: [{ kind: 'reasoning', text: 'x' }],
          },
        }),
      ),
    ).toBe('思考中…')
    expect(
      turnStatusLabel(
        snap({ kind: 'retry', data: { current: { state: 'scheduled' } } }),
      ),
    ).toBe('等待重试…')
    expect(
      closingAssistantKeys(
        ['a', 'b'],
        new Map([
          ['a', { kind: 'assistant' }],
          ['b', { kind: 'turnTail' }],
        ]) as never,
      ),
    ).toEqual(new Set(['a']))
    // UI-S13: the files card sits between the answer and its footer.
    expect(
      closingAssistantKeys(
        ['a', 'f', 'b'],
        new Map([
          ['a', { kind: 'assistant' }],
          ['f', { kind: 'turnFiles' }],
          ['b', { kind: 'turnTail' }],
        ]) as never,
      ),
    ).toEqual(new Set(['a']))
  })
})
