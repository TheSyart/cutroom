import {
  checkMediaCancelled,
  noSelectedPackets,
  nullOutput,
  printedNumber,
  probeMedia,
  runMedia,
  signalIntervals,
  signalStats,
  signalStatsFilter,
  streamInput,
  strictDecode,
} from './analysis/media-process'
import { renderVideoProject } from './export'
import { reviewCaptionFrames, type CaptionReview } from './caption-review'
import type { DraftReviewIssue, VideoProjectResult } from './types'
export type { DraftReviewIssue } from './types'

export interface DraftReview {
  /** Duration reported by ffprobe, in seconds. */
  duration: number
  expectedDuration: number
  completeDecode: boolean
  peakDb: number | null
  issues: DraftReviewIssue[]
  captions?: CaptionReview
}

export async function reviewEditDraft(
  snapshot: VideoProjectResult,
  options: {
    destination: string
    ffmpegPath: string
    signal?: AbortSignal
    onProgress?: (percent: number) => void
    renderMotionFrame?: import('./motion-export').RenderMotionFrame
    inspectCaptions?: boolean
  },
): Promise<DraftReview> {
  const { ffmpegPath, signal, onProgress } = options
  const rendered = await renderVideoProject(snapshot, {
    ...options,
    onProgress: (percent) => onProgress?.(Math.floor(percent * 0.72)),
  })
  const media = await probeMedia(ffmpegPath, rendered.path, signal)
  const duration = media.duration ?? 0
  const issues: DraftReviewIssue[] = []
  const add = (
    code: string,
    start: number,
    end: number,
    severity: DraftReviewIssue['severity'],
    message: string,
  ) => {
    issues.push({ code, start, end, severity, message })
  }
  if (duration === 0 || Math.abs(duration - rendered.duration) > 0.1)
    add(
      'duration_mismatch',
      Math.min(duration, rendered.duration),
      Math.max(duration, rendered.duration),
      'error',
      duration === 0
        ? '无法从渲染文件确认时长。'
        : '渲染时长与时间线相差超过 0.1 秒。',
    )
  for (const [kind, stream] of [
    ['video', media.video],
    ['audio', media.audio],
  ] as const) {
    if (!stream)
      add(
        `missing_${kind}`,
        0,
        duration,
        'error',
        kind === 'video' ? '渲染文件缺少视频流。' : '渲染文件缺少音频流。',
      )
    else {
      const streamDuration = Number(stream.duration)
      if (
        Number.isFinite(streamDuration) &&
        Math.abs(streamDuration - rendered.duration) > 0.1
      )
        add(
          `${kind}_duration_mismatch`,
          Math.min(streamDuration, rendered.duration),
          Math.max(streamDuration, rendered.duration),
          'error',
          kind === 'video'
            ? '视频流时长与时间线不符。'
            : '音频流时长与时间线不符。',
        )
    }
  }
  const black = signalIntervals('black', duration)
  const silence = signalIntervals('silence', duration)
  const peaks: Array<{ start: number; end: number }> = []
  const stats: { peakDb: number | null; decodedUntil: number } = {
    peakDb: null,
    decodedUntil: 0,
  }
  const collect = signalStats((start, peakDb) => {
    stats.peakDb = Math.max(stats.peakDb ?? -120, peakDb)
    if (peakDb < -1 || start >= duration) return
    const end = Math.min(start + 0.1, duration)
    const previous = peaks.at(-1)
    if (previous && start <= previous.end + 0.001) previous.end = end
    else peaks.push({ start: Math.max(0, start), end })
  })
  let completeDecode = false
  let percent = 72
  if (media.video || media.audio) {
    try {
      await runMedia(
        ffmpegPath,
        [
          ...strictDecode,
          '-v',
          'info',
          '-nostats',
          ...streamInput(rendered.path),
          ...(media.video
            ? [
                '-map',
                '0:V:0',
                '-vf',
                'blackdetect=d=0.35:pix_th=0.1:pic_th=0.98',
              ]
            : []),
          ...(media.audio
            ? [
                '-map',
                '0:a:0',
                '-af',
                `aresample=48000,silencedetect=n=-45dB:d=0.45,${signalStatsFilter(4800)}`,
              ]
            : []),
          '-progress',
          'pipe:2',
          ...nullOutput,
        ],
        {
          signal,
          timeoutMs: 30 * 60_000,
          onLine(line, stream) {
            if (stream === 'stdout') collect(line)
            else {
              black.push(line)
              silence.push(line)
              const time = printedNumber(line, '^out_time_us=')
              if (time === null || duration <= 0) return
              stats.decodedUntil = Math.min(
                duration,
                Math.max(stats.decodedUntil, time / 1_000_000),
              )
              const next = Math.min(
                99,
                72 + Math.floor((stats.decodedUntil / duration) * 27),
              )
              if (next > percent) onProgress?.(next)
              percent = next
            }
          },
        },
      )
      completeDecode = true
    } catch {
      checkMediaCancelled(signal)
      add(
        'decode_failed',
        stats.decodedUntil,
        duration,
        'error',
        'FFmpeg 未能完整解码渲染文件。',
      )
    }
  }
  for (const { start, end } of black.values(completeDecode))
    if (end > start) add('black', start, end, 'warning', '画面接近全黑。')
  for (const { start, end } of silence.values(completeDecode)) {
    if (end <= start) continue
    const nearlyEntire = completeDecode && start < 0.12 && end > duration - 0.12
    add(
      'silence',
      start,
      end,
      nearlyEntire ? 'error' : 'warning',
      nearlyEntire ? '成片音轨几乎全程静音。' : '音轨持续低于静音阈值。',
    )
  }
  for (const { start, end } of peaks)
    add(
      'audio_peak',
      start,
      end,
      'warning',
      '解码音频峰值接近或超过数字满刻度。',
    )
  let captions: CaptionReview | undefined
  if (
    completeDecode &&
    options.inspectCaptions &&
    snapshot.project.subtitles.length
  ) {
    try {
      captions = await reviewCaptionFrames(
        snapshot.project,
        rendered.path,
        ffmpegPath,
        signal,
      )
      issues.push(...captions.issues)
    } catch (error) {
      checkMediaCancelled(signal)
      add(
        'caption_review_failed',
        0,
        duration,
        'error',
        `无法完成字幕渲染复检。${error instanceof Error ? error.message : ''}`,
      )
    }
  }
  checkMediaCancelled(signal)
  onProgress?.(100)
  issues.sort((left, right) => left.start - right.start || left.end - right.end)
  return {
    duration,
    expectedDuration: rendered.duration,
    completeDecode,
    peakDb: stats.peakDb,
    issues,
    ...(captions ? { captions } : {}),
  }
}

export async function readDraftFrames(
  file: string,
  ffmpegPath: string,
  times: readonly number[],
  signal?: AbortSignal,
  fullResolution = false,
): Promise<Array<{ time: number; bytes: Buffer }>> {
  const requested = new Set<number>()
  for (const time of times) {
    if (!Number.isFinite(time) || time < 0 || time > 86_400) continue
    requested.add(time)
    if (requested.size === 6) break
  }
  const frames: Array<{ time: number; bytes: Buffer }> = []
  for (const time of requested) {
    const bytes = await runMedia(
      ffmpegPath,
      [
        ...strictDecode,
        '-v',
        'error',
        '-ss',
        String(time),
        ...streamInput(file),
        '-map',
        '0:V:0',
        '-frames:v',
        '1',
        '-vf',
        fullResolution ? 'null' : "scale='min(960,iw)':-2",
        '-q:v',
        '4',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { signal, timeoutMs: 60_000 },
    ).catch((cause: unknown) => {
      if (!noSelectedPackets(cause)) throw cause
      return null
    })
    if (bytes?.length) frames.push({ time, bytes })
  }
  checkMediaCancelled(signal)
  return frames
}
