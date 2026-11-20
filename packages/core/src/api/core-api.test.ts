import { historicalChild } from './test-helpers'
// CoreApi on the harness kernel (`HarnessHost`) with a scripted model: the
// operation registry, bootstrap, chat streaming and draft promotion, replay,
// control interactions, mutation guards, tasks, goals, slash commands, and
// the kept non-kernel services (sessions, scheduler, sidebar, diagnostics,
// skills, desktop pet, stateRoot layout, model config, hooks, onboarding).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../llm/types'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import type { CoreApi } from './core-api'

import { CoreMutationGuardError } from './mutation-guard'
import { coreOperationKeys } from './operations'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  tmp,
  waitFor,
  type ApiFixture,
} from './test-helpers'

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup(
  options: Parameters<typeof makeApi>[0] = {},
): Promise<ApiFixture> {
  const fixture = await makeApi(options)
  apis.push(fixture.api)
  return fixture
}

function session(api: CoreApi, title = 'Chat'): string {
  return String(api.sessions.create({ title }).id)
}

function validModelEntry(name: string) {
  return {
    provider: 'openai',
    protocol: 'openai' as const,
    modelId: 'gpt-5.2',
    displayName: name,
    apiKey: 'sk-test-entry',
    apiBase: 'https://api.openai.com/v1',
    maxTokens: 8192,
    reasoningEffort: 'high',
    contextWindowTokens: 128000,
  }
}

const askColor: ScriptedReply = {
  tools: [
    {
      id: 'q1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            id: 'color',
            question: 'Which color?',
            options: [{ label: 'red' }, { label: 'blue' }],
          },
        ],
      },
    },
  ],
}

describe('CoreApi operation surface', () => {
  it('bootstraps with the active control, tool and runtime catalogs', async () => {
    const { api } = await setup()
    const id = session(api)
    const payload = await api.bootstrap({ sessionId: id })
    expect(payload.control).toMatchObject({
      version: 3,
      preset: 'workspace-write',
      plan: false,
      pending: null,
    })
    expect(Array.isArray(payload.control.presets)).toBe(true)
    expect(
      (payload.control.presets as Array<{ value: string }>).map(
        (item) => item.value,
      ),
    ).toEqual(
      expect.arrayContaining([
        'read-only',
        'workspace-write',
        'danger-full-access',
      ]),
    )
    expect(Array.isArray(payload.runtime.events)).toBe(true)
    expect(payload.runtime).toMatchObject({
      busy: false,
      latestSeq: expect.any(Number),
    })
    expect(payload).not.toHaveProperty('goals')
    expect(payload).not.toHaveProperty('plugins')
    expect(api.host.tools.names()).not.toEqual(
      expect.arrayContaining(['create_goal']),
    )
    expect(
      coreOperationKeys().filter((op) => /^(goals|plugins)\./.test(op)),
    ).toEqual([])
    expect(payload.provider).toBe('test')
    expect(payload.sessionId).toBe(id)
  })

  it('rejects draft session ids at bootstrap before activating or replaying', async () => {
    const { api } = await setup()
    const id = session(api)
    api.sessions.activate(id)
    await expect(
      api.bootstrap({ sessionId: 'draft:new-chat' }),
    ).rejects.toThrow(/draft/i)
    expect((await api.bootstrap()).sessionId).toBe(id)
  })
})

