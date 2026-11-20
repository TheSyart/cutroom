// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { MotionScene } from '@emperor/core/editing'
import MotionImage from './MotionImage.vue'

const render = vi.hoisted(() => vi.fn())
vi.mock('./motionFrame', () => ({ renderMotionFrame: render }))
const scene: MotionScene = {
  id: 'flow',
  version: 1,
  name: 'flow',
  story: '',
  mode: 'fullscreen',
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 240,
  objects: [],
}
let app: App<Element> | undefined
afterEach(() => {
  app?.unmount()
  vi.unstubAllGlobals()
  render.mockReset()
})

it('coalesces rapid frame requests and discards an obsolete render after a seek or version change', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++next, cb)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      decode = async () => {}
    },
  )
  const runFrame = () => {
    const current = [...frames.values()]
    frames.clear()
    current.forEach((cb) => cb(0))
  }
  const wait = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()
  }
  let finish!: (url: string) => void
  render.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const frame = ref(0),
    rev = ref(0),
    seq = ref(1)
  const root = document.createElement('div')
  app = createApp({
    render: () =>
      h(MotionImage, {
        scene,
        frame: frame.value,
        width: 320,
        seq: seq.value,
        seekRevision: rev.value,
      }),
  })
  app.mount(root)
  runFrame()
  expect(render).toHaveBeenCalledTimes(1)
  frame.value = 5
  rev.value++
  seq.value = 2
  await nextTick()
  frame.value = 10
  await nextTick()
  finish('old')
  await wait()
  expect(root.querySelector('img')).toBeNull()
  runFrame()
  expect(render).toHaveBeenLastCalledWith(scene, 10, 320)
  finish('current')
  await wait()
  expect(root.querySelector('img')?.getAttribute('src')).toBe('current')
  expect(root.querySelector('img')?.dataset.motionFrame).toBe('10')
  expect(render).toHaveBeenCalledTimes(2)
})
