// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computed, createApp, nextTick, reactive, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorPage from './EditorPage.vue'

const mock = vi.hoisted(() => ({
  state: null as any,
  restore: vi.fn(),
  refreshFromDisk: vi.fn(async () => undefined),
  refreshMotion: vi.fn(async () => undefined),
  refreshDraft: vi.fn(async () => undefined),
  applyAgentFocus: vi.fn(),
  mutate: vi.fn(async () => undefined),
  deleteSelection: vi.fn(async () => undefined),
  togglePlayback: vi.fn(),
  refreshRecentProjects: vi.fn(async () => undefined),
  createProject: vi.fn(),
  openFolder: vi.fn(),
  pickWorkspace: vi.fn(),
  importAssets: vi.fn(),
  updateAssetMetadata: vi.fn(),
}))

vi.mock('./editingStore', () => ({
  useEditingWorkspace: () => ({
    ...mock,
    readOnly: computed(() => mock.state.view === 'draft'),
    canDelete: computed(
      () =>
        Boolean(mock.state.selectedClipId) && !mock.state.selectionProtected,
    ),
    displayProject: computed(() => mock.state.project),
    draftAvailable: computed(() => Boolean(mock.state.draft?.generation)),
  }),
}))
vi.mock('./EditorPreview.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup(_, { expose }) {
        expose({ togglePlayback: mock.togglePlayback })
        return () => h('div', { 'data-testid': 'preview' })
      },
    }),
  }
})
vi.mock('./EditorInspector.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup: () => () => h('div', { 'data-testid': 'inspector' }),
    }),
  }
})
vi.mock('./EditorTimeline.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h('div', { 'data-testid': 'timeline' }, slots.versions?.()),
    }),
  }
})
vi.mock('./EditorAgentDock.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { sessionId: String, projectName: String },
      setup(props) {
        return () =>
          h('div', {
            'data-testid': 'agent-dock',
            'data-session': props.sessionId,
            'data-project': props.projectName,
          })
      },
    }),
  }
})

let app: App | undefined
let root: HTMLDivElement

function viewport(width: number, height = 900): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })
  window.dispatchEvent(new Event('resize'))
}

function openProject(): void {
  mock.state.sessionId = 'session-1'
  mock.state.project = {
    projectId: 'p',
    name: 'Test',
    clips: [],
    assets: [],
    tracks: [],
    subtitles: [],
  }
}

function element(selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  expect(found, selector).not.toBeNull()
  return found!
}

function key(target: EventTarget, key: string, code = key): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  viewport(1440)
  localStorage.clear()
  mock.state = reactive({
    project: null,
    sessionId: '',
    projectPath: '',
    selectedClipId: null,
    selectedAssetId: null,
    activeTab: 'assets',
    playhead: 0,
    seekRevision: 0,
    playing: false,
    loading: false,
    saving: false,
    error: '',
    canUndo: false,
    canRedo: false,
  })
  mock.restore.mockResolvedValue(true)
  mock.createProject.mockResolvedValue(true)
  mock.openFolder.mockResolvedValue(true)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  })
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  app?.unmount()
  root.remove()
  vi.clearAllMocks()
})

async function mount() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/editor', name: 'editor', component: {} }],
  })
  await router.push('/editor')
  app = createApp(EditorPage)
  app.use(router)
  app.mount(root)
  await nextTick()
}

