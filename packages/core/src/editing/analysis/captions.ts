import type { SubtitleCue, VideoClip, VideoProject } from '../types'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

const MAX_CHARS = 22
const MAX_DURATION = 7
const MIN_DURATION = 0.6

/** Whisper emits cues such as (音乐) for non-speech; do not put them on screen. */
function cleanSpeech(text: string): string {
  return text
    .replace(/[（(]\s*(音乐|掌声|笑声|music|applause)\s*[)）]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function chunks(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean
    .split(/(?<=[。！？!?；;])/u)
    .map((part) => part.trim())
    .filter(Boolean)
  const result: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHARS) {
      result.push(sentence)
      continue
    }
    const parts = sentence
      .split(/(?<=[，,、：:])/u)
      .map((part) => part.trim())
      .filter(Boolean)
    let buffer = ''
    for (const part of parts) {
      if (part.length > MAX_CHARS) {
        if (buffer) result.push(buffer)
        buffer = ''
        for (let index = 0; index < part.length; index += MAX_CHARS)
          result.push(part.slice(index, index + MAX_CHARS))
        continue
      }
      if (buffer && buffer.length + part.length > MAX_CHARS) {
        result.push(buffer)
        buffer = ''
      }
      buffer += part
    }
    if (buffer) result.push(buffer)
  }
  return result.filter(Boolean)
}

/** Split one ASR segment into readable cues, preserving its time span. */
export function splitTranscriptSegment(
  segment: TranscriptSegment,
): TranscriptSegment[] {
  const text = cleanSpeech(segment.text)
  const duration = segment.end - segment.start
  if (!text || duration <= 0) return []
  const parts = chunks(text)
  if (parts.length <= 1)
    return [
      { start: segment.start, end: segment.end, text: text.slice(0, 500) },
    ]
  if (duration < MIN_DURATION * parts.length)
    return [
      { start: segment.start, end: segment.end, text: text.slice(0, 500) },
    ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  let cursor = segment.start
  const result: TranscriptSegment[] = []
  for (const [index, part] of parts.entries()) {
    const share = index === parts.length - 1 ? 1 : part.length / total
    const last = index === parts.length - 1
    const available =
      segment.end - cursor - (parts.length - index - 1) * MIN_DURATION
    const end = last
      ? segment.end
      : cursor +
        Math.min(
          available,
          MAX_DURATION,
          Math.max(MIN_DURATION, duration * share),
        )
    if (end > cursor + 0.01)
      result.push({ start: cursor, end, text: part.slice(0, 500) })
    cursor = end
  }
  return result
}

/** Map ASR source-time segments to a clip's timeline span. */
export function segmentsForClip(
  clip: VideoClip,
  segments: TranscriptSegment[],
): TranscriptSegment[] {
  const duration = (clip.sourceOut - clip.sourceIn) / clip.speed
  const end = clip.timelineStart + duration
  const mapped: TranscriptSegment[] = []
  for (const segment of segments) {
    const from = Math.max(segment.start, clip.sourceIn)
    const to = Math.min(segment.end, clip.sourceOut)
    if (to - from < 0.05) continue
    const start = Math.max(
      clip.timelineStart,
      clip.timelineStart + (from - clip.sourceIn) / clip.speed,
    )
    const stop = Math.min(
      end,
      clip.timelineStart + (to - clip.sourceIn) / clip.speed,
    )
    if (stop - start < 0.05) continue
    mapped.push({ start, end: stop, text: segment.text })
  }
  return mapped
}

/**
 * Build one non-overlapping subtitle lane from transcripts of all used assets.
 * Overlapping dialogue across tracks keeps the earlier cue and trims the later
 * one so the project's subtitle invariant holds.
 */
export function buildSubtitleCues(
  project: Pick<VideoProject, 'clips'>,
  transcripts: Map<string, TranscriptSegment[]>,
): { start: number; end: number; text: string }[] {
  const cues = project.clips
    .flatMap((clip) => {
      const segments = transcripts.get(clip.assetId)
      if (!segments?.length) return []
      return segmentsForClip(clip, segments).flatMap(splitTranscriptSegment)
    })
    .sort((a, b) => a.start - b.start)
  const result: { start: number; end: number; text: string }[] = []
  let previousEnd = 0
  for (const cue of cues) {
    const start = Math.max(cue.start, previousEnd)
    const end = cue.end
    if (end - start < 0.05) continue
    const text = cue.text.trim()
    if (!text) continue
    result.push({ start, end, text: text.slice(0, 500) })
    previousEnd = end
  }
  return result
}

export function cuesForProject(
  project: Pick<VideoProject, 'clips'>,
  transcripts: Map<string, TranscriptSegment[]>,
): SubtitleCue[] {
  return buildSubtitleCues(project, transcripts).map((cue, index) => ({
    id: `pending-${index + 1}`,
    ...cue,
  }))
}