describe('CoreApi raw session log', () => {
  it('serves history, lineage, children, and the watch set for child sessions', async () => {
    const { api } = await setup({ replies: [{ text: 'remembered' }] })
    const id = session(api)
    await api.chat.submit({ sessionId: id, content: 'remember this turn' })
    historicalChild(api, id)
    const [child] = api.sessions.children({ sessionId: id })
    expect(child).toMatchObject({ description: 'research', status: 'settled' })
    const childId = child!.subagentId
    // Child sessions are not in the sidebar list but are readable by lineage.
    expect(
      api.sessions
        .list()
        .some((entry) => (entry as { id?: unknown }).id === childId),
    ).toBe(false)
    const page = api.sessions.history({ sessionId: childId })
    expect(page.header.id).toBe(childId)
    expect(page.events.length).toBeGreaterThan(0)
    expect(api.sessions.lineage({ sessionId: childId }).chain).toEqual([
      { sessionId: id },
      { sessionId: childId, description: 'research', parentCallId: 'd1' },
    ])
    // sessions.event returns one raw event by seq (unsanitized).
    const first = page.events[0]!
    expect(api.sessions.event({ sessionId: childId, seq: first.seq })).toEqual(
      first,
    )
    expect(() =>
      api.sessions.event({ sessionId: childId, seq: 1_000_000 }),
    ).toThrow(/no event/)
    const tail = api.sessions.history({ sessionId: id, maxMessages: 1 })
    expect(tail.hasMore).toBe(true)
    const older = api.sessions.history({
      sessionId: id,
      beforeSeq: tail.events[0]!.seq,
    })
    expect(older.events.at(-1)!.seq).toBeLessThan(tail.events[0]!.seq)

    expect(
      api.sessions.watch({ sessionIds: [id, childId, 'missing'] }),
    ).toEqual({ watching: [id, childId] })
    expect(api.isSessionWatched(childId)).toBe(true)
    expect(api.isSessionWatched('missing')).toBe(false)
    api.sessions.watch({ sessionIds: [] })
    expect(api.isSessionWatched(id)).toBe(false)

    expect(() => api.sessions.history({ sessionId: 'missing' })).toThrow(
      /unknown session/,
    )
    expect(() => api.sessions.lineage({ sessionId: 'draft:x' })).toThrow()
  })
})

