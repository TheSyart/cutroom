import { EmperorError } from '../../errors'
import {
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
} from './media-process'
import type { VideoAsset, VideoClip } from '../types'
import type { TranscriptSegment } from './captions'

export interface TranscriptToken extends TranscriptSegment {
  confidence?: number
}

export interface MediaEvidenceEvent {
  kind: 'transcript' | 'token' | 'pause' | 'energy' | 'screen-change'
  /** Source media time in seconds. A screen change is a point event. */
  start: number
  end: number
  text?: string
  confidence?: number
  rmsDb?: number
  peakDb?: number
  score?: number
}

export interface MediaEvidence {
  assetId: string
  start: number
  end: number
  duration: number
  /** Pass this source second as the next start to inspect a longer asset. */
  nextStart: number | null
  transcription: 'token' | 'segment' | 'unavailable'
  transcriptionDiagnostic?: string
  audio: 'present' | 'absent'
  events: Array<
    MediaEvidenceEvent & {
      timeline: Array<{ clipId: string; start: number; end: number }>
    }
  >
}

export function mapEvidenceToTimeline(
  event: MediaEvidenceEvent,
  clips: readonly VideoClip[],
) {
  return clips.flatMap((clip) => {
    const sourceStart = Math.max(event.start, clip.sourceIn)
    const sourceEnd = Math.min(event.end, clip.sourceOut)
    if (event.start === event.end) {
      if (event.start < clip.sourceIn || event.start >= clip.sourceOut)
        return []
    } else if (sourceEnd <= sourceStart) return []
    return [
      {
        clipId: clip.id,
        start: clip.timelineStart + (sourceStart - clip.sourceIn) / clip.speed,
        end: clip.timelineStart + (sourceEnd - clip.sourceIn) / clip.speed,
      },
    ]
  })
}

export async function measureSource(
  ffmpegPath: string,
  file: string,
  asset: VideoAsset,
  options: { start?: number; end?: number; signal?: AbortSignal },
): Promise<{
  start: number
  end: number
  duration: number
  audio: 'present' | 'absent'
  events: MediaEvidenceEvent[]
}> {
  const { signal } = options
  const media = await probeMedia(ffmpegPath, file, signal)
  const duration = media.duration ?? asset.duration
  if (duration === null)
    throw new EmperorError(
      '无法读取素材的媒体时长。',
      'analysis_duration_missing',
    )
  const start = options.start ?? 0
  const requestedEnd = options.end ?? duration
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(requestedEnd) ||
    start < 0 ||
    requestedEnd <= start ||
    start >= duration
  )
    throw new EmperorError('素材分析时间范围无效。', 'analysis_range_invalid')
  const end = Math.min(requestedEnd, duration, start + 60)
  const length = end - start
  const input = [
    ...strictDecode,
    '-v',
    'info',
    '-nostats',
    '-ss',
    String(start),
    ...streamInput(file),
  ]
  const events: MediaEvidenceEvent[] = []
  if (media.audio) {
    const pause = signalIntervals('silence', length)
    const stats = signalStats((windowStart, peakDb, rmsDb) => {
      const absolute = start + windowStart
      if (absolute >= end) return
      events.push({
        kind: 'energy',
        start: absolute,
        end: Math.min(absolute + 0.5, end),
        peakDb,
        rmsDb,
      })
    })
    await runMedia(
      ffmpegPath,
      [
        ...input,
        '-map',
        '0:a:0',
        '-af',
        `aresample=48000:async=1:first_pts=0,atrim=duration=${length},silencedetect=n=-42dB:d=0.25,${signalStatsFilter(24000)}`,
        ...nullOutput,
      ],
      {
        signal,
        timeoutMs: 120_000,
        onLine(line, stream) {
          if (stream === 'stdout') stats(line)
          else pause.push(line)
        },
      },
    ).catch((cause: unknown) => {
      if (!noSelectedPackets(cause)) throw cause
    })
    for (const interval of pause.values()) {
      if (interval.end > interval.start)
        events.push({
          kind: 'pause',
          start: start + interval.start,
          end: Math.min(end, start + interval.end),
        })
    }
  }
  if (asset.kind === 'video' && media.video) {
    let time: number | null = null
    await runMedia(
      ffmpegPath,
      [
        ...input,
        '-map',
        '0:V:0',
        '-vf',
        `trim=duration=${length},scale='min(320,iw)':-2,select='gte(scene,0.08)+eq(n,0)',metadata=mode=print:key=lavfi.scene_score:file=pipe\\\\:1`,
        '-fps_mode',
        'passthrough',
        ...nullOutput,
      ],
      {
        signal,
        timeoutMs: 120_000,
        onLine(line, stream) {
          if (stream !== 'stdout') return
          if (line.startsWith('frame:')) {
            time = printedNumber(line, 'pts_time:\\s*')
            return
          }
          const score = printedNumber(line, '^lavfi\\.scene_score=')
          if (time === null || score === null || score < 0.08) return
          const occurrence = start + time
          if (occurrence < end)
            events.push({
              kind: 'screen-change',
              start: occurrence,
              end: occurrence,
              score,
            })
        },
      },
    ).catch((cause: unknown) => {
      if (!noSelectedPackets(cause)) throw cause
    })
  }
  return {
    start,
    end,
    duration,
    audio: media.audio ? 'present' : 'absent',
    events,
  }
}

interface WhisperTiming {
  offsets?: { from?: number; to?: number }
  timestamps?: { from?: string; to?: string }
  text?: string
}

function parseClock(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const match = value.match(/^(\d+):(\d+):(\d+)[,.](\d+)$/)
  if (!match) return NaN
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(`0.${match[4]}`)
  )
}

function timedText(raw: WhisperTiming): TranscriptSegment | null {
  const start =
    typeof raw.offsets?.from === 'number'
      ? raw.offsets.from / 1000
      : parseClock(raw.timestamps?.from)
  const end =
    typeof raw.offsets?.to === 'number'
      ? raw.offsets.to / 1000
      : parseClock(raw.timestamps?.to)
  const text = (raw.text ?? '').trim()
  if (
    !text ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  )
    return null
  return { start, end, text }
}

export function parseWhisperEvidence(raw: {
  transcription?: Array<
    WhisperTiming & { tokens?: Array<WhisperTiming & { p?: number }> }
  >
}): { segments: TranscriptSegment[]; tokens: TranscriptToken[] } {
  const segments: TranscriptSegment[] = []
  const tokens: TranscriptToken[] = []
  for (const item of raw.transcription ?? []) {
    const segment = timedText(item)
    if (!segment) continue
    segments.push(segment)
    let previousEnd = segment.start
    for (const itemToken of item.tokens ?? []) {
      const token = timedText(itemToken)
      const confidence = itemToken.p
      if (
        !token ||
        !/[\p{L}\p{N}]/u.test(token.text) ||
        /^\[_.+_\]$/.test(token.text) ||
        confidence === undefined ||
        !Number.isFinite(confidence) ||
        confidence < 0.5 ||
        confidence > 1 ||
        token.start < previousEnd ||
        token.end > segment.end
      )
        continue
      tokens.push({ ...token, confidence })
      previousEnd = token.end
    }
  }
  return { segments, tokens }
}
