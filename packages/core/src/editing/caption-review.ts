import { createEditingStaging } from './staging'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMedia, streamInput } from './analysis/media-process'
import {
  captionAss,
  captionFrame,
  captionLayout,
  resolveCaptionStyle,
  CAPTION_FPS,
  CAPTION_HEIGHT,
  CAPTION_SAFE_X,
  CAPTION_SAFE_Y,
  CAPTION_WIDTH,
} from './caption-layout'
import type { DraftReviewIssue, VideoProject } from './types'

export interface CaptionReview {
  total: number
  checked: number
  targets: number[]
  issues: DraftReviewIssue[]
}

const WIDTH = 640
const HEIGHT = 360
const ROW = WIDTH * 6
const FRAME = ROW * HEIGHT

function sampleFilter(frames: number[]): string {
  if (frames.length === 1) return `eq(n,${frames[0]})`
  const middle = frames.length >>> 1
  return `if(lt(n,${frames[middle]}),${sampleFilter(frames.slice(0, middle))},${sampleFilter(frames.slice(middle))})`
}

const linear = Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255
  return value < 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
})
function luminance(frame: Buffer, offset: number): number {
  return (
    linear[frame[offset]!]! * 0.2126 +
    linear[frame[offset + 1]!]! * 0.7152 +
    linear[frame[offset + 2]!]! * 0.0722
  )
}
function inspectFrame(frame: Buffer, inkColor: number[]) {
  const mask = WIDTH * 3
  let left = WIDTH,
    top = HEIGHT,
    right = -1,
    bottom = -1
  let edge = 0,
    readable = 0,
    opaque = 0,
    matchingInk = 0
  const neighbors = [-ROW, ROW, -3, 3]
  for (let y = 2; y < HEIGHT - 2; y++) {
    for (let x = 2; x < WIDTH - 2; x++) {
      const pixel = y * ROW + x * 3
      if (frame[pixel + mask]! < 130) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      if (frame[pixel + mask]! < 205) continue
      if (frame[pixel + mask]! >= 220) {
        opaque++
        if (
          inkColor.every(
            (channel, index) => Math.abs(frame[pixel + index]! - channel) <= 48,
          )
        )
          matchingInk++
      }
      const ink = luminance(frame, pixel)
      let hasEdge = false
      let contrast = 0
      for (const delta of neighbors) {
        for (const distance of [1, 2]) {
          const beside = pixel + delta * distance
          if (frame[beside + mask]! > 35) continue
          hasEdge = true
          const other = luminance(frame, beside)
          contrast = Math.max(
            contrast,
            (Math.max(other, ink) + 0.05) / (Math.min(other, ink) + 0.05),
          )
        }
      }
      if (hasEdge) {
        edge++
        if (contrast >= 3) readable++
      }
    }
  }
  return { left, right, top, bottom, edge, readable, opaque, matchingInk }
}

