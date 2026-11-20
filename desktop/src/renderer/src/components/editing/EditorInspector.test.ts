// @vitest-environment jsdom
import { computed, createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoProject } from '@emperor/core/editing'
import EditorInspector from './EditorInspector.vue'

const mock = vi.hoisted(() => ({
  state: {} as any,
  mutate: vi.fn(),
  importAssets: vi.fn(),
  selectAsset: vi.fn(),
  selectClip: vi.fn(),
}))
vi.mock('./editingStore', () => ({
  useEditingWorkspace: () => ({
    ...mock,
    readOnly: computed(() => mock.state.view === 'draft'),
    displayProject: computed(() => mock.state.project),
  }),
}))

const project: VideoProject = {
  schemaVersion: 2,
  projectId: 'p',
  name: 'Demo',
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assets: [
    {
      id: 'a1',
      kind: 'video',
      path: 'assets/a.mp4',
      displayName: 'Interview.mp4',
      duration: 8,
      width: 1920,
      height: 1080,
    },
  ],
  tracks: [{ id: 'main', kind: 'video', name: '主画面', index: 0 }],
  subtitles: [],
  clips: [
    {
      id: 'c1',
      trackId: 'main',
      assetId: 'a1',
      timelineStart: 0,
      sourceIn: 1,
      sourceOut: 7,
      speed: 1,
      volume: 0.8,
      muted: false,
      transform: { scale: 1, x: 0, y: 0 },
    },
  ],
  canvas: { fit: 'contain', background: '#000000' },
}

let app: App | undefined
let root: HTMLDivElement
beforeEach(() => {
  mock.state = reactive({
    project: structuredClone(project),
    sessionId: 's1',
    selectedClipId: 'c1',
    selectedSubtitleId: null,
    selectedAssetId: 'a1',
    activeTab: 'clip',
    saving: false,
  })
  mock.mutate.mockResolvedValue(undefined)
  mock.importAssets.mockResolvedValue([])
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})

function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(EditorInspector)
  app.mount(root)
}

describe('editing inspector', () => {
  it('shows only four functional task tabs and no future-feature placeholders', () => {
    mount()
    expect(root.querySelectorAll('[data-inspector-tab]')).toHaveLength(4)
    expect(root.querySelector('[data-inspector-tab="assets"]')).toBeNull()
    expect(root.textContent).toContain('片段 · 第 1 段')
    for (const label of ['导出', '字幕', '动效', '摄像头', '光标', '独立音轨'])
      expect(root.textContent).not.toContain(label)
  })

  it('edits source range through the shared mutation store', async () => {
    mount()
    const input = root.querySelector<HTMLInputElement>(
      '[data-field="source-in"]',
    )!
    input.value = '2'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'trimClip',
      clipId: 'c1',
      edge: 'left',
      sourceIn: 2,
      sourceOut: 7,
    })
  })

  it('offers speed as its own real tab', async () => {
    mount()
    mock.state.activeTab = 'speed'
    await nextTick()
    const speed = root.querySelector<HTMLInputElement>('[data-field="speed"]')
    expect(speed).not.toBeNull()
    expect(root.textContent).toContain('变速后时长')
    expect(root.textContent).not.toContain('动画')
  })

  it('exposes real canvas and original-audio controls', async () => {
    mount()
    mock.state.activeTab = 'canvas'
    await nextTick()
    const scale = root.querySelector<HTMLInputElement>('[data-field="scale"]')!
    scale.value = '1.25'
    scale.dispatchEvent(new Event('change', { bubbles: true }))
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'updateClip',
      clipId: 'c1',
      transform: { scale: 1.25, x: 0, y: 0 },
    })
    mock.state.activeTab = 'audio'
    await nextTick()
    expect(root.querySelector('[data-field="volume"]')).not.toBeNull()
    expect(root.textContent).toContain('原声音量')
  })

  it('explains that image clips have no original audio', async () => {
    mount()
    mock.state.project.assets[0] = {
      ...project.assets[0]!,
      kind: 'image',
      duration: null,
      path: 'assets/a.png',
    }
    mock.state.activeTab = 'audio'
    await nextTick()
    expect(root.textContent).toContain('图片片段无原声')
    expect(root.querySelector('[data-field="volume"]')).toBeNull()
  })

  it('edits the selected subtitle text and timing', async () => {
    mock.state.project.subtitles = [
      { id: 's1', start: 0.5, end: 2, text: '旧字幕' },
    ]
    mock.state.selectedClipId = null
    mock.state.selectedSubtitleId = 's1'
    mock.state.activeTab = 'subtitle'
    mount()
    await nextTick()
    expect(root.querySelector('[data-inspector-tab="subtitle"]')).not.toBeNull()
    const textarea = root.querySelector<HTMLTextAreaElement>(
      '[data-field="subtitle-text"]',
    )!
    expect(textarea.value).toBe('旧字幕')
    textarea.value = '新字幕'
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'updateSubtitle',
      subtitleId: 's1',
      text: '新字幕',
    })
    const start = root.querySelector<HTMLInputElement>(
      '[data-field="subtitle-start"]',
    )!
    start.value = '1'
    start.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'updateSubtitle',
      subtitleId: 's1',
      start: 1,
    })
  })

  it('keeps the clip controls without the old selection handoff button', () => {
    mount()
    expect(root.querySelector('[data-field="source-in"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="send-to-chat"]')).toBeNull()
  })
})
