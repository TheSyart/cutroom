// KRN-03: one root session owns its task tree — every subagent it (and its
// subagents) started, their sessions, background jobs and spill — and one
// budget bounds the tree: steps per turn, a cost cap counted over the root,
// every child and failed attempts, a shared pool of running subagents, a
// total per task, and how often subagent results may wake their parent.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from '../../api/core-api'
import { makeApi, tmp, waitFor } from '../../api/test-helpers'
import type { LlmAdapter } from '../../llm/adapter'
import { LlmClient } from '../../llm/client'
import { messageText, userText } from '../../llm/message'
import type { RouteSpec } from '../../llm/route'
import type { GenerateOptions, StreamChunk, TokenUsage } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { assertRequestInvariant } from '../agent/invariant'
import {
  createTestHarness,
  replyChunks,
  testRoute,
  withTaskBudget,
} from '../testing'

import type { HarnessHost } from './host'
import { recordedDescendants } from './task-tree'

type Reply = Parameters<typeof replyChunks>[0]
const FREE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

/** A model that answers every request through `respond` (by session, by task). */
class RoutedAdapter implements LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly respond: (
      request: GenerateOptions,
    ) => Reply | StreamChunk[] | Promise<Reply | StreamChunk[]>,
  ) {}

  async *stream(
    _route: RouteSpec,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    // Titles and summaries are not the conversation's requests.
    if (options.purpose !== undefined) {
      yield* replyChunks({ text: 'Summary of the earlier steps.' })
      return
    }
    this.requests.push(options)
    const signal = options.signal
    const reply = await new Promise<Reply | StreamChunk[]>(
      (resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        const onAbort = (): void => reject(signal!.reason)
        signal?.addEventListener('abort', onAbort, { once: true })
        Promise.resolve(this.respond(options))
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', onAbort))
      },
    )
    for (const chunk of Array.isArray(reply) ? reply : replyChunks(reply))
      yield chunk
  }
}

function pricedConfig(capUsd: number): Record<string, unknown> {
  return {
    schemaVersion: 2,
    activeModelId: 'test-route',
    models: [
      {
        entryId: 'test-route',
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'test-model',
        displayName: 'Test',
        apiBase: 'https://api.deepseek.com',
        apiKey: null,
        contextWindowTokens: 100000,
        maxTokens: 4096,
        pricing: {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 0,
          cacheReadUsdPerMillionTokens: 0,
          cacheWriteUsdPerMillionTokens: 0,
        },
      },
    ],
    policy: { cost: { maxUsdPerAgentTurn: capUsd } },
  }
}

interface Tree {
  api: CoreApi
  host: HarnessHost
  adapter: RoutedAdapter
  stateRoot: string
  rootId: string
  submit(content: string): ReturnType<HarnessHost['submit']>
  events(sessionId?: string): SessionEvent[]
  /** Children the root's log recorded, in start order. */
  children(): Array<{ id: string; description: string }>
  childRequests(): GenerateOptions[]
  /** Every agent of the tree idle. */
  quiet(): Promise<void>
}