describe('CoreApi chat', () => {
  it('streams a real-session turn to the event sink', async () => {
    const { api, events } = await setup({
      replies: [{ text: 'Hello from Emperor' }],
    })
    const id = session(api)
    const result = await api.chat.submit({
      content: 'hi',
      displayContent: 'hi!',
      clientMessageId: 'c1',
      sessionId: id,
    })
    expect(result).toMatchObject({
      content: 'Hello from Emperor',
      activeSessionId: id,
      delivery: 'completed',
    })
    const names = events.map((event) => event.event)
    expect(names).toEqual(
      expect.arrayContaining([
        'user_message',
        'message_delta',
        'assistant_done',
      ]),
    )
    expect(eventOf(events, 'user_message')).toMatchObject({
      content: 'hi!',
      client_message_id: 'c1',
      session_id: id,
    })
    expect(names).not.toContain('session_created')
  })

  it('promotes a draft session before the turn and generates its title once', async () => {
    const { api, adapter, events } = await setup({
      replies: [{ text: 'pong' }, { text: 'second' }],
    })
    const draftId = 'draft:local-abc'
    const result = await api.chat.submit({
      content: '搭一个终端动画项目',
      sessionId: draftId,
      clientDraftId: draftId,
      draftSession: {
        mode: 'build',
        project: {
          project_id: 'proj_1',
          project_path: '/tmp/proj',
          project_name: 'Proj',
        },
      },
    })
    const created = eventOf(events, 'session_created') as {
      client_draft_id: string
      session: Record<string, unknown>
    }
    expect(created.client_draft_id).toBe(draftId)
    expect(created.session).toMatchObject({
      title: '新会话',
      mode: 'build',
      project_id: 'proj_1',
      title_status: 'pending',
    })
    const newId = String(created.session.id)
    expect(result.activeSessionId).toBe(newId)
    const createdIndex = events.findIndex(
      (event) => event.event === 'session_created',
    )
    const userIndex = events.findIndex(
      (event) => event.event === 'user_message',
    )
    expect(userIndex).toBeGreaterThan(createdIndex)
    const titleEvents = events.filter(
      (event) => event.event === 'session_title_updated',
    )
    expect(titleEvents).toHaveLength(1)
    expect((titleEvents[0]!.session as { id: string }).id).toBe(newId)
    expect(api.host.kept.sessionStore.get(newId)).toMatchObject({
      title: 'Generated',
      title_status: 'generated',
    })
    expect(adapter.titleRequests).toHaveLength(1)

    events.length = 0
    await api.chat.submit({ content: '继续', sessionId: newId })
    expect(eventOf(events, 'session_created')).toBeUndefined()
    expect(eventOf(events, 'session_title_updated')).toBeUndefined()
    expect(adapter.titleRequests).toHaveLength(1)
  })

  it('defers title material for a short first message to the reply', async () => {
    const { api, adapter } = await setup({ replies: [{ text: 'pong reply' }] })
    const result = await api.chat.submit({
      content: 'hi',
      sessionId: 'draft:short',
      draftSession: { mode: 'chat' },
    })
    expect(adapter.titleRequests).toHaveLength(1)
    const titlePrompt = JSON.stringify(adapter.titleRequests[0]!.messages)
    expect(titlePrompt).toContain('pong reply')
    expect(
      api.host.kept.sessionStore.get(String(result.activeSessionId)),
    ).toMatchObject({ title_status: 'generated' })
  })

  it('turns requested skills into a /name gesture while keeping display content', async () => {
    const root = tmp('emperor-core-api-skill-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'reviewer'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'reviewer', 'SKILL.md'),
      '---\nname: reviewer\ndescription: Review code\n---\n\nREVIEWER-SKILL-BODY\n',
    )
    const { api, adapter, events } = await setup({
      root,
      stateRoot,
      replies: [{ text: 'reviewed' }],
    })
    const id = session(api)
    await api.chat.submit({
      content: 'check this',
      sessionId: id,
      requestedSkills: [
        { name: 'reviewer', source: 'slash' },
        { name: 'bad name!' },
      ],
    })
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('/reviewer\\ncheck this')
    expect(request).not.toContain('/bad name!')
    expect(request).toContain('REVIEWER-SKILL-BODY')
    expect(eventOf(events, 'user_message')).toMatchObject({
      content: 'check this',
    })
  })

  it('keeps a skill chip where the user put it and records the chip', async () => {
    const root = tmp('emperor-core-api-skill-chip-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'reviewer'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'reviewer', 'SKILL.md'),
      '---\nname: reviewer\ndescription: Review code\n---\n\nREVIEWER-SKILL-BODY\n',
    )
    const { api, adapter, events } = await setup({
      root,
      stateRoot,
      replies: [{ text: 'reviewed' }],
    })
    const id = session(api)
    const references = [
      {
        kind: 'skill' as const,
        id: 'reviewer',
        label: 'Reviewer',
        start: 2,
        end: 11,
      },
    ]
    await api.chat.submit({
      content: '请 /reviewer 看看',
      displayContent: '请 /reviewer 看看',
      sessionId: id,
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
      references,
    })
    const request = JSON.stringify(adapter.requests[0]!.messages)
    // The chip's gesture is in the text: no second one in front of it.
    expect(request).toContain('请 /reviewer 看看')
    expect(request).not.toContain('/reviewer\\n')
    expect(request).toContain('REVIEWER-SKILL-BODY')
    expect(eventOf(events, 'user_message')).toMatchObject({
      content: '请 /reviewer 看看',
      references,
    })
    const meta = api.host
      .agentFor(id)
      .session.events.find((event) => event.type === 'host/user-meta')
    expect(meta?.data).toMatchObject({ references })
  })

  it.each([
    ['a mismatched Skill offset', '看看 GitHub', 'skill'],
    ['an old plugin chip with matching offsets', '@github 看看', 'plugin'],
  ])(
    'drops %s on the in-process submission path',
    async (_case, displayContent, kind) => {
      const { api } = await setup({ replies: [{ text: 'ok' }] })
      const id = session(api)
      await api.chat.submit({
        content: '@github 看看',
        displayContent,
        sessionId: id,
        // @ts-expect-error Exercise the untyped in-process submission path.
        references: [{ kind, id: 'github', label: 'GitHub', start: 0, end: 7 }],
      })
      const meta = api.host
        .agentFor(id)
        .session.events.find((event) => event.type === 'host/user-meta')
      expect(meta?.data).toMatchObject({ referencesDropped: true })
      expect(meta?.data).not.toHaveProperty('references')
    },
  )

  it('replays only the requested session and matches the live projection', async () => {
    const { api, events } = await setup({
      replies: [{ text: 'one' }, { text: 'two' }],
    })
    const a = session(api, 'A')
    const b = session(api, 'B')
    await api.chat.submit({ content: 'first', sessionId: a })
    await api.chat.submit({ content: 'second', sessionId: b })
    const replay = api.runtime.replay({ sessionId: a })
    expect(replay.sessionId).toBe(a)
    expect(replay.events.length).toBeGreaterThan(0)
    expect(replay.events.every((event) => event.session_id === a)).toBe(true)
    const live = events.filter(
      (event) => Number(event.seq) > 0 && event.session_id === a,
    )
    expect(replay.events).toEqual(live)
    expect(replay.latestSeq).toBe(live.at(-1)!.seq)
    const tail = api.runtime.replay({
      sessionId: a,
      afterSeq: replay.latestSeq - 1,
    })
    expect(tail.events).toHaveLength(1)
    expect(() => api.runtime.replay({ sessionId: 'draft:x' })).toThrow(/draft/)
  })
})

