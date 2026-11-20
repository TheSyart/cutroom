import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VideoClip } from '../types'
import {
  buildSubtitleCues,
  segmentsForClip,
  splitTranscriptSegment,
} from './captions'
import { parseWhisperEvidence } from './evidence'
import { AnalysisConfigStore } from './config'
import { downsamplePcm } from './pcm'
import { VideoAnalysisService } from './service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function clip(patch: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip-a',
    trackId: 'main',
    assetId: 'asset-a',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 10,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { scale: 1, x: 0, y: 0 },
    ...patch,
  }
}

describe('local media analysis', () => {
  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'treats a video without an audio stream as empty transcription',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
      roots.push(root)
      const asset = {
        id: 'silent',
        path: 'silent.mp4',
        kind: 'video' as const,
        displayName: 'silent',
        duration: 0.2,
        width: 16,
        height: 16,
      }
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=16x16:d=0.2',
        join(root, asset.path),
      ])
      const model = join(root, 'fake-model.bin')
      writeFileSync(model, 'a model should not be needed for silent footage')
      const service = new VideoAnalysisService({ stateRoot: root })
      await service.saveConfig({
        modelPath: model,
        whisperPath: '/usr/bin/false',
      })
      expect(await service.transcribe(root, asset)).toMatchObject({
        segments: [],
        peaks: [],
      })
      expect(await service.readTranscript(root, asset)).toMatchObject({
        segments: [],
      })
    },
  )
  it('retains measured token ranges and falls back to segment ranges without interpolating', () => {
    const segment = {
      offsets: { from: 1250, to: 3150 },
      text: '打开设置',
      tokens: [
        { text: '打开', offsets: { from: 1270, to: 1440 }, p: 0.9 },
        { text: '设', offsets: { from: 1440, to: 1440 }, p: 0.95 },
        { text: '置', p: 0.95 },
        { text: '重复', offsets: { from: 1350, to: 1400 }, p: 0.99 },
        { text: '，', offsets: { from: 1500, to: 1530 }, p: 0.95 },
        { text: '其他', offsets: { from: 1540, to: 1600 }, p: 0.2 },
      ],
    }
    expect(
      parseWhisperEvidence({
        transcription: [
          segment,
          {
            timestamps: { from: '00:00:04,25', to: '00:00:05,00' },
            text: '继续',
          },
          { timestamps: { to: '00:00:10,000' }, text: '没有开始时间' },
        ],
      }),
    ).toEqual({
      segments: [
        { text: '打开设置', start: 1.25, end: 3.15 },
        { text: '继续', start: 4.25, end: 5 },
      ],
      tokens: [{ text: '打开', start: 1.27, end: 1.44, confidence: 0.9 }],
    })
  })

  it('downsamples PCM into normalized peaks', () => {
    const buffer = Buffer.alloc(8)
    buffer.writeInt16LE(0, 0)
    buffer.writeInt16LE(16_384, 2)
    buffer.writeInt16LE(-32_768, 4)
    buffer.writeInt16LE(0, 6)
    expect(downsamplePcm(buffer, 2)).toEqual([0.5, 1])
  })

  it('splits long transcript segments into readable cues', () => {
    const parts = splitTranscriptSegment({
      start: 0,
      end: 9,
      text: '今天我们来到海边，风很大，海浪也很漂亮。我们一起看看这里的风景吧。',
    })
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(22)
      expect(part.end).toBeGreaterThan(part.start)
      expect(part.end - part.start).toBeLessThanOrEqual(7.001)
    }
    for (let index = 1; index < parts.length; index += 1)
      expect(parts[index]!.start).toBeGreaterThanOrEqual(parts[index - 1]!.end)
  })

  it('drops non-speech markers from subtitles while keeping real speech', () => {
    expect(
      splitTranscriptSegment({ start: 0, end: 2, text: '(音乐)' }),
    ).toEqual([])
    expect(
      splitTranscriptSegment({ start: 2, end: 4, text: '（音乐）走啊' }),
    ).toEqual([{ start: 2, end: 4, text: '走啊' }])
  })

  it('keeps all text when a short transcript cannot fit minimum cue durations', () => {
    const cues = splitTranscriptSegment({
      start: 0,
      end: 0.8,
      text: '甲！乙！丙！',
    })
    expect(cues.map((cue) => cue.text).join('')).toBe('甲！乙！丙！')
    expect(cues.at(-1)?.end).toBe(0.8)
  })

  it('refreshes replaced frames and skips an unavailable timestamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
    roots.push(root)
    const processor = join(root, 'ffmpeg')
    writeFileSync(
      processor,
      [
        '#!/bin/bash',
        'if [[ "$4" == 1 ]]; then exit 0; fi',
        'cat "$6"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const asset = {
      id: 'frame',
      path: 'clip.mp4',
      kind: 'video' as const,
      displayName: 'clip',
      duration: 1,
      width: 2,
      height: 2,
    }
    const jpeg = (marker: number) => Buffer.from([255, 216, marker, 255, 217])
    const source = join(root, asset.path)
    const service = new VideoAnalysisService({ stateRoot: root })
    await service.saveConfig({ ffmpegPath: processor })
    writeFileSync(source, jpeg(1))
    const first = await service.frames(root, asset, [0.4])
    expect(first).toEqual([{ time: 0.4, bytes: jpeg(1) }])
    writeFileSync(join(root, 'new.mp4'), jpeg(2))
    const { renameSync } = await import('node:fs')
    renameSync(join(root, 'new.mp4'), source)
    const updated = await service.frames(root, asset, [0.4, 1])
    expect(updated).toEqual([{ time: 0.4, bytes: jpeg(2) }])
  })

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'reads both full and cropped image frames at timestamp zero',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
      roots.push(root)
      const asset = {
        id: 'screen',
        kind: 'image' as const,
        path: 'reference.png',
        displayName: 'reference',
        duration: null,
        width: 64,
        height: 32,
      }
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=64x32,drawbox=x=32:y=0:w=32:h=32:color=blue:t=fill',
        '-frames:v',
        '1',
        join(root, asset.path),
      ])
      const service = new VideoAnalysisService({ stateRoot: root })
      const right = { x: 0.5, y: 0, width: 0.5, height: 1 }
      const [full] = await service.frames(root, asset, [0])
      const [cropped] = await service.frames(root, asset, [0], undefined, right)
      expect(cropped?.bytes).not.toEqual(full?.bytes)
      expect(await service.frames(root, asset, [0], undefined, right)).toEqual([
        cropped,
      ])
      const color = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'image2pipe',
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-vf',
          'scale=1:1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        { input: cropped?.bytes },
      )
      expect(color[2]).toBeGreaterThan(230)
      expect(color[0]).toBeLessThan(30)
      await expect(service.frames(root, asset, [1])).rejects.toMatchObject({
        code: 'frame_time_invalid',
      })
      await expect(
        service.frames(root, asset, [0], undefined, { ...right, width: 0.51 }),
      ).rejects.toMatchObject({ code: 'frame_region_invalid' })
    },
  )

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'reads a native-resolution frame with its own cache key',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
      roots.push(root)
      const asset = {
        id: 'native-screen',
        kind: 'image' as const,
        path: 'screen.png',
        displayName: 'screen',
        duration: null,
        width: 1440,
        height: 900,
      }
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=1440x900',
        '-frames:v',
        '1',
        join(root, asset.path),
      ])
      const service = new VideoAnalysisService({ stateRoot: root })
      const [normal] = await service.frames(root, asset, [0])
      const [native] = await service.frames(
        root,
        asset,
        [0],
        undefined,
        undefined,
        true,
      )
      const dimensions = (bytes: Buffer) =>
        JSON.parse(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_entries',
              'stream=width,height',
              '-of',
              'json',
              'pipe:0',
            ],
            { input: bytes, encoding: 'utf8' },
          ),
        ).streams[0]
      expect(dimensions(normal!.bytes)).toMatchObject({
        width: 960,
        height: 600,
      })
      expect(dimensions(native!.bytes)).toMatchObject({
        width: 1440,
        height: 900,
      })
    },
  )

  it('maps source segments through trim and speed into timeline time', () => {
    const mapped = segmentsForClip(
      clip({ timelineStart: 4, sourceIn: 2, sourceOut: 8, speed: 2 }),
      [
        { start: 0, end: 1.5, text: 'before' },
        { start: 2, end: 5, text: 'middle' },
        { start: 7, end: 9, text: 'tail' },
      ],
    )
    expect(mapped).toEqual([
      { start: 4, end: 5.5, text: 'middle' },
      { start: 6.5, end: 7, text: 'tail' },
    ])
  })

  it('builds one non-overlapping subtitle lane across clips', () => {
    const cues = buildSubtitleCues(
      {
        clips: [
          clip({ id: 'a', trackId: 'main', timelineStart: 0 }),
          clip({
            id: 'b',
            trackId: 'track-1',
            sourceIn: 0,
            sourceOut: 4,
            timelineStart: 1,
          }),
        ],
      },
      new Map([
        [
          'asset-a',
          [
            { start: 0, end: 4, text: '主轨说话' },
            { start: 5, end: 8, text: '主轨后半段' },
          ],
        ],
      ]),
    )
    expect(cues.length).toBeGreaterThan(0)
    for (let index = 1; index < cues.length; index += 1)
      expect(cues[index]!.start).toBeGreaterThanOrEqual(cues[index - 1]!.end)
  })

  it('persists analysis settings with safe defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
    roots.push(root)
    const store = new AnalysisConfigStore(join(root, 'video-analysis.json'))
    expect(await store.read()).toMatchObject({
      language: 'zh',
      autoTranscribe: false,
    })
    await store.write({ language: 'en', autoTranscribe: true })
    expect(await store.read()).toMatchObject({
      language: 'en',
      autoTranscribe: true,
    })
  })

  it('detects configured tools and a local model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'video-analysis-'))
    roots.push(root)
    mkdirSync(join(root, 'media', 'whisper'), { recursive: true })
    writeFileSync(join(root, 'media', 'whisper', 'ggml-small.bin'), 'model')
    const service = new VideoAnalysisService({ stateRoot: root })
    await service.saveConfig({
      ffmpegPath: '/bin/echo',
      whisperPath: '/bin/echo',
    })
    const status = await service.status()
    expect(status.ready).toBe(true)
    expect(status.modelPath).toMatch(/ggml-small\.bin$/)
  })
})
