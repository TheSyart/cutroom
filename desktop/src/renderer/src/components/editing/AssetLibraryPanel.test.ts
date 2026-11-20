// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computed, createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssetLibraryPanel from './AssetLibraryPanel.vue'

const mock = vi.hoisted(() => ({
  state: null as any,
  mutate: vi.fn(),
  selectAsset: vi.fn(),
}))
vi.mock('./editingStore', () => ({
  useEditingWorkspace: () => ({
    ...mock,
    readOnly: computed(() => mock.state.view === 'draft'),
    displayProject: computed(() => mock.state.project),
    displayMissingAssetIds: computed(() => mock.state.missingAssetIds ?? []),
  }),
}))
vi.mock('./AssetThumbnail.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { asset: { type: Object, required: true } },
      setup(props) {
        return () =>
          h('span', { 'data-thumb': (props.asset as { id: string }).id })
      },
    }),
  }
})

let app: App | undefined
let root: HTMLDivElement
beforeEach(() => {
  mock.state = reactive({
    project: {
      assets: [
        {
          id: 'a1',
          kind: 'video',
          path: 'assets/a1.mp4',
          displayName: 'interview.mp4',
          duration: 5,
          width: 1920,
          height: 1080,
        },
        {
          id: 'a2',
          kind: 'image',
          path: 'assets/a2.png',
          displayName: 'storyboard.png',
          duration: null,
          width: 360,
          height: 468,
        },
      ],
      clips: [],
    },
    sessionId: 'session-1',
    selectedAssetId: 'a1',
    missingAssetIds: [],
    metadataErrors: {},
  })
  mock.mutate.mockResolvedValue(undefined)
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  app?.unmount()
  root.remove()
  vi.clearAllMocks()
})

async function mount(importMedia = vi.fn()) {
  app = createApp(AssetLibraryPanel, { onImport: importMedia })
  app.mount(root)
  await nextTick()
  return importMedia
}

describe('asset library panel', () => {
  it('shows only real filters and real thumbnails', async () => {
    await mount()
    expect(root.textContent).toContain('全部')
    expect(root.textContent).toContain('视频')
    expect(root.textContent).toContain('图片')
    expect(root.textContent).toContain('音频')
    for (const unsupported of [
      '文本',
      '贴纸',
      '特效',
      '转场',
      '字幕',
      '滤镜',
      '模板',
    ])
      expect(root.textContent).not.toContain(unsupported)
    expect(root.querySelectorAll('[data-thumb]')).toHaveLength(2)
  })

  it('filters by name and kind', async () => {
    await mount()
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'story'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelectorAll('.asset-card')).toHaveLength(1)
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const image = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '图片',
    )!
    image.click()
    await nextTick()
    expect(root.querySelectorAll('.asset-card')).toHaveLength(1)
    expect(root.textContent).toContain('storyboard.png')
  })

  it('selects, double-clicks to append, and uses the add button', async () => {
    await mount()
    const video = root.querySelector<HTMLButtonElement>('.asset-card')!
    video.click()
    expect(mock.selectAsset).toHaveBeenCalledWith('a1')
    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    expect(mock.mutate).toHaveBeenCalledWith({ type: 'addClip', assetId: 'a1' })
    mock.mutate.mockClear()
    const add = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('添加到时间线'),
    )!
    add.click()
    await nextTick()
    expect(mock.mutate).toHaveBeenCalledWith({ type: 'addClip', assetId: 'a1' })
  })

  it('keeps implicit asset-grid rows content-sized for large projects', () => {
    // jsdom cannot lay out the grid; this guards the real 60-asset layout where
    // `auto` implicit rows collapsed to ~5px inside the definite-height panel.
    const source = readFileSync(
      join(
        process.cwd(),
        'src/renderer/src/components/editing/AssetLibraryPanel.vue',
      ),
      'utf8',
    )
    expect(source).toMatch(
      /\.asset-grid\s*\{[^}]*grid-auto-rows:\s*max-content/,
    )
  })

  it('imports from the empty state and from the header', async () => {
    mock.state.project.assets = []
    const importMedia = await mount()
    const buttons = [...root.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('导入'),
    )
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    buttons[0]!.click()
    expect(importMedia).toHaveBeenCalledOnce()
  })
})