describe('CoreApi control', () => {
  it('switches permission preset and plan mode', async () => {
    const { api } = await setup()
    const id = session(api)
    api.control.setPermissionMode('read-only', id)
    expect(api.control.get(id)).toMatchObject({
      preset: 'read-only',
      plan: false,
    })
    const planned = api.control.setMode('plan', id)
    expect(planned.control).toMatchObject({ plan: true })
    expect(api.control.get(id).plan).toBe(true)
    api.control.setMode('default', id)
    expect(api.control.get(id).plan).toBe(false)
    expect(() => api.control.setPermissionMode('nope', id)).toThrow(
      /unknown permission preset/,
    )
  })

  it('answers ask_user_question and resumes the blocked turn', async () => {
    const { api, events } = await setup({
      replies: [
        askColor,
        (request: GenerateOptions) => {
          expect(JSON.stringify(request.messages.at(-1)?.content)).toContain(
            'blue',
          )
          return replyChunks({ text: 'blue it is' })
        },
      ],
    })
    const id = session(api)
    const submitted = api.chat.submit({ content: 'pick', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    expect(api.control.get(id).pending).toMatchObject({ id: interactionId })
    const settled = await api.control.answerInteraction(interactionId, {
      color: { choice: 'blue', freeform: '' },
    })
    expect(settled).toMatchObject({ interactionId, sessionId: id })
    expect((await submitted).content).toBe('blue it is')
    expect(api.control.get(id).pending).toBeNull()
  })

  it('approves a plan through exit_plan_mode and leaves plan mode', async () => {
    const { api, events } = await setup({
      replies: [
        {
          tools: [
            {
              id: 'p1',
              name: 'exit_plan_mode',
              args: { plan: '# Do the thing\n- step' },
            },
          ],
        },
        { text: 'implementing' },
      ],
    })
    const id = session(api)
    api.control.setMode('plan', id)
    const submitted = api.chat.submit({ content: 'plan it', sessionId: id })
    await waitFor(() => eventOf(events, 'plan_draft') !== undefined)
    const planId = pendingInteractionId(events, 'plan_draft')
    await api.control.approvePlan(planId)
    expect((await submitted).content).toBe('implementing')
    expect(eventOf(events, 'plan_approved')).toBeDefined()
    expect(api.control.get(id).plan).toBe(false)
  })

  it('cancels a pending interaction and rejects unknown interaction ids', async () => {
    const { api, events } = await setup({
      replies: [askColor, { text: 'cancelled then' }],
    })
    const id = session(api)
    const submitted = api.chat.submit({ content: 'pick', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    await api.control.cancelInteraction(interactionId)
    await submitted
    expect(api.control.get(id).pending).toBeNull()
    await expect(
      api.control.answerInteraction('missing', {}),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    await expect(api.control.cancelInteraction(interactionId)).rejects.toThrow(
      /not pending/,
    )
  })
})

describe('CoreApi tasks and tools', () => {
  it('reads spilled tool results only from the spill store', async () => {
    const { api, stateRoot, root } = await setup()
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    const spilled = join(stateRoot, 'spill', 'result.txt')
    writeFileSync(spilled, 'full text content')
    writeFileSync(join(root, 'outside.txt'), 'secret')
    expect(api.tools.readResult({ ref: spilled })).toEqual({
      content: 'full text content',
      page: 1,
      pages: 1,
      bytes: 17,
    })
    expect(() =>
      api.tools.readResult({ ref: join(root, 'outside.txt') }),
    ).toThrow(CoreMutationGuardError)
    expect(() =>
      api.tools.readResult({
        ref: join(stateRoot, 'spill', '..', 'settings.json'),
      }),
    ).toThrow(CoreMutationGuardError)
    expect(() =>
      api.tools.readResult({ ref: join(stateRoot, 'spill') }),
    ).toThrow(CoreMutationGuardError)
    expect(() => api.tools.readResult({ ref: '/etc/passwd' })).toThrow(
      CoreMutationGuardError,
    )
  })
})

describe('CoreApi sessions.create (FIX-13)', () => {
  it('2 · a session a typed command creates for a draft starts in its plan mode and preset', async () => {
    const { api, adapter } = await setup()
    const created = api.sessions.create({
      title: '新会话',
      mode: 'chat',
      plan: true,
      preset: 'danger-full-access',
    })
    expect(api.control.get(String(created.id))).toMatchObject({
      plan: true,
      preset: 'danger-full-access',
    })
    // A creation-time fact: nothing is announced to the model.
    const types = api.host
      .sessionLog(String(created.id))!
      .events.map((event) => event.type)
    expect(types).not.toContain('context/message')
    expect(adapter.requests).toHaveLength(0)
    // Without them it is the defaults, as before.
    const plain = api.sessions.create({ title: 'plain' })
    expect(api.control.get(String(plain.id))).toMatchObject({
      plan: false,
      preset: api.host.defaultPreset,
    })
  })
})

describe('CoreApi commands', () => {
  it('lists builtins and creates a real new-chat boundary with /new', async () => {
    const { api } = await setup()
    const previous = session(api)
    api.sessions.activate(previous)
    const commands = await api.commands.list({
      sessionId: previous,
      invocationSource: 'desktop',
    })
    expect(commands.find((item) => item.id === 'builtin.new')).toMatchObject({
      name: 'new',
      kind: 'core_action',
    })
    const result = await api.commands.invoke({
      sessionId: previous,
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'new-1',
      invocationSource: 'desktop',
    })
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'session_transitioned' },
    })
    const next = String((await api.bootstrap()).sessionId)
    expect(next).not.toBe(previous)
    expect(api.host.kept.sessionStore.get(next)).toMatchObject({
      parent_session_id: previous,
      message_count: 0,
    })
    expect(api.host.kept.sessionStore.get(previous)).toMatchObject({
      transitioned_to_session_id: next,
    })
  })

  it('carries the permission preset into the /new session with plan mode off', async () => {
    const { api } = await setup()
    const previous = session(api)
    api.sessions.activate(previous)
    api.host.setPermissionPreset(previous, 'read-only')
    api.host.setPlanMode(previous, true)
    const result = await api.commands.invoke({
      sessionId: previous,
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'new-preset',
      invocationSource: 'desktop',
    })
    expect(result).toMatchObject({ status: 'completed' })
    const next = String((await api.bootstrap()).sessionId)
    expect(next).not.toBe(previous)
    expect(api.host.controlPayload(next)).toMatchObject({
      preset: 'read-only',
      plan: false,
    })
  })

  it('applies /permissions and /plan to the declared session only', async () => {
    const { api } = await setup()
    const active = session(api, 'Active')
    api.sessions.activate(active)
    const background = session(api, 'Background')
    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.permissions',
        rawInput: '/permissions read-only',
        invocationId: 'perm-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: {
        code: 'permission_preset_updated',
        data: { preset: 'read-only' },
      },
    })
    expect(api.control.get(background).preset).toBe('read-only')
    expect(api.control.get(active).preset).toBe('workspace-write')

    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.plan',
        rawInput: '/plan',
        invocationId: 'plan-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'plan_enabled' },
    })
    expect(api.control.get(background).plan).toBe(true)
    expect(api.control.get(active).plan).toBe(false)

    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.plan',
        rawInput: '/plan off',
        invocationId: 'plan-2',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'plan_disabled' },
    })
    expect(api.control.get(background).plan).toBe(false)
  })
})

