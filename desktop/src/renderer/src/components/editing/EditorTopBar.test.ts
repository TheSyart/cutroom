// @vitest-environment jsdom
import { computed, createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorTopBar from './EditorTopBar.vue'

const mock = vi.hoisted(() => ({
  state: null as any,
  createProject: vi.fn(),
  openFolder: vi.fn(),
  pickWorkspace: vi.fn(),
  openSettings: vi.fn(),
  toggleTheme: vi.fn(),
  openPath: vi.fn(),
  exportVideo: vi.fn(),
  cancelVideoExport: vi.fn(),
}))
vi.mock('./editingStore', () => ({
  useEditingWorkspace: () => ({
    ...mock,
    readOnly: computed(() => mock.state.view === 'draft'),
  }),
}))
vi.mock('../settings/useSettingsRoute', () => ({
  useSettingsRoute: () => ({ openSettings: mock.openSettings }),
}))
vi.mock('../../composables/useTheme', async () => {
  const { ref } = await import('vue')
  const theme = ref('dark')
  return {
    useTheme: () => ({
      theme,
      toggle: () => {
        theme.value = theme.value === 'dark' ? 'light' : 'dark'
        mock.toggleTheme()
      },
    }),
  }
})
vi.mock('../sidebar/SidebarBell.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup: () => () => h('span', { 'data-testid': 'bell' }),
    }),
  }
})
vi.mock('../../api/backend', () => ({
  exportVideo: (...args: unknown[]) => mock.exportVideo(...args),
  cancelVideoExport: (...args: unknown[]) => mock.cancelVideoExport(...args),
  openPath: (...args: unknown[]) => mock.openPath(...args),
}))

