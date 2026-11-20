import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFile,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reviewEditDraft } from './draft-review'
import { renderVideoProject } from './export'
import type { VideoClip, VideoProjectResult } from './types'
import {
  discoverWorkspaceMedia,
  workspaceMediaInventory,
} from './workspace-inputs'

const available = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version']).status === 0,
)
const ffmpeg = (...args: string[]) =>
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...args])

function clip(id: string, patch: Partial<VideoClip>): VideoClip {
  return {
    id,
    assetId: id,
    trackId: 'main',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 2,
    speed: 1,
    muted: false,
    volume: 1,
    transform: { scale: 1, x: 0, y: 0 },
    ...patch,
  }
}

it.skipIf(!available)(
  'renders stacked tracks, audible source audio and visible subtitles',
  async () => {
    const projectPath = await realpath(
      await mkdtemp(join(tmpdir(), 'video export 中文 ')),
    )
    try {
      const main = join(projectPath, 'main.mp4')
      const overlay = join(projectPath, "blue's.mp4")
      const destination = join(projectPath, '成片.mp4')
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'color=red:s=96x54:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        main,
      )
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=96x54:r=30:d=1,drawbox=x=55:y=29:w=14:h=13:color=green:t=fill',
        '-c:v',
        'libx264',
        overlay,
      )
      const snapshot: VideoProjectResult = {
        sessionId: 'editing',
        projectPath,
        canUndo: false,
        canRedo: false,
        project: {
          schemaVersion: 2,
          projectId: 'project',
          name: 'test',
          revision: 7,
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
          canvas: { fit: 'contain', background: '#181818' },
          assets: [
            {
              id: 'main',
              kind: 'video',
              path: 'main.mp4',
              displayName: 'main',
              width: 96,
              height: 54,
              duration: 2,
            },
            {
              id: 'blue',
              kind: 'video',
              path: "blue's.mp4",
              displayName: 'blue',
              width: 96,
              height: 54,
              duration: 1,
            },
          ],
          tracks: [
            { id: 'main', kind: 'video', index: 0, name: '主轨' },
            { id: 'top', kind: 'video', index: 1, name: '上轨' },
          ],
          clips: [
            clip('main', {}),
            clip('blue', {
              trackId: 'top',
              timelineStart: 0.8,
              sourceOut: 0.6,
            }),
          ],
          subtitles: [
            { id: 'caption', start: 1.5, end: 2, text: '剪辑测试 VIDEO' },
          ],
        },
      }
      await expect(
        renderVideoProject(snapshot, {
          ffmpegPath: 'ffmpeg',
          destination,
          recordWorkspaceOutput: true,
        }),
      ).resolves.toMatchObject({
        revision: 7,
        duration: 2,
        path: destination,
      })
      expect(
        (await workspaceMediaInventory(snapshot)).outputs.map(
          (output) => output.path,
        ),
      ).toEqual(['成片.mp4'])
      await copyFile(main, join(projectPath, '待确认原片.mov'))
      await copyFile(overlay, join(projectPath, '另一条未登记素材.mov'))
      await expect(
        discoverWorkspaceMedia(snapshot, 'ffmpeg', ['待确认原片.mov']),
      ).resolves.toMatchObject([
        { path: '待确认原片.mov', duration: 2, width: 96, height: 54 },
      ])
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-of', 'json', destination],
          { encoding: 'utf8' },
        ),
      )
      expect(probe.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            codec_name: 'h264',
            width: 1920,
            height: 1080,
          }),
          expect.objectContaining({ codec_name: 'aac' }),
        ]),
      )
      const pixel = (time: string) =>
        ffmpeg(
          '-ss',
          time,
          '-i',
          destination,
          '-frames:v',
          '1',
          '-vf',
          'crop=2:2:960:540',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          '-',
        )
      expect(pixel('0.3')[0]).toBeGreaterThan(230)
      expect(pixel('1.0')[2]).toBeGreaterThan(230)
      const captionArea = ffmpeg(
        '-ss',
        '1.7',
        '-i',
        destination,
        '-frames:v',
        '1',
        '-vf',
        'crop=768:160:576:850',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      )
      expect(
        captionArea.filter((value, i) => i % 3 === 1 && value > 200).length,
      ).toBeGreaterThan(100)
      const audio = ffmpeg(
        '-i',
        destination,
        '-vn',
        '-t',
        '0.4',
        '-ac',
        '1',
        '-f',
        's16le',
        '-',
      )
      expect(audio.some((value) => value !== 0)).toBe(true)
      const enhanced = structuredClone(snapshot)
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1',
        '-c:a',
        'pcm_s16le',
        join(projectPath, 'voice.wav'),
      )
      enhanced.project.assets.push({
        id: 'voice',
        kind: 'audio',
        duration: 1,
        path: 'voice.wav',
        displayName: 'voice',
        width: null,
        height: null,
      })
      enhanced.project.tracks.push({
        id: 'sound',
        kind: 'audio',
        index: 2,
        name: '讲解',
      })
      enhanced.project.clips[0]!.muted = true
      enhanced.project.clips.push(
        clip('voice', {
          trackId: 'sound',
          sourceOut: 1,
          timelineStart: 0.5,
          fadeIn: 0.3,
          fadeOut: 0.3,
        }),
      )
      enhanced.project.captionStyle = {
        position: 'top',
        color: '#00ff00',
        fontSize: 60,
      }
      enhanced.project.annotations = [
        {
          id: 'mark',
          kind: 'box',
          x: 0.5,
          y: 0.5,
          width: 0.2,
          height: 0.2,
          color: '#00ff00',
          start: 0.1,
          end: 0.5,
        },
        {
          id: 'zoom',
          kind: 'zoom',
          x: 0.5,
          y: 0.5,
          width: 0.25,
          height: 0.25,
          color: '#ffffff',
          start: 0.9,
          end: 1.2,
        },
      ]
      await renderVideoProject(enhanced, { ffmpegPath: 'ffmpeg', destination })
      expect(pixel('0.3')[1]).toBeGreaterThan(200)
      expect(pixel('0.7')[1]).toBeLessThan(50)
      expect(pixel('0.85')[2]).toBeGreaterThan(230)
      expect(pixel('1.0')[1]).toBeGreaterThan(90)
      expect(pixel('1.3')[2]).toBeGreaterThan(230)
      const topCaption = ffmpeg(
        '-ss',
        '1.7',
        '-i',
        destination,
        '-frames:v',
        '1',
        '-vf',
        'crop=768:180:576:20',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      )
      expect(
        topCaption.filter((value, i) => i % 3 === 1 && value > 200).length,
      ).toBeGreaterThan(100)
      const rms = (start: string) => {
        const data = ffmpeg(
          '-ss',
          start,
          '-i',
          destination,
          '-t',
          '0.05',
          '-ac',
          '1',
          '-f',
          's16le',
          '-',
        )
        let energy = 0
        for (let i = 0; i < data.length; i += 2)
          energy += data.readInt16LE(i) ** 2
        return Math.sqrt(energy / (data.length / 2))
      }
      expect(rms('0.2')).toBeLessThan(10)
      expect(rms('1.0')).toBeGreaterThan(1000)
      expect(rms('0.50')).toBeLessThan(rms('1.0') * 0.3)
      expect(rms('1.45')).toBeLessThan(rms('1.0') * 0.3)
      const assetAlias = join(projectPath, '同一素材.mp4')
      await link(main, assetAlias)
      await expect(
        renderVideoProject(snapshot, {
          ffmpegPath: 'ffmpeg',
          destination: assetAlias,
        }),
      ).rejects.toMatchObject({ code: 'invalid_export_destination' })
      const previousBytes = await readFile(destination)
      const abort = new AbortController()
      abort.abort()
      await expect(
        renderVideoProject(snapshot, {
          ffmpegPath: 'ffmpeg',
          destination,
          signal: abort.signal,
        }),
      ).rejects.toMatchObject({ code: 'export_cancelled' })
      expect(await readFile(destination)).toEqual(previousBytes)
      const gif = join(projectPath, '动画.gif')
      ffmpeg('-f', 'lavfi', '-i', 'color=blue:s=96x54:r=12:d=1', gif)
      const animated = structuredClone(snapshot)
      Object.assign(animated.project.assets[1]!, {
        path: '动画.gif',
        kind: 'image',
        duration: null,
      })
      await renderVideoProject(animated, { ffmpegPath: 'ffmpeg', destination })
      expect(pixel('1.0')[2]).toBeGreaterThan(230)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(!available)(
  'precision draft MP4 contains exactly the intended project frames of one-, two- and three-frame motion scenes',
  async () => {
    const projectPath = await realpath(
      await mkdtemp(join(tmpdir(), 'motion-export-frames-')),
    )
    try {
      const firstFrame = 2
      const starts = [firstFrame, 5, 11]
      const colors = ['red', 'lime', 'blue']
      const colorsPng = colors.map((color) =>
        ffmpeg(
          '-f',
          'lavfi',
          '-i',
          'color=' + color + ':s=16x16',
          '-frames:v',
          '1',
          '-c:v',
          'png',
          '-f',
          'image2pipe',
          'pipe:1',
        ),
      )
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'color=black:s=96x54',
        '-frames:v',
        '1',
        join(projectPath, 'ground.png'),
      )
      const scenes = starts.map((startFrame, index) => ({
        id: 's' + index,
        name: '色块',
        startFrame,
        durationFrames: index + 1,
        sourceInFrame: 6,
        mode: 'overlay' as const,
        version: 1,
        story: '逐帧检查',
        objects: [
          {
            id: 'mark',
            name: '标记',
            html: '<b></b>',
            draw: '',
            markers: [],
            bounds: { x: 0, y: 0, width: 16, height: 16 },
          },
        ],
      }))
      const snapshot: VideoProjectResult = {
        projectPath,
        sessionId: 'test',
        canUndo: false,
        canRedo: false,
        project: {
          schemaVersion: 2,
          projectId: 'p',
          revision: 1,
          name: '帧边界',
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
          assets: [
            {
              id: 'ground',
              path: 'ground.png',
              displayName: '背景',
              kind: 'image',
              duration: null,
              width: 96,
              height: 54,
            },
          ],
          tracks: [{ id: 'main', name: '主画面', kind: 'video', index: 0 }],
          clips: [clip('ground', { sourceOut: 0.6 })],
          canvas: { fit: 'contain', background: '#000000' },
          subtitles: [],
          motionScenes: scenes,
        },
      }
      const destination = join(projectPath, 'review.mp4')
      const review = await reviewEditDraft(snapshot, {
        ffmpegPath: 'ffmpeg',
        destination,
        renderMotionFrame: async (scene, frame) =>
          colorsPng[frame - scene.sourceInFrame]!,
      })
      expect(review.completeDecode).toBe(true)
      const bytes = ffmpeg(
        '-i',
        destination,
        '-vf',
        'crop=2:2:6:6',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      )
      const frames = Array.from({ length: bytes.length / 12 }, (_, i) => {
        const rgb = bytes.subarray(i * 12, i * 12 + 3)
        return colors.find((_, channel) => rgb[channel]! > 175) ?? 'black'
      })
      const expected = new Array<string>(18).fill('black')
      for (const scene of scenes)
        for (let offset = 0; offset < scene.durationFrames; offset++)
          expected[scene.startFrame + offset] = colors[offset]!
      expect(frames).toEqual(expected)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  },
  30_000,
)
