import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVideoSequence } from './video-sequence'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function temporaryFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'video-sequence-test-'))
  roots.push(root)
  return join(root, name)
}

function ffmpeg(args: string[], input?: Buffer): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', ...args], {
    input,
    maxBuffer: 8_000_000,
  })
}

function pixels(jpeg: Buffer): { width: number; height: number; rgb: Buffer } {
  const ppm = ffmpeg(
    [
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-c:v',
      'ppm',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    jpeg,
  )
  const dimensions = ppm.indexOf('\n', 3)
  const [width, height] = ppm
    .toString('ascii', 3, dimensions)
    .split(' ')
    .map(Number)
  return { width: width!, height: height!, rgb: ppm.subarray(dimensions + 5) }
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

describe.skipIf(!hasFfmpeg)('ordered local video frames', () => {
  it('shows both sides of a brief scene between the default cadence frames', async () => {
    const path = temporaryFile('flash.mkv')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=black:s=160x90:r=25:d=1.04,drawbox=c=white:t=fill:enable=between(t\\,0.12\\,0.16)',
      '-c:v',
      'ffv1',
      path,
    ])
    const { sheets } = await readVideoSequence({
      ffmpegPath: 'ffmpeg',
      path,
      start: 0,
      end: 1.04,
      fps: 2,
    })
    const [sheet] = sheets
    expect(sheets).toHaveLength(1)
    expect(sheet!.time).toBe(0)
    expect(sheet!.times).toEqual([0, 0.08, 0.12, 0.16, 0.2, 0.52, 1])

    const { width, height, rgb } = pixels(sheet!.bytes)
    expect(width).toBeLessThanOrEqual(1600)
    expect(height).toBeLessThanOrEqual(1600)
    const cell = (index: number) => {
      const x = Math.floor(
        (((index % sheet!.columns) + 0.5) * width) / sheet!.columns,
      )
      const y = Math.floor(
        ((Math.floor(index / sheet!.columns) + 0.5) * height) / sheet!.rows,
      )
      return rgb[(y * width + x) * 3]!
    }
    expect(cell(1)).toBeLessThan(16)
    expect(cell(2)).toBeGreaterThan(240)
    expect(cell(3)).toBeGreaterThan(240)
    expect(cell(4)).toBeLessThan(16)
  })

  it('retains actual portrait VFR timestamps on adjacent half-open pages', async () => {
    const path = temporaryFile('vfr.mkv')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=48x80:r=25:d=0.8',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:d=1.2',
      '-vf',
      "select='eq(n,0)+eq(n,1)+eq(n,3)+eq(n,8)+eq(n,12)+eq(n,16)+eq(n,19)',setpts=PTS+0.16/TB",
      '-fps_mode',
      'vfr',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_s16le',
      path,
    ])
    const options = { ffmpegPath: 'ffmpeg', path, fps: 8 as const }
    const first = await readVideoSequence({ ...options, start: 0, end: 0.48 })
    const second = await readVideoSequence({
      ...options,
      start: first.end,
      end: 1.2,
    })
    expect(first.sheets.flatMap((sheet) => sheet.times)).toEqual([0.16, 0.28])
    expect(second.sheets.flatMap((sheet) => sheet.times)).toEqual([
      0.48, 0.64, 0.8, 0.92,
    ])
    const { width, height } = pixels(second.sheets[0]!.bytes)
    expect(height / second.sheets[0]!.rows).toBeGreaterThan(
      width / second.sheets[0]!.columns,
    )
    expect(
      await readVideoSequence({ ...options, start: 0.96, end: 1.2 }),
    ).toEqual({ sheets: [], start: 0.96, end: 1.2 })
  })

  it('bounds dimensions and attachments for a full default page', async () => {
    const path = temporaryFile('full.mkv')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=320x180:r=30:d=8',
      '-c:v',
      'ffv1',
      path,
    ])
    const { sheets } = await readVideoSequence({
      ffmpegPath: 'ffmpeg',
      path,
      start: 0,
      end: 8,
      fps: 2,
    })
    const times = sheets.flatMap((sheet) => sheet.times)
    expect(sheets.length).toBeLessThanOrEqual(2)
    expect(times).toHaveLength(17)
    expect(times.slice(0, -1)).toEqual(
      Array.from({ length: 16 }, (_, index) => index / 2),
    )
    expect(times.at(-1)).toBeCloseTo(7.967, 3)
    for (const sheet of sheets) {
      const { width, height } = pixels(sheet.bytes)
      expect(width).toBeLessThanOrEqual(1600)
      expect(height).toBeLessThanOrEqual(1600)
      expect(sheet.columns * sheet.rows).toBeGreaterThanOrEqual(
        sheet.times.length,
      )
    }
  })

  it('rejects corrupt input as a media error', async () => {
    const path = temporaryFile('bad.mkv')
    writeFileSync(path, 'invalid video')
    await expect(
      readVideoSequence({
        ffmpegPath: 'ffmpeg',
        path,
        start: 0,
        end: 1,
        fps: 2,
      }),
    ).rejects.toMatchObject({ code: 'media_check_failed' })
  })

  it.skipIf(process.platform === 'win32')(
    'cancels the decoder while it is reading video',
    async () => {
      const path = temporaryFile('slow.mkv')
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=64x32:r=25:d=4',
        '-c:v',
        'ffv1',
        path,
      ])
      const ffmpegPath = temporaryFile('ffmpeg')
      writeFileSync(ffmpegPath, '#!/bin/sh\nexec ffmpeg -re "$@"\n', {
        mode: 0o755,
      })
      const controller = new AbortController()
      const pending = readVideoSequence({
        ffmpegPath,
        path,
        start: 0,
        end: 4,
        fps: 2,
        signal: controller.signal,
      })
      const timer = setTimeout(() => controller.abort(), 100)
      try {
        await expect(pending).rejects.toMatchObject({
          code: 'analysis_cancelled',
        })
      } finally {
        clearTimeout(timer)
      }
    },
  )
})

it('cancels video scanning before the decoder starts', async () => {
  await expect(
    readVideoSequence({
      ffmpegPath: '/missing/ffmpeg',
      path: '/missing/input.mp4',
      start: 0,
      end: 1,
      fps: 2,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ code: 'analysis_cancelled' })
})
