import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findExecutable } from './analysis/paths'
import { EditingMediaCache } from './media-cache'
import { PreviewMediaCache } from './preview-media'

const ffmpeg = findExecutable('ffmpeg')

it.skipIf(!ffmpeg)(
  'renders the cited source frame and keeps different trim points in separate cached posters',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'cutroom-cited-frame-')),
    )
    const run = (...args: string[]) =>
      execFileSync(ffmpeg!, ['-nostdin', '-v', 'error', ...args])
    try {
      const asset = {
        kind: 'video' as const,
        id: 'v',
        displayName: 'fixture',
        path: 'two-colors.mp4',
        duration: 2,
        width: 48,
        height: 32,
      }
      run(
        '-f',
        'lavfi',
        '-i',
        'color=red:s=48x32:r=10:d=1',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=48x32:r=10:d=1',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0',
        '-c:v',
        'libx264',
        join(root, asset.path),
      )
      const cache = new PreviewMediaCache(
        new EditingMediaCache('fixture', join(root, 'test-cache')),
      )
      const poster = (time: number) =>
        cache.prepare(root, asset, ffmpeg, 'poster', false, time)
      const first = await poster(0)
      const second = await poster(1.2)
      expect(second.path).not.toBe(first.path)
      expect((await poster(1.2)).path).toBe(second.path)
      const rgb = (path: string) =>
        run(
          '-i',
          path,
          '-vf',
          'scale=1:1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        )
      const [r0, , b0] = rgb(first.path)
      const [r1, , b1] = rgb(second.path)
      expect(r0!).toBeGreaterThan(b0! + 150)
      expect(b1!).toBeGreaterThan(r1! + 150)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(!ffmpeg)(
  'produces a waveform image for a cited audio excerpt',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'cutroom-cited-audio-')),
    )
    try {
      const asset = {
        id: 'voice',
        kind: 'audio' as const,
        displayName: 'Voice',
        path: 'voice.wav',
        duration: 1,
        width: null,
        height: null,
      }
      execFileSync(ffmpeg!, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        join(root, asset.path),
      ])
      const preview = await new PreviewMediaCache(
        new EditingMediaCache('fixture', join(root, 'test-cache')),
      ).prepare(root, asset, ffmpeg, 'poster', false, 0.1, 0.4)
      const rgb = execFileSync(ffmpeg!, [
        '-v',
        'error',
        '-i',
        preview.path,
        '-pix_fmt',
        'gray',
        '-f',
        'rawvideo',
        'pipe:1',
      ])
      expect(rgb).toHaveLength(180 * 64)
      expect(rgb.some((value) => value > 85)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
