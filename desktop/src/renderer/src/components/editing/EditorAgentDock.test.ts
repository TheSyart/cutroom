// @vitest-environment jsdom
import { serializeComposer } from '../composer/editor/composerDocument'
import {
  createApp,
  h,
  nextTick,
  reactive,
  ref,
  shallowRef,
  type App,
} from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorAgentDock from './EditorAgentDock.vue'
import { composerView } from '../composer/editor/editorTesting'
import { TextSelection } from 'prosemirror-state'
import { answerConfirmsForTest } from '../ui/confirm'
import {
  clearEditorAgentFocus,
  editorAgentFocus,
  requestEditorAgentFocus,
} from './editorAgentFocus'
import {
  handTimelineReferenceTo,
  takeTimelineReferences,
} from './editorTimelineHandoff'

Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect ??= () => new DOMRect()

const mock = vi.hoisted(() => ({
  ctx: null as any,
  conversation: null as any,
  workspace: null as any,
  invokeCore: vi.fn(),
  core: vi.fn(),
  openSettings: vi.fn(),
  push: vi.fn(),
  listeners: [] as Array<(event: unknown) => void>,
}))

vi.mock('../../composables/useAppContext', () => ({
  useAppContext: () => mock.ctx,
}))
vi.mock('../../composables/useSessionConversation', () => ({
  useSessionConversation: () => mock.conversation,
}))
vi.mock('./editingStore', () => ({
  useEditingWorkspace: () => mock.workspace,
}))
vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  invokeCore: (...args: unknown[]) => mock.invokeCore(...args),
  onCoreEvent: (listener: (event: unknown) => void) => {
    mock.listeners.push(listener)
    return () => {
      mock.listeners = mock.listeners.filter((item) => item !== listener)
    }
  },
}))
vi.mock('../../api/http', () => ({
  core: (...args: unknown[]) => mock.core(...args),
}))
vi.mock('../settings/useSettingsRoute', () => ({
  useSettingsRoute: () => ({ openSettings: mock.openSettings }),
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: mock.push }),
}))
vi.mock('../conversation/ChatTimeline.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { sessionId: { type: String, default: '' } },
      setup(props) {
        return () =>
          h('div', {
            'data-testid': 'timeline',
            'data-session': props.sessionId,
          })
      },
    }),
  }
})
vi.mock('../conversation/takeover/TakeoverSeat.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { interaction: { type: Object, required: true } },
      setup(props) {
        return () =>
          h('div', {
            'data-testid': 'takeover',
            'data-id': (props.interaction as { id: string }).id,
          })
      },
    }),
  }
})
let app: App | undefined
let root: HTMLDivElement
const sessionId = ref('session-1')

beforeEach(() => {
  mock.ctx = {
    boot: ref({
      modelConfig: {
        current: {
          displayName: 'DeepSeek',
          modelId: 'deepseek-chat',
          capabilities: { vision: true },
        },
        availability: { usable: true, message: '' },
      },
    }),
    pendingInteractionsBySession: reactive<Record<string, unknown>>({}),
    openModelSetup: vi.fn(),
  }
  mock.conversation = shallowRef({
    running: ref(false),
    order: ref([]),
  })
  mock.workspace = {
    state: reactive({
      project: {
        name: 'Launch film',
        assets: [{ id: 'a1', displayName: 'interview.mp4' }],
        clips: [{ id: 'c1', assetId: 'a1' }],
      },
      selectedClipId: 'c1',
    }),
    referenceUnavailable: () => '',
    revealTimelineReference: vi.fn(),
    refreshFromDisk: vi.fn(async () => undefined),
    applyAgentFocus: vi.fn(),
    interruptMotion: vi.fn(),
    setMotionEnabled: vi.fn(),
  }
  mock.invokeCore.mockImplementation(async (key: string) =>
    key === 'videoProject.editRunStatus' ? null : {},
  )
  mock.core.mockResolvedValue({ pending: null })
  mock.openSettings.mockResolvedValue(undefined)
  mock.push.mockResolvedValue(undefined)
  mock.listeners = []
  sessionId.value = 'session-1'
  takeTimelineReferences('session-1')
  takeTimelineReferences('session-2')
  const focus = editorAgentFocus.value
  if (focus) clearEditorAgentFocus(focus.id)
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  answerConfirmsForTest(null)
  app?.unmount()
  root.remove()
  vi.clearAllMocks()
})

