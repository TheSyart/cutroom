// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { VideoProjectResult } from '@emperor/core/editing'
import EditorTimeline from './EditorTimeline.vue'
import { createEditingWorkspace, type EditingWorkspace } from './editingStore'

let workspace: EditingWorkspace
vi.mock('./editingStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editingStore')>()),
  useEditingWorkspace: () => workspace,
}))
vi.mock('./MotionImage.vue', () => ({ default: { render: () => null } }))
vi.mock('./SubtitleGenerateDialog.vue', () => ({
  default: { render: () => null },
}))
let app: App<Element> | undefined
afterEach(() => {
  app?.unmount()
  document.body.replaceChildren()
})

const source: VideoProjectResult = {
  sessionId: 's',
  projectPath: '/tmp/edit',
  canRedo: false,
  canUndo: true,
  project: {
    schemaVersion: 2,
    projectId: 'p',
    name: '请求',
    revision: 1,
    createdAt: '2026-11-20T02:00:00Z',
    updatedAt: '2026-11-20T02:00:00Z',
    assets: [],
    clips: [],
    subtitles: [],
    tracks: [],
    canvas: { fit: 'contain', background: '#000000' },
    motionScenes: [
      {
        id: 'flow',
        name: '调用',
        mode: 'overlay',
        startFrame: 0,
        sourceInFrame: 0,
        durationFrames: 240,
        version: 3,
        story: '',
        objects: [
          {
            id: 'arrow',
            name: '返回箭头',
            draw: '',
            html: '',
            bounds: { x: 0, y: 0, width: 20, height: 30 },
            markers: [{ frame: 46, label: '收到返回' }],
          },
        ],
      },
    ],
  },
}
async function mountTimeline(input = structuredClone(source)) {
  const calls = vi.fn(async () => input)
  workspace = createEditingWorkspace({
    core: calls as never,
    confirm: vi.fn(),
    selectDirectory: vi.fn(),
    selectMediaFiles: vi.fn(),
  })
  await workspace.openProject({ sessionId: 's' })
  const root = document.createElement('div')
  document.body.append(root)
  const reference = vi.fn()
  app = createApp(EditorTimeline, { onAddReference: reference })
  app.mount(root)
  await nextTick()
  return { root, reference, calls }
}

it('opens scene objects in a motion-only timeline and sends a right-clicked marker to the Agent', async () => {
  const { root, reference, calls } = await mountTimeline()
  expect(root.querySelector('.timeline-title')?.textContent).toContain(
    '1 幕动效',
  )
  expect(root.querySelector('.timeline-empty')).toBeNull()
  expect(root.querySelector('[data-motion-object]')).toBeNull()
  root.querySelector<HTMLButtonElement>('[data-motion-expand="flow"]')!.click()
  await nextTick()
  expect(root.querySelector('[aria-label="选择锚点片段"]')).toBeNull()
  const marker = root.querySelector<HTMLButtonElement>(
    '[data-motion-marker="46"]',
  )!
  marker.click()
  expect(workspace.state.playhead).toBe(46 / 30)
  expect(workspace.state.selectedMotionObjectId).toBe('arrow')
  await nextTick()
  expect(marker.getAttribute('aria-pressed')).toBe('true')
  const del = root.querySelector<HTMLButtonElement>(
    '[data-testid=timeline-delete-selection]',
  )!
  expect(del.disabled).toBe(true)
  del.click()
  await workspace.deleteSelection()
  expect(calls).toHaveBeenCalledTimes(1)
  marker.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 10,
    }),
  )
  await nextTick()
  document
    .querySelector<HTMLButtonElement>('[data-testid=timeline-add-reference]')!
    .click()
  expect(reference).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'timeline',
      label: expect.stringContaining('收到返回'),
      timeline: expect.objectContaining({
        target: {
          kind: 'motion',
          id: 'flow',
          objectId: 'arrow',
          markerFrame: 46,
        },
        sceneVersion: 3,
      }),
    }),
  )
})

it('resets anchor choices on scene changes, locates before binding, and maps a sped-up occurrence at the current playhead', async () => {
  const input = structuredClone(source)
  const first = input.project.motionScenes![0]!
  first.anchor = { clipId: 'a', sourceTime: 3 }
  const lost = {
    ...first,
    id: 'lost',
    name: '另一幕',
    anchor: { clipId: 'gone', sourceTime: 11, status: 'lost' as const },
  }
  input.project.motionScenes!.push(lost)
  input.project.tracks = [
    { id: 'main', name: '主画面', index: 0, kind: 'video' },
  ]
  const clip = {
    id: 'a',
    assetId: 'v',
    trackId: 'main',
    timelineStart: 0,
    speed: 1,
    sourceIn: 2,
    sourceOut: 4,
    volume: 1,
    muted: false,
    transform: { scale: 1, x: 0, y: 0 },
  }
  input.project.clips = [
    clip,
    {
      ...clip,
      id: 'b',
      timelineStart: 4,
      sourceIn: 10,
      sourceOut: 14,
      speed: 2,
    },
  ]
  const { root, calls } = await mountTimeline(input)
  root.querySelector<HTMLButtonElement>('[data-motion-expand="flow"]')!.click()
  await nextTick()
  const choose = () =>
    root.querySelector<HTMLButtonElement>('[aria-label="选择锚点片段"]')!
  async function selectSecondClip() {
    choose().click()
    await nextTick()
    document.body
      .querySelector<HTMLButtonElement>('[role=menuitem][data-value=b]')!
      .click()
    await nextTick()
  }
  const bind = () =>
    root.querySelector<HTMLButtonElement>('[data-testid=motion-bind]')!
  expect(choose().textContent).toContain('00:00.00')
  expect(root.querySelector('.anchor-controls')!.textContent).toContain(
    '00:03.00',
  )
  await selectSecondClip()
  await nextTick()
  expect(bind().disabled).toBe(true)
  root.querySelector<HTMLButtonElement>('[data-motion-expand="lost"]')!.click()
  await nextTick()
  expect(choose().textContent).toContain('选择片段')
  expect(root.querySelector('.anchor-controls')!.textContent).toContain(
    '需重新绑定',
  )
  await selectSecondClip()
  workspace.setPlayhead(6)
  await nextTick()
  expect(bind().disabled).toBe(true)
  root
    .querySelector<HTMLButtonElement>('[data-testid=motion-locate-clip]')!
    .click()
  await nextTick()
  expect(workspace.state.playhead).toBe(4)
  expect(calls).toHaveBeenCalledTimes(1)
  workspace.setPlayhead(5.25)
  await nextTick()
  expect(bind().disabled).toBe(false)
  expect(root.querySelector('.anchor-controls')!.textContent).toContain(
    '00:12.50',
  )
  bind().click()
  await vi.waitFor(() =>
    expect(calls).toHaveBeenCalledWith('videoProject.mutate', {
      sessionId: 's',
      expectedRevision: 1,
      command: {
        type: 'setMotionAnchor',
        sceneId: 'lost',
        expectedVersion: 3,
        anchor: { clipId: 'b', sourceTime: 12.5 },
      },
    }),
  )
  workspace.selectClip('a')
  await nextTick()
  expect(root.querySelector('.anchor-controls')).toBeNull()
})
