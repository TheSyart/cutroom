// HarnessHost end to end on a temporary Emperor Home with a scripted model:
// a full turn streamed to the UI sink, sandbox escalation through the
// approval interaction, ask_user_question answered from control, plan mode
// review, stop, and replay equal to the live projection.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import { messageText } from '../../llm/message'
import type { RouteSpec } from '../../llm/route'
import type { GenerateOptions } from '../../llm/types'

import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../testing'
import { assertRequestInvariant } from '../agent/invariant'
import { HarnessHost } from './host'
import { VideoProjectService } from '../../editing/project-store'
import { EditRunService } from '../../editing/edit-run'
import { createPrecisionTools } from '../../editing/precision-tools'
import { VideoAnalysisService } from '../../editing/analysis/service'
import { ChatService } from '../../api/chat-service'

const hosts: HarnessHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

async function makeHost(
  replies: ScriptedReply[] = [],
  options: { templatesDir?: string; route?: Partial<RouteSpec> } = {},
): Promise<{
  host: HarnessHost
  adapter: ScriptedAdapter
  events: Array<Record<string, unknown>>
}> {
  const root = mkdtempSync(join(tmpdir(), 'harness-host-'))
  const adapter = new ScriptedAdapter(replies)
  const ref: { host?: HarnessHost } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.host?.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute(options.route)], 'test-route')
  const events: Array<Record<string, unknown>> = []
  const host = await HarnessHost.create({
    root,
    ...(options.templatesDir === undefined
      ? {}
      : { templatesDir: options.templatesDir }),
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    eventSink: (event) => {
      events.push(event)
    },
  })
  ref.host = host
  hosts.push(host)
  return { host, adapter, events }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The repository's shipped prompt templates (persona.md). */
const REPO_TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'templates',
)