describe('editor page', () => {
  it('shows saved content and a recovery action when migration permits only reading', async () => {
    mock.state.readOnlySnapshot = {
      projectPath: '/readonly',
      readOnlyReason: '新旧目录冲突',
      project: {
        name: '审片',
        revision: 9,
        assets: [{ id: 'a', displayName: '口播', path: 'assets/voice.wav' }],
        clips: [{ id: 'c', trackId: 'main', timelineStart: 0, assetId: 'a' }],
        subtitles: [{ id: 't', start: 0, text: '已有字幕' }],
      },
    }
    await mount()
    expect(root.textContent).toContain('审片 · 只读查看')
    expect(root.textContent).toContain('已有字幕')
    expect(root.textContent).toContain('重新打开')
    expect(root.querySelector('[data-testid="agent-dock"]')).toBeNull()
  })
  it('shows the two initial project choices and no Agent dock without a project', async () => {
    await mount()
    expect(root.querySelector('[data-testid="new-project"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="open-folder"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="agent-dock"]')).toBeNull()
    expect(root.querySelector('.sidebar-root')).toBeNull()
    expect(root.querySelector('.editor-tool-rail')).toBeNull()
    expect(root.querySelector('[data-testid="app-brand"]')).toBeNull()
    expect(
      root.querySelector('[data-testid="editor-project-menu"]'),
    ).not.toBeNull()
    expect(root.textContent).toContain('剪辑工作台')
  })

  it('handles project events and suppresses destructive shortcuts with a dialog open', async () => {
    let listener!: (event: unknown) => void
    Object.defineProperty(window, 'emperor', {
      configurable: true,
      value: {
        onCoreEvent: (callback: typeof listener) => {
          listener = callback
          return () => {}
        },
      },
    })
    mock.state.sessionId = 'session-1'
    mock.state.project = {
      projectId: 'p',
      name: 'test',
      clips: [],
      assets: [],
      tracks: [],
      subtitles: [],
    }
    mock.state.selectedClipId = 'clip'
    await mount()
    listener({ event: 'video_project_changed', session_id: 'other' })
    expect(mock.refreshFromDisk).not.toHaveBeenCalled()
    listener({ event: 'video_project_changed', session_id: 'session-1' })
    expect(mock.refreshFromDisk).toHaveBeenCalledWith('session-1')
    listener({
      event: 'video_project_focus',
      session_id: 'session-1',
      clipId: 'clip',
    })
    expect(mock.applyAgentFocus).toHaveBeenCalledWith({ clipId: 'clip' })
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    root.append(modal)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(mock.mutate).not.toHaveBeenCalled()
    modal.remove()
    delete (window as unknown as Record<string, unknown>).emperor
  })

  it('calls create and open separately', async () => {
    await mount()
    root
      .querySelector<HTMLButtonElement>('[data-testid="new-project"]')!
      .click()
    root
      .querySelector<HTMLButtonElement>('[data-testid="open-folder"]')!
      .click()
    expect(mock.createProject).toHaveBeenCalledOnce()
    expect(mock.openFolder).toHaveBeenCalledOnce()
  })

  it('shows source coverage and loads draft changes while showing project parameters', async () => {
    let listener!: (event: unknown) => void
    Object.defineProperty(window, 'emperor', {
      configurable: true,
      value: {
        onCoreEvent: (callback: typeof listener) => {
          listener = callback
          return () => {}
        },
      },
    })
    try {
      mock.state.sessionId = 'session-1'
      mock.state.project = {
        projectId: 'p',
        name: 'test',
        clips: [],
        assets: [],
        tracks: [],
        subtitles: [],
      }
      mock.state.draft = {
        runId: 'run-1',
        generation: 0,
        state: 'analyzing',
        coverage: {
          source: [
            {
              assetId: 'asset-1',
              name: 'demo.mp4',
              duration: 60,
              readSeconds: 3,
              unread: [{ start: 10, end: 12 }],
            },
          ],
        },
      }
      await mount()
      expect(mock.refreshDraft).toHaveBeenCalledOnce()
      root.querySelector<HTMLButtonElement>('#editor-properties-tab')!.click()
      await nextTick()
      expect(
        root.querySelector<HTMLElement>('#editor-chat-panel')?.style.display,
      ).toBe('none')
      await vi.waitFor(() =>
        expect(
          root.querySelector('#editor-chat-panel [data-testid="agent-dock"]'),
        ).not.toBeNull(),
      )
      expect(
        root.querySelector(
          '[data-testid="editor-timeline-region"] [data-testid="editor-draft-coverage"]',
        ),
      ).not.toBeNull()
      expect(root.querySelector('[data-testid="editor-draft-view"]')).toBeNull()
      const coverage = root.querySelector(
        '[data-testid="editor-draft-coverage"]',
      )
      expect(coverage?.querySelector('summary')?.textContent).toContain(
        '素材已读 60%',
      )
      expect(coverage?.querySelector('li')?.textContent).toContain(
        '00:10.00–00:12.00',
      )
      listener({
        event: 'video_edit_draft_changed',
        session_id: 'second-session',
        run_id: 'other',
        generation: 9,
      })
      expect(mock.refreshDraft).toHaveBeenCalledOnce()
      listener({
        event: 'video_edit_draft_changed',
        session_id: 'session-1',
        run_id: 'run-1',
        generation: 1,
      })
      expect(mock.refreshDraft).toHaveBeenLastCalledWith('session-1', {
        runId: 'run-1',
        generation: 1,
      })
    } finally {
      delete (window as unknown as Record<string, unknown>).emperor
    }
  })

  it('docks the Agent alongside the preview and timeline, retaining the dock when hidden', async () => {
    openProject()
    await mount()
    const body = element('.editor-body')
    expect(body.dataset.layout).toBe('wide')
    expect(body.style.getPropertyValue('--editor-library-width')).toBe('260px')
    expect(body.style.getPropertyValue('--editor-side-width')).toBe('400px')
    expect(
      element('.editor-stage').contains(
        element('[data-testid="editor-timeline-region"]'),
      ),
    ).toBe(true)
    expect(element('#editor-side-panel').parentElement).toBe(body)
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="agent-dock"]')).not.toBeNull(),
    )
    const dock = element('[data-testid="agent-dock"]')
    dock.scrollTop = 75
    const toggle = element('[data-testid="editor-agent-toggle"]')
    toggle.click()
    await nextTick()
    expect(element('#editor-side-panel').style.display).toBe('none')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    await nextTick()
    element('#editor-properties-tab').click()
    await nextTick()
    element('#editor-chat-tab').click()
    await nextTick()
    expect(element('[data-testid="agent-dock"]')).toBe(dock)
    expect(dock.scrollTop).toBe(75)
  })

  it('restores preferred sizes after shrinking and persists manual sizing and dock choices', async () => {
    openProject()
    await mount()
    key(element('.left-resizer'), 'ArrowRight')
    key(element('.right-resizer'), 'End')
    key(element('.horizontal-resizer'), 'End')
    await nextTick()
    const original = [
      '.left-resizer',
      '.right-resizer',
      '.horizontal-resizer',
    ].map((selector) => element(selector).getAttribute('aria-valuenow'))
    viewport(950, 510)
    await nextTick()
    expect(element('.editor-body').dataset.layout).toBe('compact')
    expect(
      Number(element('.right-resizer').getAttribute('aria-valuenow')),
    ).toBeLessThan(Number(original[1]))
    expect(
      Number(element('.horizontal-resizer').getAttribute('aria-valuenow')),
    ).toBeLessThan(Number(original[2]))
    expect(element('#editor-assets-panel').style.display).toBe('none')
    viewport(1440, 900)
    await nextTick()
    expect(
      ['.left-resizer', '.right-resizer', '.horizontal-resizer'].map(
        (selector) => element(selector).getAttribute('aria-valuenow'),
      ),
    ).toEqual(original)
    element('[data-testid="editor-assets-toggle"]').click()
    element('[data-testid="editor-agent-toggle"]').click()
    await nextTick()
    app!.unmount()
    await mount()
    expect(element('#editor-assets-panel').style.display).toBe('none')
    expect(element('#editor-side-panel').style.display).toBe('none')
    element('[data-testid="editor-agent-toggle"]').click()
    element('[data-testid="editor-assets-toggle"]').click()
    await nextTick()
    expect(
      ['.left-resizer', '.right-resizer', '.horizontal-resizer'].map(
        (selector) => element(selector).getAttribute('aria-valuenow'),
      ),
    ).toEqual(original)
  })

  it('closes a narrow drawer with Escape from inside an input and restores the opener', async () => {
    viewport(899)
    openProject()
    await mount()
    const assets = element('[data-testid="editor-assets-toggle"]')
    const agent = element('[data-testid="editor-agent-toggle"]')
    expect(element('.editor-body').dataset.layout).toBe('narrow')
    expect(element('#editor-side-panel').style.display).toBe('none')
    agent.click()
    await nextTick()
    expect(element('#editor-side-panel').style.display).not.toBe('none')
    assets.click()
    await nextTick()
    expect(element('#editor-side-panel').style.display).toBe('none')
    expect(element('.timeline-column').hasAttribute('inert')).toBe(true)
    const input = element('#editor-assets-panel input')
    input.focus()
    expect(key(input, 'Escape').defaultPrevented).toBe(true)
    await nextTick()
    expect(element('#editor-assets-panel').style.display).toBe('none')
    expect(document.activeElement).toBe(assets)
    expect(element('.timeline-column').hasAttribute('inert')).toBe(false)
    agent.click()
    await nextTick()
    key(element('#editor-chat-tab'), 'Escape')
    await nextTick()
    expect(document.activeElement).toBe(agent)
    viewport(900)
    await nextTick()
    expect(element('.editor-body').dataset.layout).toBe('compact')
    expect(element('#editor-side-panel').style.display).not.toBe('none')
    viewport(1200)
    await nextTick()
    expect(element('.editor-body').dataset.layout).toBe('wide')
    expect(element('#editor-assets-panel').style.display).not.toBe('none')
  })

  it('reserves Space for focused controls and plays from preview and timeline backgrounds', async () => {
    openProject()
    await mount()
    const container = element('.monitor-panel')
    for (const markup of [
      '<button><span>按钮</span></button>',
      '<div role="switch"><span>开关</span></div>',
      '<a href="#">链接</a>',
      '<summary>选项</summary>',
      '<input type="range">',
      '<div contenteditable="true"><span>草稿</span></div>',
      '<div role="menuitem">菜单项</div>',
      '<div tabindex="0">自定义控件</div>',
    ]) {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = markup
      container.append(wrapper)
      expect(
        key(
          wrapper.querySelector('span') ?? wrapper.firstElementChild!,
          ' ',
          'Space',
        ).defaultPrevented,
        markup,
      ).toBe(false)
      wrapper.remove()
    }
    expect(
      key(element('.horizontal-resizer'), ' ', 'Space').defaultPrevented,
    ).toBe(false)
    expect(mock.togglePlayback).not.toHaveBeenCalled()
    expect(key(container, ' ', 'Space').defaultPrevented).toBe(true)
    expect(
      key(element('.timeline-column'), ' ', 'Space').defaultPrevented,
    ).toBe(true)
    expect(mock.togglePlayback).toHaveBeenCalledTimes(2)
  })

  it('delegates deletion of the current selection to the workspace', async () => {
    openProject()
    mock.state.selectedClipId = 'clip'
    await mount()
    expect(key(element('.timeline-column'), 'Delete').defaultPrevented).toBe(
      true,
    )
    expect(mock.deleteSelection).toHaveBeenCalledOnce()
    element('.timeline-column').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
        repeat: true,
      }),
    )
    expect(mock.deleteSelection).toHaveBeenCalledOnce()
    mock.state.selectionProtected = true
    expect(key(element('.timeline-column'), 'Backspace').defaultPrevented).toBe(
      false,
    )
    expect(mock.deleteSelection).toHaveBeenCalledOnce()
    expect(mock.mutate).not.toHaveBeenCalled()
  })

  it('lazy-loads the bound Agent dock only inside the project workspace', () => {
    const source = readFileSync(join(__dirname, 'EditorPage.vue'), 'utf8')
    expect(source).toContain('defineAsyncComponent')
    expect(source).toContain("import('./EditorAgentDock.vue')")
    expect(source).toContain('editor-chat-panel')
    expect(source).toContain(':session-id="workspace.state.sessionId"')
  })

  it('keeps a recoverable initial error visible', async () => {
    mock.state.error = '这个文件夹还没有剪辑工程。'
    await mount()
    expect(root.textContent).toContain('这个文件夹还没有剪辑工程。')
  })
})