/** Decode the actual output and a matched libass glyph mask at one frame per cue. */
export async function reviewCaptionFrames(
  project: VideoProject,
  file: string,
  ffmpeg: string,
  signal?: AbortSignal,
): Promise<CaptionReview> {
  const cues = [...project.subtitles].sort((a, b) => a.start - b.start)
  const result: CaptionReview = {
    total: cues.length,
    checked: 0,
    targets: [],
    issues: [],
  }
  if (!cues.length) return result
  const style = resolveCaptionStyle(project.captionStyle)
  const inkColor = [1, 3, 5].map((start) =>
    Number.parseInt(style.color.slice(start, start + 2), 16),
  )
  const samples = new Map<number, typeof cues>()
  const add = (cue: (typeof cues)[number], code: string, message: string) => {
    result.issues.push({
      code,
      message,
      start: cue.start,
      end: cue.end,
      severity: 'error',
    })
  }
  const ranked: { frame: number; risk: number }[] = []
  let previous = undefined as (typeof cues)[number] | undefined
  for (const cue of cues) {
    const first = captionFrame(cue.start)
    const last = captionFrame(cue.end) - 1
    const layout = captionLayout(cue.text, style)
    if (style.fontSize < 48)
      add(cue, 'caption_small', '字幕字号低于 1080p 可读性基准（48 px）。')
    if (layout.lines.length > 2)
      add(cue, 'caption_lines', '字幕超过两行，请重排或按原语义拆分。')
    if (previous && previous.end > cue.start + 0.001)
      add(cue, 'caption_overlap', '字幕时间与前一条重叠。')
    if (!previous || previous.end <= cue.end) previous = cue
    if (first > last) {
      add(cue, 'caption_missing', '字幕持续时间不足一个输出帧。')
      continue
    }
    const frame = Math.floor((first + last) / 2)
    const same = samples.get(frame) ?? []
    same.push(cue)
    samples.set(frame, same)
    ranked.push({ frame, risk: layout.width * layout.lines.length })
  }
  const frames = [...samples.keys()].sort((a, b) => a - b)
  const featured = [
    ...new Set([
      ...ranked
        .slice()
        .sort((a, b) => b.risk - a.risk)
        .slice(0, 3)
        .map((item) => item.frame),
      ...[0, 0.5, 1].map(
        (fraction) => frames[Math.round((frames.length - 1) * fraction)],
      ),
    ]),
  ].filter((frame): frame is number => frame !== undefined)
  result.targets = featured
    .map((frame) => frame / CAPTION_FPS)
    .sort((a, b) => a - b)
  if (!frames.length) return result
  const staging = await createEditingStaging(tmpdir())
  const work = staging.path
  const frame = Buffer.allocUnsafe(FRAME)
  let filled = 0,
    index = 0
  try {
    await writeFile(join(work, 'mask.ass'), captionAss(cues, style, true))
    const graph = [
      `[0:v]select='${sampleFilter(frames)}',split[rendered][blank]`,
      `[rendered]scale=${WIDTH}:${HEIGHT},format=rgb24[view]`,
      `[blank]drawbox=x=0:y=0:w=iw:h=ih:c=black:t=fill,subtitles=mask.ass,scale=${WIDTH}:${HEIGHT},format=rgb24[mask]`,
      '[view][mask]hstack=inputs=2[inspection]',
    ].join(';')
    const filterFile = join(work, 'filters.txt')
    await writeFile(filterFile, graph)
    await runMedia(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '4',
        ...streamInput(file),
        '-filter_complex_threads',
        '2',
        '-filter_complex_script',
        filterFile,
        '-map',
        '[inspection]',
        '-an',
        '-fps_mode',
        'passthrough',
        '-pix_fmt',
        'rgb24',
        '-c:v',
        'rawvideo',
        '-threads',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      {
        cwd: work,
        signal,
        timeoutMs: 30 * 60_000,
        onChunk(chunk, stream) {
          if (stream !== 'stdout') return
          for (let offset = 0; offset < chunk.length;) {
            const written = chunk.copy(
              frame,
              filled,
              offset,
              offset + FRAME - filled,
            )
            offset += written
            filled += written
            if (filled !== FRAME) continue
            const matched = samples.get(frames[index++]!) ?? []
            const pixels = inspectFrame(frame, inkColor)
            for (const cue of matched) {
              result.checked++
              if (
                pixels.right < 0 ||
                (pixels.opaque >= 4 &&
                  pixels.matchingInk / pixels.opaque < 0.55)
              )
                add(cue, 'caption_missing', '实际渲染帧没有匹配的字幕字形。')
              else if (
                pixels.left < (CAPTION_SAFE_X * WIDTH) / CAPTION_WIDTH - 3 ||
                pixels.right >
                  WIDTH - (CAPTION_SAFE_X * WIDTH) / CAPTION_WIDTH + 3 ||
                pixels.top < (CAPTION_SAFE_Y * HEIGHT) / CAPTION_HEIGHT - 5 ||
                pixels.bottom >
                  HEIGHT - (CAPTION_SAFE_Y * HEIGHT) / CAPTION_HEIGHT + 5
              )
                add(cue, 'caption_overflow', '渲染字幕越过安全区。')
              else if (pixels.edge < 4 || pixels.readable / pixels.edge < 0.58)
                add(
                  cue,
                  'caption_contrast',
                  '实际渲染帧上的字幕边缘对比度不足。',
                )
            }
            filled = 0
          }
        },
      },
    )
    for (const time of frames.slice(index))
      for (const cue of samples.get(time) ?? [])
        add(cue, 'caption_missing', '无法读取该条字幕的成片帧。')
    return result
  } finally {
    await staging.close()
  }
}