async function makeTree(
  respond: (
    request: GenerateOptions,
    tree: { rootId: string },
  ) => Reply | StreamChunk[] | Promise<Reply | StreamChunk[]>,
  options: {
    modelConfig?: Record<string, unknown>
    retries?: boolean
  } = {},
): Promise<Tree> {
  const root = tmp('emperor-task-tree-')
  const stateRoot = join(root, 'home')
  if (options.modelConfig !== undefined) {
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(
      join(stateRoot, 'model_config.json'),
      JSON.stringify(options.modelConfig),
    )
  }
  const ids = { rootId: '' }
  const adapter = new RoutedAdapter((request) => respond(request, ids))
  const ref: { api?: CoreApi } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.api?.host.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute({ id: 'test-route' })], 'test-route')
  const { api } = await makeApi({ root, stateRoot, extra: { llm } })
  ref.api = api
  apis.push(api)
  const host = api.host
  // A second session: the root can be deleted (never the last one).
  api.sessions.create({ title: 'other' })
  ids.rootId = String(api.sessions.create({ title: 'root' }).id)
  const events = (sessionId = ids.rootId): SessionEvent[] => [
    ...(host.sessionLog(sessionId)?.events ?? []),
  ]
  const children = () =>
    events().flatMap((event) =>
      event.type === 'subagent/started'
        ? [{ id: event.data.subagentId, description: event.data.description }]
        : [],
    )
  return {
    api,
    host,
    adapter,
    stateRoot,
    rootId: ids.rootId,
    submit: (content) => host.submit({ sessionId: ids.rootId, content }),
    events,
    children,
    childRequests: () =>
      adapter.requests.filter((request) => request.sessionId !== ids.rootId),
    quiet: async () => {
      for (let round = 0; round < 4; round++) {
        await waitFor(
          () =>
            !host.isBusy(ids.rootId) &&
            host.taskTreeForTest(ids.rootId)?.childrenActive() !== true,
          10_000,
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/** A queue of replies for the root; once empty, `fallback`. */
function script(replies: Reply[], fallback: Reply = { text: 'ack' }) {
  const queue = [...replies]
  return (): Reply => queue.shift() ?? fallback
}

function lastTurnEnd(events: readonly SessionEvent[]) {
  return [...events]
    .reverse()
    .find(
      (event): event is SessionEvent<'turn/end'> => event.type === 'turn/end',
    )?.data.reason
}

describe('KRN-03 task tree: cost and steps', () => {
  it('#7 a failed attempt counts toward the cost cap', async () => {
    const SIXTY_CENTS: TokenUsage = { inputTokens: 600_000, outputTokens: 0 }
    const root = script([
      [
        { type: 'usage', usage: SIXTY_CENTS },
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'upstream hiccup', code: 'SERVER' },
          },
        },
      ],
      {
        tools: [{ id: 'todo', name: 'todo_write', args: { todos: [] } }],
        usage: SIXTY_CENTS,
      },
      { text: 'never reached', usage: FREE },
    ])
    const t = await makeTree(
      (request, { rootId }) =>
        request.sessionId === rootId ? root() : { text: 'x' },
      { modelConfig: pricedConfig(1) },
    )
    const submitted = await t.submit('go')
    expect(t.adapter.requests).toHaveLength(2)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 1_000_000_000,
      spentUsdNanos: 1_200_000_000,
    })
    expect(submitted.result).toMatchObject({
      kind: 'blocked',
      reason: 'cost-cap',
    })
  })

  it('#8 an interactive turn stops at step 401 and tells the model and the user', async () => {
    let calls = 0
    const t = await makeTree((request, { rootId }) => {
      if (request.sessionId !== rootId) return { text: 'x' }
      calls += 1
      return calls <= 400
        ? {
            tools: [
              { id: `todo-${calls}`, name: 'todo_write', args: { todos: [] } },
            ],
          }
        : { text: 'after the stop' }
    })
    const ui: Array<Record<string, unknown>> = []
    const untap = t.host.tap((event) => {
      ui.push(event)
    })
    const submitted = await t.submit('loop forever')
    untap()
    expect(t.adapter.requests).toHaveLength(400)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'steps',
      maxSteps: 400,
    })
    expect(submitted.result).toMatchObject({
      kind: 'blocked',
      reason: 'step-limit',
    })
    // The user: the turn's end says why.
    expect(ui).toContainEqual(
      expect.objectContaining({
        event: 'assistant_done',
        stop_reason: 'budget',
      }),
    )
    // The model: a notice in the log, read with the next request.
    const notice = t
      .events()
      .find(
        (event): event is SessionEvent<'user/message'> =>
          event.type === 'user/message' &&
          event.data.source.kind === 'context' &&
          event.data.source.producer === 'task-budget',
      )!
    expect(messageText(notice.data)).toContain('400 steps')
    await t.submit('carry on')
    expect(
      t.adapter.requests.at(-1)!.messages.map(messageText).join('\n'),
    ).toContain('400 steps')
  }, 120_000)

  it('#8b a scheduled turn stops at step 121', async () => {
    let calls = 0
    const t = await makeTree((request, { rootId }) => {
      if (request.sessionId !== rootId) return { text: 'x' }
      calls += 1
      return calls <= 200
        ? {
            tools: [
              { id: `todo-${calls}`, name: 'todo_write', args: { todos: [] } },
            ],
          }
        : { text: 'done looping' }
    })
    const outcome = await t.host.runBackgroundTurn(
      t.host.scopeFor(t.rootId),
      'scheduled loop',
      { source: 'scheduler', interactionPolicy: 'auto-reject' },
    )
    expect(t.adapter.requests).toHaveLength(120)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'steps',
      maxSteps: 120,
    })
    expect(outcome.result).toMatchObject({
      kind: 'blocked',
      reason: 'step-limit',
    })
  }, 60_000)
})