// FIX-14: the start page is a draft (`draft:<uuid>`) Core has no session for.
// Its slash commands and Skills come from the draft's own mode and project,
// never from whichever real session happens to exist.
describe('CoreApi commands on a start-page draft (FIX-14)', () => {
  function skillAt(dir: string, name: string): void {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(
      join(dir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n`,
    )
  }

  async function draftFixture() {
    const root = tmp('emperor-core-api-draft-commands-')
    const stateRoot = join(root, 'home')
    const projectA = join(root, 'project-a')
    const projectB = join(root, 'project-b')
    skillAt(join(stateRoot, 'skills'), 'reviewer')
    skillAt(join(projectA, '.cutroom', 'skills'), 'deploy')
    skillAt(join(projectB, '.cutroom', 'skills'), 'release')
    const fixture = await setup({ root, stateRoot })
    return { ...fixture, projectA, projectB }
  }

  const ids = (commands: Array<{ id: string }>) =>
    commands.map((command) => command.id)

  it('1 · lists the builtins and personal Skills with no session at all', async () => {
    const { api } = await draftFixture()
    expect(api.host.kept.sessionStore.list()).toEqual([])
    const commands = await api.commands.list({
      sessionId: 'draft:fresh',
      draftSession: { mode: 'chat', project: null },
      invocationSource: 'desktop',
    })
    expect(ids(commands)).toEqual(
      expect.arrayContaining([
        'builtin.new',
        'builtin.plan',
        'builtin.permissions',
        'skill.user.reviewer',
      ]),
    )
    expect(commands.every((command) => command.available)).toBe(true)
    // Listing never creates the session.
    expect(api.host.kept.sessionStore.list()).toEqual([])
  })

  it('2 · lists the Skills of a Build draft’s project, not another project’s', async () => {
    const { api, projectA, projectB } = await draftFixture()
    // A real Build session on project A exists; the drafts must not see it.
    api.sessions.create({ title: 'A', mode: 'build', project_path: projectA })
    const draftOn = (mode: string, path: string) =>
      api.commands.list({
        sessionId: 'draft:next',
        draftSession: {
          mode,
          project: {
            project_id: path,
            project_path: path,
            project_name: 'P',
          },
        },
        invocationSource: 'desktop',
      })
    const onA = ids(await draftOn('build', projectA))
    expect(onA).toEqual(
      expect.arrayContaining(['skill.project.deploy', 'skill.user.reviewer']),
    )
    expect(onA).not.toContain('skill.project.release')
    const onB = ids(await draftOn('build', projectB))
    expect(onB).toEqual(
      expect.arrayContaining(['skill.project.release', 'skill.user.reviewer']),
    )
    expect(onB).not.toContain('skill.project.deploy')
    // A Chat draft has no project Skills, whatever path it carries.
    const chat = ids(await draftOn('chat', projectA))
    expect(chat).toContain('skill.user.reviewer')
    expect(chat).not.toContain('skill.project.deploy')
  })

  it('3 · completes command arguments on a draft', async () => {
    const { api } = await draftFixture()
    const completions = await api.commands.complete({
      sessionId: 'draft:fresh',
      draftSession: { mode: 'chat', project: null },
      commandId: 'builtin.permissions',
      rawArgs: 'read',
      cursor: 4,
      invocationSource: 'desktop',
    })
    expect(completions.map((item) => item.value)).toContain('read-only')
  })
})

describe('CoreApi sessions and kept services', () => {
  it('moves a deleted session to the trash, and undo brings it back byte for byte (FIX-01 1)', async () => {
    const { api } = await setup({ replies: [{ text: 'hello' }] })
    const keep = session(api, 'Keep')
    const doomed = session(api, 'Doomed')
    await api.chat.submit({ content: 'hi', sessionId: doomed })
    await api.host.agentFor(doomed).whenIdle()
    await api.host.sessions.flush(doomed, { sync: true })
    const logPath = join(
      api.host.kept.sessionStore.sessionDir(doomed),
      'log.jsonl',
    )
    const bytes = readFileSync(logPath)
    const result = await api.sessions.delete(doomed)
    expect(result).toMatchObject({ deleted: true, restorable: true })
    // Snapshots stay until the trash is emptied, so undo keeps revert.
    expect(api.host.sessions.has(doomed)).toBe(false)
    expect(api.host.kept.sessionStore.get(doomed)).toBeNull()
    expect(api.host.kept.sessionStore.get(keep)).not.toBeNull()
    expect(api.sessions.listDeleted()).toEqual([
      expect.objectContaining({ id: doomed, title: 'Doomed' }),
    ])
    const restored = await api.sessions.restoreDeleted(doomed)
    expect(restored.id).toBe(doomed)
    expect(readFileSync(logPath).equals(bytes)).toBe(true)
    expect(api.sessions.listDeleted()).toEqual([])
    expect(api.host.agentFor(doomed).session.events.length).toBeGreaterThan(0)
  })

  it('keeps a deleted session in 最近删除 until it is purged (FIX-01 2)', async () => {
    const { api } = await setup()
    session(api, 'Keep')
    const doomed = session(api, 'Doomed')
    await api.sessions.delete(doomed)
    expect(api.sessions.listDeleted().map((item) => item.id)).toEqual([doomed])
    await api.sessions.purgeDeleted(doomed)
    expect(api.sessions.listDeleted()).toEqual([])
    await expect(api.sessions.restoreDeleted(doomed)).rejects.toThrow()
  })

  it('empties trash entries older than 30 days (FIX-01 3)', async () => {
    const { api } = await setup()
    session(api, 'Keep')
    const old = session(api, 'Old')
    const fresh = session(api, 'Fresh')
    await api.sessions.delete(old)
    await api.sessions.delete(fresh)
    const store = api.host.kept.sessionStore
    // Backdate the first deletion past the 30-day window.
    store.trash(store.restoreTrashed(old)!.id, '2026-08-01T00:00:00.000Z')
    const purged = await api.sessions.purgeExpiredDeleted(
      Date.parse('2026-10-19T00:00:00.000Z'),
    )
    expect(purged).toEqual([old])
    expect(api.sessions.listDeleted().map((item) => item.id)).toEqual([fresh])
  })

  it('keeps private writes under stateRoot, not the repository root', async () => {
    const { api, root, stateRoot } = await setup({
      replies: [{ text: 'pong' }],
    })
    const id = session(api)
    await api.chat.submit({ content: 'ping', sessionId: id })
    const skill =
      '---\nname: user-skill\ndescription: Mine\n---\n# User Skill\n'
    api.skillService.save('user-skill', skill)
    expect(
      readFileSync(join(stateRoot, 'skills', 'user-skill', 'SKILL.md'), 'utf8'),
    ).toBe(skill)
    expect(existsSync(join(stateRoot, 'sessions'))).toBe(true)
    expect(existsSync(join(root, 'memory'))).toBe(false)
    expect(existsSync(join(root, 'sessions'))).toBe(false)
    expect(existsSync(join(root, 'skills'))).toBe(false)
  })

  it('saves model config in stateRoot', async () => {
    const { api, root, stateRoot } = await setup()
    await api.model.saveEntry(
      validModelEntry('state-root-model') as never,
      VIEW,
    )
    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(true)
    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'model_config.json'), 'utf8'))
        .models[0].displayName,
    ).toBe('state-root-model')
  })

  it('deletes skill directories through skills.delete', async () => {
    const root = tmp('emperor-core-api-skill-delete-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(stateRoot, 'skills', 'demo', 'SKILL.md'), '# Demo\n')
    const { api } = await setup({ root, stateRoot })
    expect(api.skills.delete('demo', { sessionId: null }, VIEW)).toMatchObject({
      deleted: 'demo',
      scope: 'user',
    })
    expect(existsSync(join(stateRoot, 'skills', 'demo'))).toBe(false)
  })

  it('lists Skills per session and bootstraps invalid Skills with reasons', async () => {
    const root = tmp('emperor-core-api-skill-sessions-')
    const stateRoot = join(root, 'home')
    const project = join(root, 'project')
    mkdirSync(join(project, '.cutroom', 'skills', 'deploy'), {
      recursive: true,
    })
    writeFileSync(
      join(project, '.cutroom', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the project\n---\n',
    )
    mkdirSync(join(stateRoot, 'skills', 'broken'), { recursive: true })
    writeFileSync(join(stateRoot, 'skills', 'broken', 'SKILL.md'), '# Broken\n')
    const { api } = await setup({ root, stateRoot })
    const build = String(
      api.sessions.create({
        title: 'Build',
        mode: 'build',
        project_path: project,
      }).id,
    )
    const chat = session(api)

    const names = (sessionId: string) =>
      api.skills.list({ sessionId }).skills.map((skill) => skill.name)
    expect(names(build)).toContain('deploy')
    expect(names(chat)).not.toContain('deploy')
    expect(api.skills.list({ sessionId: build }).invalid).toEqual([
      expect.objectContaining({
        name: 'broken',
        source: 'user',
        reason: 'SKILL.md must start with YAML frontmatter (---)',
      }),
    ])
    const boot = await api.bootstrap({ sessionId: build })
    expect(boot.skills.map((skill) => skill.name)).toContain('deploy')
    expect(boot.invalidSkills).toEqual([
      expect.objectContaining({ name: 'broken' }),
    ])
    expect(
      await api.commandApplicationService.skillsForSession(chat),
    ).not.toContainEqual(expect.objectContaining({ name: 'deploy' }))
    expect(api.skills.folderPath({ scope: 'project', sessionId: build })).toBe(
      join(project, '.cutroom', 'skills'),
    )
  })
})