describe('HarnessHost', () => {
  it('keeps the model and working directory out of the system prompt prefix', async () => {
    const one = await makeHost([{ text: 'one' }], {
      templatesDir: REPO_TEMPLATES,
    })
    const two = await makeHost([{ text: 'two' }], {
      templatesDir: REPO_TEMPLATES,
      route: { modelId: 'other-model' },
    })
    const fallback = await makeHost([{ text: 'three' }])
    const requests: GenerateOptions[] = []
    for (const { host, adapter } of [one, two, fallback]) {
      const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
      await host.submit({ sessionId: entry.id, content: 'hi' })
      requests.push(adapter.requests[0]!)
    }
    const [a, b, c] = requests as [
      GenerateOptions,
      GenerateOptions,
      GenerateOptions,
    ]
    const prefix = (request: GenerateOptions) =>
      Buffer.from(request.system ?? '').subarray(0, 200)
    expect(a.system).toMatch(/^You are Cutroom/)
    expect(prefix(a).equals(prefix(b))).toBe(true)
    for (const [request, model, host] of [
      [a, 'test-model', one.host],
      [b, 'other-model', two.host],
      [c, 'test-model', fallback.host],
    ] as const) {
      const cwd = host.chatWorkspace()
      expect(request.system).not.toContain(cwd)
      expect(request.system).not.toContain(model)
      // Both facts reach the model through the runtime-context snapshot.
      const context = request.messages.find(
        (message) =>
          message.source.kind === 'context' &&
          message.source.producer === 'runtime-context',
      )
      expect(context && messageText(context)).toContain(JSON.stringify(cwd))
      expect(context && messageText(context)).toContain(model)
    }
  })

  it('runs a turn and streams the projected timeline', async () => {
    const { host, adapter, events } = await makeHost([
      { text: 'Hello from Emperor' },
    ])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const result = await host.submit({
      sessionId: entry.id,
      content: 'hi',
      clientMessageId: 'c1',
      displayContent: 'hi!',
    })
    expect(result.content).toBe('Hello from Emperor')
    expect(result.turnId).toBe(`${entry.id}:1`)
    const names = events.map((event) => event.event)
    expect(names).toContain('user_message')
    expect(names).toContain('message_delta')
    expect(names).toContain('assistant_done')
    const user = events.find((event) => event.event === 'user_message')!
    expect(user).toMatchObject({
      content: 'hi!',
      client_message_id: 'c1',
      session_id: entry.id,
    })
    const request = adapter.requests[0]!
    expect(request.system).toContain('Cutroom')
    expect(request.tools?.map((tool) => tool.name).sort()).toEqual(
      ['ask_user_question', 'exit_plan_mode', 'skill', 'memory_edit'].sort(),
    )
    const live = events.filter((event) => Number(event.seq) > 0)
    expect(host.replay(entry.id).events).toEqual(live)
  })

  it('tells the model to link local files, the same text on every turn', async () => {
    const { host, adapter } = await makeHost([{ text: 'one' }, { text: 'two' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'a' })
    await host.submit({ sessionId: entry.id, content: 'b' })
    const [first, second] = adapter.requests.map((request) => request.system!)
    expect(first).toContain('[label](#ve-cut-SECONDS)')
    expect(first).toContain('timecode')
    expect(first!.indexOf('[label](#ve-cut-SECONDS)')).toBeGreaterThan(
      first!.indexOf('Cutroom'),
    )
    expect(second).toBe(first)
  })

  it.each(['timeline.json', 'video-edit.json'])(
    'hides generic file writers and shows the bound editing tools for %s',
    async (filename) => {
      const { host } = await makeHost()
      const project = mkdtempSync(join(tmpdir(), 'host-video-project-'))
      writeFileSync(join(project, filename), '{}')
      const service = new VideoProjectService({
        getSession: () => null,
        createBuildSession: (projectPath, title) => ({
          id: 'unused',
          mode: 'build',
          project_path: projectPath,
          title,
        }),
      })
      host.installVideoProjectTools(service)
      const editing = host.kept.sessionStore.create('edit', {
        mode: 'build',
        project: { project_path: project },
      })
      const chat = host.kept.sessionStore.create('chat', { mode: 'chat' })
      const editingAgent = host.agentFor(editing.id)
      const chatAgent = host.agentFor(chat.id)
      expect(host.tools.get('video_project_read', editingAgent)).toBeDefined()
      expect(host.tools.get('video_edit_apply', editingAgent)).toBeDefined()
      expect(host.tools.get('write', editingAgent)).toBeUndefined()
      expect(host.tools.get('edit', editingAgent)).toBeUndefined()
      expect(host.tools.get('bash', editingAgent)).toBeUndefined()
      expect(host.tools.get('video_project_read', chatAgent)).toBeUndefined()
      expect(host.tools.get('write', chatAgent)).toBeUndefined()
      const assembly = host.prompt.assemble({ agent: editingAgent })
      expect(
        assembly.contexts.find((context) => context.name === 'video-editing')
          ?.text,
      ).toContain('video_project_read')
    },
  )

  it('scopes motion tools and their packaged authoring instructions to the enabled project', async () => {
    const { host } = await makeHost([], { templatesDir: REPO_TEMPLATES })
    const projectPath = mkdtempSync(join(tmpdir(), 'host-video-motion-'))
    try {
      const service = new VideoProjectService({
        getSession: (id) => host.kept.sessionStore.get(id),
        createBuildSession: (path, title) =>
          host.kept.sessionStore.create(title, {
            mode: 'build',
            project: { project_path: path },
          }),
      })
      host.installVideoProjectTools(service)
      const { sessionId } = await service.open({
        projectPath,
        initialize: true,
      })
      const agent = host.agentFor(sessionId)
      const chat = host.agentFor(
        host.kept.sessionStore.create('chat', { mode: 'chat' }).id,
      )
      const guidance = () =>
        host.prompt
          .assemble({ agent })
          .contexts.find((c) => c.name === 'project-motion-authoring')?.text
      expect(host.tools.get('video_motion_begin', agent)).toBeUndefined()
      expect(guidance()).toBe('')
      await service.setMotionEnabled({ sessionId, enabled: true })
      expect(host.tools.get('video_motion_object', agent)).toBeDefined()
      expect(host.tools.get('video_motion_object', chat)).toBeUndefined()
      expect(guidance()).toContain('video_motion_object')
      expect(host.tools.get('bash', agent)).toBeUndefined()
      await service.setMotionEnabled({ sessionId, enabled: false })
      expect(host.tools.get('video_motion_finish', agent)).toBeUndefined()
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  it('hands a chat request to the same project session and uses its manual plan decision as the only treatment approval', async () => {
    const { host, adapter, events } = await makeHost([], {
      route: { vision: true },
    })
    const root = mkdtempSync(join(tmpdir(), 'host-edit-treatment-'))
    const stateRoot = join(root, 'private')
    try {
      const projects = new VideoProjectService({
        getSession: (id) => host.kept.sessionStore.get(id),
        createBuildSession: (project_path, title) =>
          host.kept.sessionStore.create(title, {
            mode: 'build',
            project: { project_path },
          }),
        editRuns: async () => runs,
      })
      const runs: EditRunService = new EditRunService({
        projects,
        stateRoot,
        recipient: (id) => host.precisionRecipient(id),
        ready: async () => ({ ffmpegPath: '/ffmpeg' }),
        review: async () => {
          throw new Error('not used in this test')
        },
        turn: async (id, prompt, signal) =>
          (
            await host.runBackgroundTurn(host.scopeFor(id), prompt, {
              source: 'video-precision-edit',
              signal,
              uiHidden: true,
              continueTask: true,
              interactionPolicy: 'wait',
            })
          ).result,
        emit: () => {},
      })
      host.installVideoProjectTools(projects)
      host.installPrecisionTools(
        {
          runs,
          analysis: new VideoAnalysisService({ stateRoot }),
          start: (sessionId, brief, mode) =>
            projects.startEditRun({ sessionId, brief, mode }, true),
        },
        createPrecisionTools,
        'Use the editorial tools.',
      )
      const { sessionId } = await projects.open({
        projectPath: root,
        initialize: true,
      })
      const image = join(root, 'still.png')
      writeFileSync(image, 'fixture')
      const { project } = await projects.importAssets({
        sessionId,
        sourcePaths: [image],
      })
      const attachment = host.attachments.save({
        name: 'brief.txt',
        mime: 'text/plain',
        raw: Buffer.from('attachment-brief-evidence'),
      })
      const request = '整片精剪，保留介绍。'
      const treatment = {
        summary: '保留介绍',
        mustKeep: [],
        pacing: '自然',
        picture: '沿用原画面',
      }
      host.setPlanMode(sessionId, true)
      adapter.push(
        {
          tools: [
            { id: 'handoff', name: 'video_start_precision_edit', args: {} },
          ],
        },
        (req) => {
          const history = JSON.stringify(req.messages)
          expect(req.tools?.map((tool) => tool.name)).toContain(
            'video_propose_treatment',
          )
          expect(history).toContain(request)
          expect(history).toContain('attachment-brief-evidence')
          expect(history).toContain('/captions')
          return replyChunks({
            tools: [
              {
                id: 'propose',
                name: 'video_propose_treatment',
                args: treatment,
              },
            ],
          })
        },
        {
          tools: [
            {
              id: 'adjusted',
              name: 'video_propose_treatment',
              args: { ...treatment, pacing: '慢一点' },
            },
          ],
        },
        {
          tools: [
            {
              id: 'stage',
              name: 'video_stage_edit',
              args: {
                phase: 'rough_cut',
                generation: 0,
                commands: [
                  {
                    type: 'addClip',
                    assetId: project.assets[0]!.id,
                    duration: 2,
                  },
                ],
              },
            },
          ],
        },
        { text: '已保存草稿' },
        { text: '检查点' },
      )
      await new ChatService(host).submit({
        sessionId,
        content: request,
        attachmentIds: [attachment.id],
        requestedSkills: [{ name: 'captions' }],
      })
      await waitFor(() => events.some((e) => e.event === 'plan_draft'))
      const reviews = () =>
        events
          .filter((e) => e.event === 'plan_draft')
          .map((e) => e.interaction as { id: string; plan_markdown: string })
      expect(reviews()[0]?.plan_markdown).toContain('保留介绍')
      expect(await runs.draftSnapshot(sessionId)).toMatchObject({
        generation: 0,
      })
      host.commentPlan(reviews()[0]!.id, '节奏慢一点')
      await waitFor(() => reviews().length === 2)
      expect(reviews()[1]?.plan_markdown).toContain('慢一点')
      expect(host.controlPayload(sessionId).plan).toBe(true)
      host.approvePlan(reviews()[1]!.id)
      await waitFor(() => !runs.isRunning(sessionId))
      expect(await runs.draftSnapshot(sessionId)).toMatchObject({
        generation: 1,
      })
      expect(host.controlPayload(sessionId).plan).toBe(false)
      expect(events.filter((e) => e.event === 'plan_approved')).toHaveLength(1)
      expect(events.some((e) => e.event === 'ask_request')).toBe(false)
      expect((await projects.inspect(sessionId)).project).toEqual(project)
      expect(
        host
          .agentFor(sessionId)
          .session.events.filter(
            (e) => e.type === 'host/user-meta' && !e.data.uiHidden,
          ),
      ).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks direct project changes in plan mode and runs them after leaving plan mode', async () => {
    const { host, adapter, events } = await makeHost()
    const projectPath = mkdtempSync(join(tmpdir(), 'host-video-plan-'))
    try {
      const service = new VideoProjectService({
        getSession: (id) => host.kept.sessionStore.get(id),
        createBuildSession: (path, title) =>
          host.kept.sessionStore.create(title, {
            mode: 'build',
            project: { project_path: path },
          }),
      })
      const opened = await service.open({ projectPath, initialize: true })
      const { sessionId } = opened
      const seeded = await service.mutate({
        sessionId,
        expectedRevision: opened.project.revision,
        command: { type: 'updateCanvas', background: '#010203' },
      })
      host.installVideoProjectTools(service)
      const agent = host.agentFor(sessionId)
      const edits = {
        tools: [
          {
            id: 'apply-edit',
            name: 'video_edit_apply',
            args: { command: { type: 'updateCanvas', background: '#112233' } },
          },
          {
            id: 'undo-edit',
            name: 'video_edit_history',
            args: { action: 'undo' },
          },
        ],
      }
      adapter.push(
        edits,
        { text: 'plan' },
        {
          tools: [
            {
              id: 'local-plan',
              name: 'exit_plan_mode',
              args: { plan: '# 修改背景色\n将画布调成蓝色，再撤销。' },
            },
          ],
        },
        edits,
        { text: 'done' },
      )

      host.setPlanMode(sessionId, true)
      await host.submit({ sessionId, content: 'Plan a canvas color change.' })
      const planResults = agent.session.events.flatMap((event) =>
        event.type === 'tool/result' ? [event.data.message] : [],
      )
      expect((await service.inspect(sessionId)).project).toEqual(seeded.project)
      expect(planResults).toHaveLength(2)
      for (const result of planResults) {
        expect(result.content).toMatchObject([
          {
            isError: true,
            content: [
              { type: 'text', text: expect.stringContaining('计划模式') },
            ],
          },
        ])
      }
      expect(
        events.filter((event) => event.event === 'video_project_changed'),
      ).toHaveLength(0)

      const local = host.submit({
        sessionId,
        content: 'Change the canvas color, then undo it.',
      })
      await waitFor(() => events.some((event) => event.event === 'plan_draft'))
      expect((await service.inspect(sessionId)).project).toEqual(seeded.project)
      const review = events.find((event) => event.event === 'plan_draft')!
        .interaction as { id: string }
      host.approvePlan(review.id)
      await local
      expect(host.controlPayload(sessionId).plan).toBe(false)
      expect((await service.inspect(sessionId)).project).toMatchObject({
        revision: seeded.project.revision + 2,
        canvas: { background: '#010203' },
      })
      expect(
        events.filter((event) => event.event === 'video_project_changed'),
      ).toHaveLength(2)
      expect(events.some((event) => event.event === 'ask_request')).toBe(false)
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  it('answers ask_user_question and plan reviews through control', async () => {
    const { host, events } = await makeHost()
    const adapter = (
      host.llm as unknown as { options: { adapterFor: () => ScriptedAdapter } }
    ).options.adapterFor()
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    adapter.push(
      {
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
      },
      (request: GenerateOptions) => {
        expect(JSON.stringify(request.messages.at(-1)?.content)).toContain(
          'blue',
        )
        return replyChunks({ text: 'blue it is' })
      },
    )
    const first = host.submit({ sessionId: entry.id, content: 'pick' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    const ask = events.find((event) => event.event === 'ask_request')!
      .interaction as { id: string }
    host.answerInteraction(ask.id, { color: { choice: 'blue', freeform: '' } })
    expect((await first).content).toBe('blue it is')

    host.setPlanMode(entry.id, true)
    adapter.push(
      (request: GenerateOptions) => {
        expect(request.system).toContain('You are in plan mode')
        return replyChunks({
          tools: [
            {
              id: 'p1',
              name: 'exit_plan_mode',
              args: { plan: '# Do the thing\n- step' },
            },
          ],
        })
      },
      { text: 'implementing' },
    )
    const second = host.submit({ sessionId: entry.id, content: 'plan it' })
    await waitFor(() => events.some((event) => event.event === 'plan_draft'))
    const plan = events.find((event) => event.event === 'plan_draft')!
      .interaction as { id: string; plan_markdown: string }
    expect(plan.plan_markdown).toContain('# Do the thing')
    host.approvePlan(plan.id)
    await second
    expect(events.some((event) => event.event === 'plan_approved')).toBe(true)
    expect(host.controlPayload(entry.id).plan).toBe(false)
  })

  it('ends the turn when the user dismisses the plan review, without another model request', async () => {
    const { host, adapter, events } = await makeHost([
      {
        tools: [
          {
            id: 'p1',
            name: 'exit_plan_mode',
            args: { plan: '# Do the thing\n- step' },
          },
        ],
      },
      // Consumed only if the dismissal regresses to another model request.
      { text: 'Waiting for your message.' },
    ])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    host.setPlanMode(entry.id, true)
    const submitted = host.submit({ sessionId: entry.id, content: 'plan it' })
    await waitFor(() => events.some((event) => event.event === 'plan_draft'))
    const plan = events.find((event) => event.event === 'plan_draft')!
      .interaction as { id: string }
    host.cancelInteraction(plan.id)
    await submitted
    expect(adapter.requests).toHaveLength(1)
    const log = host.sessionLog(entry.id)!
    expect(log.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'plan-dismissed',
    })
    const result = log.lastOf('tool/result')!
    expect(result.data.message.content[0]).toMatchObject({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
        },
      ],
    })
    expect(result.data.meta).toMatchObject({ approved: false, dismissed: true })
    expect(host.controlPayload(entry.id).plan).toBe(true)
    expect(
      events.find((event) => event.event === 'assistant_done'),
    ).toMatchObject({ stop_reason: 'plan-dismissed' })
  })

  it('announces queued prompts entering and leaving the inbox', async () => {
    const { host, events } = await makeHost([{ hang: true }, { text: 'two' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const first = host.submit({ sessionId: entry.id, content: 'one' })
    await waitFor(() => host.isBusy(entry.id))
    const second = host.submit({ sessionId: entry.id, content: 'two' })
    await waitFor(() => events.some((event) => event.event === 'prompt_queued'))
    const queued = host.queuedPrompts(entry.id)
    expect(queued).toHaveLength(1)
    const queuedEvents = events.filter(
      (event) => event.event === 'prompt_queued',
    )
    expect(queuedEvents).toEqual([
      expect.objectContaining({
        session_id: entry.id,
        prompt_id: queued[0]!.prompt_id,
        seq: 0,
      }),
    ])
    expect(
      host.manageQueuedPrompt(entry.id, queued[0]!.prompt_id, 'cancel'),
    ).toEqual({ ok: true })
    await waitFor(() =>
      events.some((event) => event.event === 'prompt_dequeued'),
    )
    expect(
      events.find((event) => event.event === 'prompt_dequeued'),
    ).toMatchObject({ session_id: entry.id, prompt_id: queued[0]!.prompt_id })
    host.stop(entry.id)
    await Promise.all([first, second])
  })

  it('stops a running turn and cancels pending questions', async () => {
    const { host, events } = await makeHost()
    const adapter = (
      host.llm as unknown as { options: { adapterFor: () => ScriptedAdapter } }
    ).options.adapterFor()
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    adapter.push({
      tools: [
        {
          id: 'q',
          name: 'ask_user_question',
          args: { questions: [{ id: 'a', question: 'ok?' }] },
        },
      ],
    })
    const submitted = host.submit({ sessionId: entry.id, content: 'go' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    expect(host.stop(entry.id)).toBe(true)
    await submitted
    expect(
      events.some((event) => event.event === 'runtime_task_cancelled'),
    ).toBe(true)
    expect(host.controlPayload(entry.id).pending).toBeNull()
  })

  it('loads AGENTS.md and memory as durable context', async () => {
    const { host, adapter } = await makeHost([{ text: 'ok' }])
    writeFileSync(
      host.kept.sharedMemory.memoryFile,
      '# Memory\n- The user likes tea.\n',
    )
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    writeFileSync(
      join(host.chatWorkspace(), 'AGENTS.md'),
      'Always answer briefly.',
    )
    await host.submit({ sessionId: entry.id, content: 'hello' })
    const text = JSON.stringify(adapter.requests[0]!.messages)
    expect(text).toContain('Always answer briefly.')
    expect(text).toContain('The user likes tea.')
  })

  it('tells the UI when opening a session repaired its log', async () => {
    const { host, events } = await makeHost([{ text: 'ok' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'hi' })
    host.sessions.close(entry.id)
    appendFileSync(
      join(host.sessions.root, entry.id, 'log.jsonl'),
      '{"type":"tu',
    )
    expect(host.sessions.open(entry.id).hasOpenTurn()).toBe(false)
    await waitFor(() => events.some((e) => e.event === 'session_log_state'))
    expect(events.find((e) => e.event === 'session_log_state')).toMatchObject({
      session_id: entry.id,
      state: 'repaired',
      kind: 'tail',
      dropped_bytes: 11,
      seq: 0,
    })
  })
})