async function mount() {
  app = createApp({
    render: () =>
      h(EditorAgentDock, {
        sessionId: sessionId.value,
      }),
  })
  app.mount(root)
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function draftInput(): HTMLElement {
  return composerView(root).dom
}

function draftValue(): string {
  return serializeComposer(composerView(root).state.doc).content
}
function cite(sessionId: string, label: string): void {
  handTimelineReferenceTo(sessionId, {
    kind: 'timeline',
    id: crypto.randomUUID(),
    label,
    timeline: {
      sessionId,
      projectId: 'project-1',
      projectName: 'Film',
      revision: 1,
      target: { kind: 'point', time: 2 },
      start: 2,
      end: 2,
    },
  })
}

async function writeDraft(text: string): Promise<void> {
  const view = composerView(root)
  const { state } = view
  const selection = TextSelection.create(
    state.doc,
    1,
    state.doc.content.size - 1,
  )
  view.dispatch(state.tr.setSelection(selection).insertText(text))
  await nextTick()
}

function agentButton(testId: 'send' | 'stop'): HTMLButtonElement {
  const label = testId === 'send' ? '发送' : '停止'
  return root.querySelector(
    `[data-testid="editor-agent-composer"] button[aria-label="${label}"]`,
  )!
}

function admitMessage(clientMessageId: string, owner = 'session-1'): void {
  for (const listener of mock.listeners) {
    listener({
      event: 'user_message',
      session_id: owner,
      client_message_id: clientMessageId,
    })
  }
}

function deferOperation(operation: string) {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const result = new Promise<unknown>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  mock.invokeCore.mockImplementation(async (key: string) => {
    if (key === operation) return result
    if (key === 'videoProject.editRunStatus' && operation !== 'chat.submit')
      return result
    return null
  })
  return { resolve, reject }
}

function submittedClientMessageId(): string {
  const submission = mock.invokeCore.mock.calls.find(
    ([key]) => key === 'chat.submit',
  )
  return submission?.[1].clientMessageId
}

describe('editing agent dock', () => {
  it('binds the original timeline and composer to the workspace session', async () => {
    await mount()
    expect(root.querySelector('[aria-label="Cutroom Agent"]')).toBeTruthy()
    expect(draftInput().getAttribute('aria-label')).toBe('消息输入框')
    expect(
      root
        .querySelector('[data-testid="timeline"]')
        ?.getAttribute('data-session'),
    ).toBe('session-1')
    expect(root.textContent).not.toContain('口播与画面精剪')
    expect(root.textContent).not.toContain('当前片段 · interview.mp4')
    for (const generic of ['轨迹', '环境卡', '计划模式', 'Goal'])
      expect(root.textContent).not.toContain(generic)
  })

  it('clears on submit before chat finishes and preserves the next message', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft(' 把第 2 段剪短 ')
    agentButton('send').click()
    await nextTick()
    expect(mock.invokeCore).toHaveBeenCalledWith('chat.submit', {
      sessionId: 'session-1',
      content: '把第 2 段剪短',
      displayContent: '把第 2 段剪短',
      clientMessageId: expect.any(String),
    })
    admitMessage('unrelated-id')
    admitMessage(submittedClientMessageId(), 'session-2')
    await nextTick()
    expect(draftValue()).toBe('')
    mock.conversation.value.running.value = true
    admitMessage(submittedClientMessageId())
    await nextTick()
    expect(draftValue()).toBe('')
    expect(agentButton('stop')).toBeTruthy()
    await writeDraft('回复之后再处理结尾')
    chat.resolve({ delivery: 'completed', content: '已完成' })
    await Promise.resolve()
    await nextTick()
    expect(draftValue()).toBe('回复之后再处理结尾')
  })

  it('shows waiting and actual overlapping preparation steps before the first motion object', async () => {
    mock.workspace.state.motionEnabled = true
    mock.workspace.state.motionWork = {
      id: 'old',
      status: 'committed',
      target: 'live',
      message: '上次动效已完成',
    }
    await mount()
    const status = () =>
      root
        .querySelector('[data-testid=motion-work-status]')
        ?.textContent?.trim()
    const emit = (event: string, fields: Record<string, unknown>) =>
      mock.listeners.forEach((cb) =>
        cb({ event, session_id: 'session-1', ...fields }),
      )
    const chat = deferOperation('chat.submit')
    await writeDraft('给这句口播加动效')
    agentButton('send').click()
    await nextTick()
    expect(status()).toBe('正在等待模型响应')
    // Hydration of an older terminal job can arrive after this submission.
    mock.workspace.state.motionWork = {
      id: 'late-history',
      status: 'failed',
      target: 'live',
      message: '旧任务失败',
    }
    await nextTick()
    expect(status()).toBe('正在等待模型响应')
    emit('turn_phase', { phase: 'started', turn_id: 's:2' })
    emit('tool_call', {
      id: 'other',
      name: 'video_transcribe',
      session_id: 'unrelated',
    })
    await nextTick()
    expect(status()).toBe('正在等待模型响应')
    emit('tool_call', { id: 'r', name: 'video_project_read', turn_id: 's:2' })
    emit('tool_run_started', {
      id: 'r',
      name: 'video_project_read',
      turn_id: 's:2',
    })
    await nextTick()
    expect(status()).toBe('正在读取工程时间线')
    emit('tool_call', { id: 'v', name: 'video_inspect_frames', turn_id: 's:2' })
    emit('tool_result', { id: 'r', turn_id: 's:2' })
    await nextTick()
    expect(status()).toBe('正在检查素材画面')
    emit('tool_run_failed', { id: 'v', turn_id: 's:2' })
    emit('tool_call', {
      id: 'late',
      name: 'video_project_read',
      turn_id: 's:1',
    })
    await nextTick()
    expect(status()).toBe('正在等待模型响应')
    emit('tool_run_started', {
      id: 'audio',
      name: 'video_transcribe',
      turn_id: 's:2',
    })
    await nextTick()
    expect(status()).toBe('正在转写素材原声')
    mock.workspace.state.motionWork = {
      id: 'new',
      status: 'preparing',
      target: 'live',
      message: '正在准备动效「标注」。',
    }
    await nextTick()
    expect(status()).toBe('正在准备动效「标注」。')
    chat.resolve({ delivery: 'completed' })
  })

  it('shows precision preparation only in the owning session when motion drawing is enabled', async () => {
    mock.workspace.state.motionEnabled = true
    await mount()
    const emit = (event: string, id: string, name: string) =>
      mock.listeners.forEach((cb) =>
        cb({ event, session_id: 'session-1', id, name }),
      )
    const status = () =>
      root
        .querySelector('[data-testid=motion-work-status]')
        ?.textContent?.trim()
    emit('tool_call', 'p', 'video_analyze_workspace')
    await nextTick()
    expect(status()).toBe('正在分析精剪工程')
    sessionId.value = 'session-2'
    await nextTick()
    expect(status()).toBeUndefined()
    emit('tool_run_started', 'late', 'video_read_evidence')
    await nextTick()
    expect(status()).toBeUndefined()
    mock.workspace.state.motionEnabled = false
    mock.listeners.forEach((cb) =>
      cb({
        event: 'tool_call',
        session_id: 'session-2',
        id: 'q',
        name: 'video_read_video',
      }),
    )
    await nextTick()
    expect(status()).toBeUndefined()
  })

  it('keeps the exact draft and reports an error when Core rejects before admitting the message', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft(' 保留原始草稿\n ')
    agentButton('send').click()
    chat.reject(new Error('提交失败，请重试'))
    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(
        '提交失败，请重试',
      ),
    )
    expect(draftValue()).toBe(' 保留原始草稿\n ')
    expect(agentButton('send').disabled).toBe(false)
  })

  it('does not restore an admitted draft when the turn later fails', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft('把开头剪短')
    agentButton('send').click()
    admitMessage(submittedClientMessageId())
    chat.reject(new Error('本轮执行失败'))
    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toBe(
        '本轮执行失败',
      ),
    )
    expect(draftValue()).toBe('')
  })

  it('keeps a draft edited after submission even if the user types the same text again', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft('把开头剪短')
    agentButton('send').click()
    await writeDraft('把结尾剪短')
    await writeDraft('把开头剪短')
    admitMessage(submittedClientMessageId())
    chat.resolve({ delivery: 'completed' })
    await vi.waitFor(() =>
      expect(agentButton('send').getAttribute('aria-busy')).toBeNull(),
    )
    expect(draftValue()).toBe('把开头剪短')
  })

  it('keeps the current session draft when the former session is admitted and finishes', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft('工程 A 的草稿')
    agentButton('send').click()
    sessionId.value = 'session-2'
    await nextTick()
    await writeDraft('工程 B 的草稿')
    admitMessage(submittedClientMessageId())
    chat.resolve({ delivery: 'completed' })
    await Promise.resolve()
    await nextTick()
    expect(draftValue()).toBe('工程 B 的草稿')
  })

  it('stops the bound session', async () => {
    mock.conversation.value.running.value = true
    await mount()
    agentButton('stop').click()
    await Promise.resolve()
    expect(mock.invokeCore).toHaveBeenCalledWith('chat.stopRuntime', {
      sessionId: 'session-1',
    })
  })

  it('shows the approval card in the composer seat for this session', async () => {
    const interaction = {
      id: 'approval-1',
      kind: 'ask',
      status: 'waiting',
      meta: { interaction_type: 'permission' },
      questions: [],
    }
    mock.ctx.pendingInteractionsBySession['session-1'] = interaction
    await mount()
    expect(
      root.querySelector('[data-testid="takeover"]')?.getAttribute('data-id'),
    ).toBe('approval-1')
    const approval = root.querySelector('[data-testid="takeover"]')!
    const history = root.querySelector('[data-testid="timeline"]')!
    expect(
      history.compareDocumentPosition(approval) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('removes a hydrated approval when it is answered after reopening the dock', async () => {
    const interaction = {
      id: 'approval-1',
      kind: 'ask',
      status: 'waiting',
      meta: { interaction_type: 'permission' },
      questions: [],
    }
    mock.core.mockResolvedValue({ pending: interaction })
    await mount()
    expect(root.querySelector('[data-testid="takeover"]')).toBeTruthy()
    for (const listener of mock.listeners) {
      listener({ event: 'ask_answered', session_id: 'session-1', interaction })
    }
    await nextTick()
    expect(root.querySelector('[data-testid="takeover"]')).toBeNull()
  })

  it('takes all queued references when the dock loads and leaves other sessions queued', async () => {
    cite('session-1', '片段 1 · 00:00–00:03')
    cite('session-2', '片段 3 · 00:08–00:12')
    cite('session-1', '片段 2 · 00:03–00:08')
    requestEditorAgentFocus('composer')
    await mount()
    expect(draftValue()).toBe(
      '【片段 1 · 00:00–00:03】【片段 2 · 00:03–00:08】',
    )
    expect(document.activeElement).toBe(draftInput())
    sessionId.value = 'session-2'
    await nextTick()
    await vi.waitFor(() =>
      expect(draftValue()).toBe('【片段 3 · 00:08–00:12】'),
    )
    sessionId.value = 'session-1'
    await nextTick()
    expect(draftValue()).toBe('')
    expect(mock.invokeCore).not.toHaveBeenCalledWith(
      'chat.submit',
      expect.anything(),
    )
  })

  it('inserts two structured references at the remembered caret and sends their offsets', async () => {
    await mount()
    await writeDraft('甲乙')
    const view = composerView(root)
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)),
    )
    cite('session-1', '开头')
    cite('session-1', '结尾')
    await vi.waitFor(() => expect(draftValue()).toBe('甲【开头】【结尾】乙'))
    const chips = root.querySelectorAll<HTMLButtonElement>(
      'button[data-kind=timeline]',
    )
    expect(chips).toHaveLength(2)
    chips[0]!.click()
    expect(mock.workspace.revealTimelineReference).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    )
    agentButton('send').click()
    await vi.waitFor(() =>
      expect(mock.invokeCore).toHaveBeenCalledWith(
        'chat.submit',
        expect.objectContaining({
          content: '甲【开头】【结尾】乙',
          references: [
            expect.objectContaining({
              kind: 'timeline',
              start: 1,
              end: 5,
              timeline: expect.objectContaining({ start: 2 }),
            }),
            expect.objectContaining({ kind: 'timeline', start: 5, end: 9 }),
          ],
        }),
      ),
    )
  })

  it.each([
    ['before', '处理这一段\n'],
    ['after', '处理这一段'],
  ])(
    'clears only the sent text when the receipt arrives %s references reach the composer',
    async (receiptTiming, submittedText) => {
      await mount()
      const chat = deferOperation('chat.submit')
      await writeDraft(submittedText)
      agentButton('send').click()
      cite('session-1', '片段 1 · 00:02–00:06')
      if (receiptTiming === 'after') await nextTick()
      cite('session-1', '片段 2 · 00:07–00:09')
      admitMessage(submittedClientMessageId())
      chat.resolve({ delivery: 'completed' })
      await vi.waitFor(() =>
        expect(agentButton('send').getAttribute('aria-busy')).toBeNull(),
      )
      await vi.waitFor(() => {
        const text = draftValue()
        expect(text).toBe('【片段 1 · 00:02–00:06】【片段 2 · 00:07–00:09】')
      })
    },
  )

  it('keeps user changes and appended references together when the previous draft is admitted', async () => {
    await mount()
    const chat = deferOperation('chat.submit')
    await writeDraft('处理这一段')
    agentButton('send').click()
    await writeDraft('处理这一段，再处理结尾')
    cite('session-1', '片段 1 · 00:02–00:06')
    admitMessage(submittedClientMessageId())
    chat.resolve({ delivery: 'completed' })
    await vi.waitFor(() =>
      expect(agentButton('send').getAttribute('aria-busy')).toBeNull(),
    )
    await vi.waitFor(() =>
      expect(draftValue()).toBe(
        '处理这一段，再处理结尾【片段 1 · 00:02–00:06】',
      ),
    )
  })

  it('sends whole-film work through the same chat as local edits', async () => {
    await mount()
    await writeDraft('看完整片，给我剪辑方案，确认后精剪交付。')
    agentButton('send').click()
    expect(mock.invokeCore).toHaveBeenCalledWith(
      'chat.submit',
      expect.objectContaining({
        sessionId: 'session-1',
        content: '看完整片，给我剪辑方案，确认后精剪交付。',
      }),
    )
    expect(mock.invokeCore).not.toHaveBeenCalledWith(
      'videoProject.startEditRun',
      expect.anything(),
    )
  })

  it('retains the same composer draft across a pending question and restores it on settlement', async () => {
    await mount()
    await writeDraft('还没发送的修改意见')
    mock.ctx.pendingInteractionsBySession['session-1'] = {
      id: 'q1',
      kind: 'ask',
      status: 'waiting',
      questions: [],
    }
    await nextTick()
    expect(
      root.querySelector(
        '[data-testid="editor-agent-composer"] [data-testid="takeover"]',
      ),
    ).toBeTruthy()
    expect(draftValue()).toBe('还没发送的修改意见')
    delete mock.ctx.pendingInteractionsBySession['session-1']
    await nextTick()
    expect(root.querySelector('[data-testid="takeover"]')).toBeNull()
    expect(draftValue()).toBe('还没发送的修改意见')
  })

  it('enters and leaves plan mode on the bound editing session and observes its plan transitions', async () => {
    mock.core.mockImplementation(async (key: string, mode?: string) =>
      key === 'control.setMode'
        ? { control: { plan: mode === 'plan' } }
        : { plan: false },
    )
    await mount()
    const menu = root.querySelector<HTMLButtonElement>(
      '[aria-label="添加附件与能力"]',
    )!
    menu.click()
    await nextTick()
    const plan = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes('计划模式'))!
    plan.click()
    await vi.waitFor(() =>
      expect(root.querySelector('[aria-label="退出计划"]')).toBeTruthy(),
    )
    expect(mock.core).toHaveBeenCalledWith(
      'control.setMode',
      'plan',
      'session-1',
    )
    root.querySelector<HTMLButtonElement>('[aria-label="退出计划"]')!.click()
    await vi.waitFor(() =>
      expect(root.querySelector('[aria-label="退出计划"]')).toBeNull(),
    )
    expect(mock.core).toHaveBeenCalledWith(
      'control.setMode',
      'default',
      'session-1',
    )
    for (const listener of mock.listeners)
      listener({
        event: 'control_mode_update',
        session_id: 'session-2',
        control: { plan: true },
      })
    await nextTick()
    expect(root.querySelector('[aria-label="退出计划"]')).toBeNull()
  })

  it('shows the current treatment while it is awaiting approval', async () => {
    mock.invokeCore.mockResolvedValue({
      runId: 'run-1',
      state: 'awaiting_approval',
      message: '等待确认',
      treatment: {
        summary: '按讲解主题组织',
        sections: ['开头点题'],
        mustKeep: ['关键演示'],
        pacing: '保留自然换气',
        picture: '口播与演示同步',
      },
    })
    await mount()
    const task = root.querySelector('[aria-label="精剪任务"]')!
    const history = root.querySelector('[data-testid="timeline"]')!
    expect(
      task.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(root.textContent).toContain('按讲解主题组织')
    expect(root.textContent).toContain('关键演示')
  })

  it('seeks to a review issue and resumes the current run', async () => {
    mock.invokeCore.mockImplementation(async (key: string) =>
      key === 'videoProject.editRunStatus'
        ? {
            runId: 'run-1',
            state: 'paused',
            message: '分析已暂停',
            canResume: true,
            issues: [
              {
                code: 'picture-gap',
                start: 3.5,
                end: 4,
                severity: 'warning',
                message: '画面短暂空缺',
              },
            ],
          }
        : { runId: 'run-1', state: 'reviewing', message: '正在审片' },
    )
    await mount()
    const button = (label: string) =>
      Array.from(root.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(label),
      )
    button('画面短暂空缺')?.click()
    expect(mock.workspace.applyAgentFocus).toHaveBeenCalledWith({ time: 3.5 })
    button('继续精剪')?.click()
    await Promise.resolve()
    await nextTick()
    expect(mock.invokeCore).toHaveBeenCalledWith('videoProject.editRunAction', {
      sessionId: 'session-1',
      runId: 'run-1',
      action: 'resume',
    })
    expect(root.textContent).toContain('正在审片')
  })

  it('keeps adoption as the primary action while a prepared draft awaits a decision', async () => {
    mock.invokeCore.mockResolvedValue({
      runId: 'run-1',
      state: 'paused',
      message: '草稿就绪',
      canAdopt: true,
      canResume: false,
      treatment: {
        summary: '方案',
        mustKeep: [],
        pacing: '慢',
        picture: '沿用',
      },
    })
    await mount()
    const task = root.querySelector('[aria-label="精剪任务"]')!
    expect(task.textContent).toContain('草稿待采用')
    expect(task.textContent).not.toContain('新建精剪任务')
    expect(task.textContent).not.toContain('写下修改要求')
    expect(
      task.querySelector('button[data-variant="primary"]')?.textContent,
    ).toContain('采用精剪草稿')
  })

  it('offers an inline retry for a failed precision action and clears it on success', async () => {
    const paused = {
      runId: 'run-1',
      state: 'paused',
      message: '等待继续',
      canResume: true,
    }
    let attempts = 0
    mock.invokeCore.mockImplementation(async (key: string) => {
      if (key === 'videoProject.editRunStatus') return paused
      if (++attempts === 1) throw new Error('暂时无法读取素材')
      return {
        ...paused,
        state: 'analyzing',
        message: '继续分析',
        canResume: false,
      }
    })
    await mount()
    const task = root.querySelector('[aria-label="精剪任务"]')!
    const action = () =>
      Array.from(task.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('继续精剪'),
      )!
    action().click()
    await vi.waitFor(() =>
      expect(task.querySelector('[role="alert"]')?.textContent).toContain(
        '暂时无法读取素材',
      ),
    )
    expect(action().textContent).toContain('重试')
    action().click()
    await vi.waitFor(() => expect(task.textContent).toContain('继续分析'))
    expect(task.querySelector('[role="alert"]')).toBeNull()
  })

  it('updates the task phase when a draft change is announced', async () => {
    const run = { runId: 'run-1', state: 'rough_cut', message: '正在粗剪' }
    mock.invokeCore.mockResolvedValueOnce(run)
    await mount()
    expect(root.textContent).toContain('正在粗剪')
    mock.invokeCore.mockResolvedValueOnce({
      ...run,
      state: 'fine_cut',
      message: '正在精剪',
    })
    mock.listeners[0]?.({
      event: 'video_edit_draft_changed',
      session_id: 'session-1',
      run_id: 'run-1',
      generation: 2,
    })
    await vi.waitFor(() => expect(root.textContent).toContain('正在精剪'), {
      timeout: 200,
    })
  })

  it('can load a conflicted preview and asks before replacing the current timeline', async () => {
    const status = {
      runId: 'run-1',
      state: 'conflict',
      message: '当前工程已有新修改',
      previewPath: 'review/draft.mp4',
      canAdopt: true,
    }
    const confirmReplacement = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    answerConfirmsForTest(confirmReplacement)
    mock.invokeCore.mockResolvedValue(status)
    mock.core.mockImplementation(async (key: string) =>
      key === 'files.mediaUrl'
        ? { url: 'https://example.invalid/preview' }
        : { pending: null },
    )
    await mount()
    expect(mock.core).not.toHaveBeenCalledWith(
      'files.mediaUrl',
      expect.anything(),
    )
    const details = Array.from(root.querySelectorAll('details')).find((item) =>
      item
        .querySelector(':scope > summary')
        ?.textContent?.includes('播放审片预览'),
    )!
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    await Promise.resolve()
    await nextTick()
    await vi.waitFor(() =>
      expect(mock.core).toHaveBeenCalledWith('files.mediaUrl', {
        source: 'project',
        sessionId: 'session-1',
        path: 'review/draft.mp4',
      }),
    )
    expect(root.querySelector('video')?.getAttribute('src')).toBe(
      'https://example.invalid/preview',
    )
    const adopt = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('采用精剪草稿'),
    )!
    adopt.click()
    await Promise.resolve()
    await nextTick()
    expect(mock.invokeCore).not.toHaveBeenCalledWith(
      'videoProject.editRunAction',
      expect.anything(),
    )
    adopt.click()
    await Promise.resolve()
    await nextTick()
    expect(mock.invokeCore).toHaveBeenCalledWith('videoProject.editRunAction', {
      sessionId: 'session-1',
      runId: 'run-1',
      action: 'adopt',
    })
  })

  it('keeps the current timeline by cancelling a conflicted run', async () => {
    mock.invokeCore.mockImplementation(async (key: string) =>
      key === 'videoProject.editRunStatus'
        ? {
            runId: 'run-1',
            state: 'conflict',
            message: '当前工程已有新修改',
            canAdopt: true,
          }
        : { runId: 'run-1', state: 'cancelled', message: '已保留当前时间线' },
    )
    await mount()
    Array.from(root.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '保留当前时间线')
      ?.click()
    await Promise.resolve()
    await nextTick()
    expect(mock.invokeCore).toHaveBeenCalledWith('videoProject.editRunAction', {
      sessionId: 'session-1',
      runId: 'run-1',
      action: 'cancel',
    })
    expect(root.textContent).not.toContain('新建精剪任务')
  })

  it('starts scoped revision from the delivered timeline and keeps manual export', async () => {
    mock.invokeCore.mockImplementation(async (key: string) =>
      key === 'videoProject.editRunStatus'
        ? {
            runId: 'run-1',
            state: 'delivered',
            message: '审片通过',
            canRestore: false,
            canRevise: true,
          }
        : { runId: 'run-2', state: 'analyzing', message: '开始返修' },
    )
    await mount()
    expect(root.textContent).toContain('完成后从工具栏导出')
    expect(root.textContent).not.toContain('局部返修')
    await writeDraft('把第 2 段剪短')
    agentButton('send').click()
    expect(mock.invokeCore).toHaveBeenCalledWith(
      'chat.submit',
      expect.objectContaining({
        sessionId: 'session-1',
        content: '把第 2 段剪短',
      }),
    )
  })

  it('focuses the composer when navigation asks for it', async () => {
    await mount()
    requestEditorAgentFocus('composer')
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(draftInput())
  })
})