describe('KRN-03 budget on one agent', () => {
  const PRICED = {
    inputUsdPerMillionTokens: 1_000,
    outputUsdPerMillionTokens: 1_000,
    cacheReadUsdPerMillionTokens: 0,
    cacheWriteUsdPerMillionTokens: 0,
  }

  it('ends the turn after the request that reached the cap; the next task starts afresh', async () => {
    // 10 input + 5 output tokens at $1000/M = $0.015 per request.
    const h = createTestHarness({
      replies: [
        { tools: [{ name: 'missing_tool' }] },
        { tools: [{ name: 'missing_tool' }] },
        { text: 'never reached' },
      ],
    })
    const agent = h.agent()
    const tree = withTaskBudget(h, agent.id, { maxCostUsd: 0.02 }, PRICED)
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 20_000_000,
      spentUsdNanos: 30_000_000,
    })
    const notice = agent.session.lastOf('user/message')!.data
    expect(notice.source).toMatchObject({
      kind: 'context',
      producer: 'task-budget',
      summary: '任务费用已达上限（$0.03 / $0.02），已停止',
    })
    // While spent, the agent is not woken; the user's next message (a new
    // task on the host) starts from zero.
    tree.beginTask()
    h.adapter.push({ text: 'fresh' })
    agent.followup(userText('again'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
  })

  // MOD-05 8: a route without prices cannot be capped; the task goes on
  // (设置 › 模型 says the cap does not apply to that model).
  it('keeps a capped task going on a route without prices', async () => {
    const h = createTestHarness({
      replies: [{ tools: [{ name: 'missing_tool' }] }, { text: 'done' }],
    })
    const agent = h.agent()
    const tree = withTaskBudget(h, agent.id, { maxCostUsd: 5 })
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(tree.verdict().kind).toBe('ok')
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
  })

  it('keeps an idle root asleep once the task is spent, until a new task begins', async () => {
    const h = createTestHarness({
      replies: [{ text: 'spent it' }, { text: 'woken after the reset' }],
    })
    const tree = withTaskBudget(h, 'root', { maxCostUsd: 0.01 }, PRICED)
    const agent = h.agent('root', { admission: tree.gate })
    tree.setRoot(agent)
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(tree.verdict().kind).toBe('exceeded')
    // A notice (e.g. a job finishing) does not wake the spent root.
    agent.followup(userText('a late notice'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.status).toBe('idle')
    expect(h.adapter.requests).toHaveLength(1)
    tree.beginTask()
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
  })
})

describe('recordedDescendants', () => {
  const started = (subagentId: string) =>
    ({
      type: 'subagent/started',
      seq: 0,
      time: 0,
      data: { subagentId, description: 'x', mode: 'spawn', background: true },
    }) as unknown as SessionEvent

  it('walks every recorded generation and deletes nothing but subagent sessions', () => {
    const logs: Record<string, SessionEvent[]> = {
      'sub-a': [started('sub-c')],
      'sub-c': [started('sub-a')],
    }
    expect(
      recordedDescendants(
        [started('sub-a'), started('sub-b'), started('../escape'), started('')],
        (id) => logs[id] ?? [],
      ),
    ).toEqual(['sub-a', 'sub-c', 'sub-b'])
  })
})
