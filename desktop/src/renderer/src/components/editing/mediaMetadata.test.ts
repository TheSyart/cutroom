// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoAsset } from '@emperor/core/editing'
import { readLocalMediaMetadata } from './mediaMetadata'

const mock = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core: mock.core }))

const asset: VideoAsset = {
  id: 'image-1',
  kind: 'image',
  path: 'assets/image.png',
  displayName: 'image.png',
  duration: null,
  width: null,
  height: null,
}

afterEach(() => vi.restoreAllMocks())

describe('local media metadata', () => {
  it('captures image dimensions before releasing the granted source', async () => {
    mock.core.mockResolvedValue({ url: 'app://workspace-media/granted' })
    const image = document.createElement('img')
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) =>
      tag === 'img' ? image : create(tag, options),
    )
    // Chromium clears intrinsic dimensions when src is removed. Model that
    // behavior so the cleanup ordering cannot regress unnoticed.
    vi.spyOn(image, 'naturalWidth', 'get').mockImplementation(() =>
      image.hasAttribute('src') ? 360 : 0,
    )
    vi.spyOn(image, 'naturalHeight', 'get').mockImplementation(() =>
      image.hasAttribute('src') ? 468 : 0,
    )

    const pending = readLocalMediaMetadata('session-1', asset)
    await vi.waitFor(() => expect(image.hasAttribute('src')).toBe(true))
    image.dispatchEvent(new Event('load'))
    await expect(pending).resolves.toEqual({
      duration: null,
      width: 360,
      height: 468,
    })
    expect(image.hasAttribute('src')).toBe(false)
  })
})

it('imports audio duration without requiring picture dimensions', async () => {
  mock.core.mockResolvedValue({ url: 'app://workspace-media/audio' })
  const audio = document.createElement('video')
  vi.spyOn(audio, 'load').mockImplementation(() => {})
  vi.spyOn(audio, 'duration', 'get').mockReturnValue(4.5)
  const original = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) =>
    tag === 'video' ? audio : original(tag, options),
  )
  const result = readLocalMediaMetadata('session-1', {
    ...asset,
    kind: 'audio',
    path: 'assets/voice.wav',
  })
  await vi.waitFor(() => expect(audio.hasAttribute('src')).toBe(true))
  audio.dispatchEvent(new Event('loadedmetadata'))
  await expect(result).resolves.toEqual({
    duration: 4.5,
    width: null,
    height: null,
  })
})