let app: App | undefined
let root: HTMLDivElement
beforeEach(() => {
  mock.state = reactive({
    projectPath: '/tmp/edit',
    sessionId: 'session-1',
    project: {
      name: 'Launch film',
      projectId: 'project-1',
      revision: 3,
      clips: [],
    },
  })
  mock.createProject.mockResolvedValue(true)
  mock.openFolder.mockResolvedValue(true)
  mock.pickWorkspace.mockResolvedValue(true)
  mock.openPath.mockResolvedValue(undefined)
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  app?.unmount()
  root.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function mount(props: Record<string, unknown> = {}) {
  const emitted = {
    undo: vi.fn(),
    redo: vi.fn(),
    inspector: vi.fn(),
    toggleAgent: vi.fn(),
    import: vi.fn(),
  }
  app = createApp(EditorTopBar, {
    hasProject: true,
    projectName: 'Launch film',
    saveLabel: '已保存 · r3',
    canUndo: true,
    canRedo: false,
    inspectorOpen: true,
    ...props,
    onUndo: emitted.undo,
    onRedo: emitted.redo,
    onToggleInspector: emitted.inspector,
    onToggleAgent: emitted.toggleAgent,
    onImport: emitted.import,
  })
  app.mount(root)
  await nextTick()
  return emitted
}

describe('editor top bar', () => {
  it('allows export for a motion-only project and disables it for a lost anchor', async () => {
    mock.state.project.motionScenes = [{ id: 'solo' }]
    await mount()
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="editor-export"]',
    )!
    expect(button.disabled).toBe(false)
    mock.state.project.motionScenes[0].anchor = { status: 'lost' }
    await nextTick()
    expect(button.disabled).toBe(true)
  })

  it('keeps project, undo/redo, inspector, Agent, import, theme, settings and notifications', async () => {
    const emitted = await mount()
    expect(root.querySelector('[data-testid="app-brand"]')).toBeNull()
    expect(
      root.querySelector('[data-testid="editor-project-menu"]')?.textContent,
    ).toContain('Launch film')
    expect(root.textContent).toContain('Launch film')
    expect(root.textContent).toContain('已保存 · r3')
    expect(
      root.querySelector('[data-testid="editor-theme-toggle"]'),
    ).not.toBeNull()
    expect(
      root.querySelector('[data-testid="editor-agent-toggle"]'),
    ).not.toBeNull()
    expect(
      root.querySelector('[data-testid="editor-inspector-toggle"]'),
    ).not.toBeNull()
    expect(root.querySelector('[data-testid="bell"]')).not.toBeNull()
    root
      .querySelector<HTMLButtonElement>('[data-testid="editor-agent-toggle"]')!
      .click()
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="editor-inspector-toggle"]',
      )!
      .click()
    await nextTick()
    expect(emitted.toggleAgent).toHaveBeenCalledOnce()
    expect(emitted.inspector).toHaveBeenCalledOnce()
  })

  it('keeps the export, progress and cancellation attached to the originating project and run', async () => {
    let finish!: (result: unknown) => void
    mock.exportVideo.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mock.state.project.clips = [{}]
    await mount()
    const button = () =>
      root.querySelector<HTMLButtonElement>('[data-testid="editor-export"]')!
    const cancel = () =>
      root.querySelector<HTMLButtonElement>(
        '[data-testid="editor-export-cancel"]',
      )
    button().click()
    const [request, progress] = mock.exportVideo.mock.calls[0]!
    expect(request).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: expect.any(String),
      expectedRevision: 3,
    })
    progress(32)
    await nextTick()
    expect(root.textContent).toContain('32%')
    mock.state.project.projectId = 'project-2'
    progress(61)
    await nextTick()
    expect(root.textContent).not.toContain('61%')
    expect(cancel()).toBeNull()
    expect(button().disabled).toBe(true)
    mock.state.project.projectId = 'project-1'
    await nextTick()
    expect(root.textContent).toContain('61%')
    cancel()!.click()
    await nextTick()
    expect(mock.cancelVideoExport).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: request.runId,
        sessionId: request.sessionId,
        projectId: request.projectId,
      }),
    )
    mock.state.project.projectId = 'project-2'
    finish({ kind: 'cancelled' })
    await nextTick()
    await nextTick()
    expect(button().disabled).toBe(false)
    button().click()
    const second = mock.exportVideo.mock.calls[1]!
    expect(second[0].runId).not.toBe(request.runId)
    second[1](20)
    progress(97)
    await nextTick()
    expect(root.textContent).toContain('20%')
    expect(root.textContent).not.toContain('97%')
    finish({ kind: 'done', path: '/tmp/export.mp4', duration: 12, revision: 3 })
    await nextTick()
    await nextTick()
    expect(root.textContent).toContain('MP4 已导出')
  })

  it('labels the Agent button by whether the dock is visible', async () => {
    const emitted = await mount({ agentOpen: false })
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-testid="editor-agent-toggle"]',
    )!
    expect(toggle.getAttribute('aria-label')).toBe('显示 Cutroom Agent')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    await nextTick()
    expect(emitted.toggleAgent).toHaveBeenCalledOnce()
  })

  it('opens the project menu and delegates to the workspace actions', async () => {
    await mount()
    root
      .querySelector<HTMLButtonElement>('[data-testid="editor-project-menu"]')!
      .click()
    await nextTick()
    expect(document.body.textContent).toContain('新建项目')
    expect(document.body.textContent).toContain('打开文件夹')
    expect(document.body.textContent).toContain('切换工作区')
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((element) => element.textContent?.includes('新建项目'))!
    item.click()
    await nextTick()
    expect(mock.createProject).toHaveBeenCalledOnce()
  })

  it('hides project actions on the start page but keeps the project entry and settings', async () => {
    await mount({
      hasProject: false,
      projectName: '',
      saveLabel: '',
      canUndo: false,
      canRedo: false,
    })
    expect(root.querySelector('[data-testid="app-brand"]')).toBeNull()
    expect(
      root.querySelector('[data-testid="editor-project-menu"]')?.textContent,
    ).toContain('新建或打开剪辑')
    expect(root.querySelector('[data-testid="editor-agent-toggle"]')).toBeNull()
    expect(
      root.querySelector('[data-testid="editor-inspector-toggle"]'),
    ).toBeNull()
    expect(root.textContent).not.toContain('导入素材')
    expect(
      root.querySelector('[data-testid="editor-theme-toggle"]'),
    ).not.toBeNull()
  })

  it('toggles the theme and opens settings', async () => {
    await mount()
    root
      .querySelector<HTMLButtonElement>('[data-testid="editor-theme-toggle"]')!
      .click()
    await nextTick()
    expect(mock.toggleTheme).toHaveBeenCalledOnce()
    const settings = [...root.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '设置',
    )!
    settings.click()
    expect(mock.openSettings).toHaveBeenCalledWith('model')
  })
})
