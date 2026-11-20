import type { TranscriptSegment } from './analysis/captions'
import type { VideoProject } from './types'

interface Range {
  start: number
  end: number
}
export interface SpeechAnchor extends Range {
  assetId: string
  text: string
}
export interface SpeechAuditIssue extends Range {
  code: 'speech_repeat' | 'speech_false_start' | 'speech_missing'
  severity: 'warning' | 'error'
  message: string
  remove?: Range
  source?: SpeechAnchor
}

interface Clause extends TranscriptSegment {
  timed: boolean
}
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const canonical = (s: string) =>
  normalize(s)
    .replace(/^(?:也就是|那就是|这就是)/u, '')
    .replace(/(?:呢|啊)$/u, '')

function clauses(
  segments: TranscriptSegment[],
  tokens: readonly TranscriptSegment[],
  duration: number,
) {
  const result: Clause[] = []
  const words = tokens
    .filter((t) => t.end > t.start && normalize(t.text))
    .slice()
    .sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const s of segments.slice().sort((a, b) => a.start - b.start)) {
    if (!(s.start >= 0 && s.end > s.start && s.start < duration)) continue
    while (cursor < words.length && words[cursor]!.start < s.start - 0.015)
      cursor++
    const parts = (
      s.text.match(/[^，。！？、；,.!?;]+[，。！？、；,.!?;]*/gu) ?? []
    ).filter((p) => normalize(p))
    let offset = 0
    const aligned: Clause[] = []
    for (const part of parts) {
      const expected = normalize(part)
      const first = words[cursor + offset]
      let actual = ''
      while (first && actual.length < expected.length) {
        const w = words[cursor + offset]
        if (!w || w.end > s.end + 0.015) break
        actual += normalize(w.text)
        offset++
      }
      if (!first || actual !== expected) break
      aligned.push({
        text: part.trim(),
        start: first.start,
        end: Math.min(duration, words[cursor + offset - 1]!.end),
        timed: true,
      })
    }
    if (aligned.length === parts.length) {
      result.push(...aligned)
      cursor += offset
    } else {
      // A sentence timestamp cannot locate a clause inside it.
      for (const part of parts)
        result.push({
          text: part.trim(),
          start: s.start,
          end: Math.min(s.end, duration),
          timed: parts.length === 1,
        })
    }
  }
  return result
}

function repeatKind(
  first: Clause,
  next: Clause,
): 'speech_repeat' | 'speech_false_start' | undefined {
  const a = canonical(first.text),
    b = canonical(next.text)
  if (a.length < 3 || b.length < a.length || a.length > 32) return
  const summaryOpening = /^(?:那就是|这就是|也就是)/u
  if (
    a.length >= 7 &&
    summaryOpening.test(first.text) &&
    summaryOpening.test(next.text) &&
    b.startsWith(a.slice(0, 3)) &&
    b.endsWith(a.slice(-2)) &&
    /(?:还有|以及|加上)/u.test(b) &&
    !/(?:还有|以及|加上)/u.test(a)
  )
    return 'speech_repeat'
  // Separate complete statements can deliberately build on the same opening.
  if (/[。.!！]$/u.test(first.text)) return
  if (a === b || b.startsWith(a)) return 'speech_repeat'
  if (/[?？]$/u.test(first.text) && a === b.replace('了', ''))
    return 'speech_repeat'
  let n = 0
  while (n < a.length && a[n] === b[n]) n++
  // A short incomplete tail following a shared opening (e.g. “我们给了第”).
  if (
    n >= 3 &&
    a.length - n <= 2 &&
    b.length > a.length &&
    (/(?:第|的|到|了|把|我们)$/u.test(a) || /^(?:那)?如果要/u.test(a))
  )
    return 'speech_false_start'
}

function correctedTake(items: Clause[], index: number): Clause | undefined {
  const first = items[index]!
  const opening = canonical(first.text)
  if (opening.length < 3) return
  const correctionMarker = /^(?:不对|说错了|讲错了|重来|再来一次)$/u
  let end = first.end
  for (let offset = 1; offset <= 3; offset++) {
    const next = items[index + offset]
    if (!next || next.start - end > 1.3) return
    if (!correctionMarker.test(normalize(next.text)))
      return offset > 1 && canonical(next.text).startsWith(opening.slice(0, 3))
        ? next
        : undefined
    end = next.end
  }
}

export function findSpeechDisfluencies(
  transcript: {
    segments: TranscriptSegment[]
    tokens?: readonly TranscriptSegment[]
  },
  duration: number,
): SpeechAuditIssue[] {
  const items = clauses(transcript.segments, transcript.tokens ?? [], duration)
  const issues: SpeechAuditIssue[] = []
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i]!,
      b = items[i + 1]!,
      c = items[i + 2]
    let kept = b
    let code = repeatKind(a, b)
    const corrected = code ? undefined : correctedTake(items, i)
    if (corrected) {
      code = 'speech_false_start'
      kept = corrected
    }
    // A long abandoned take may precede a short stumble and then the clean take.
    if (
      !code &&
      c &&
      b.start - a.end <= 1.3 &&
      c.start - b.end <= 1.3 &&
      canonical(b.text).length <= 5 &&
      canonical(b.text).slice(0, 3) === canonical(c.text).slice(0, 3) &&
      canonical(a.text).length >= 6 &&
      canonical(c.text).startsWith(
        canonical(a.text).replace(/(?:到了|了)$/u, ''),
      )
    ) {
      code = 'speech_false_start'
      kept = c
    }
    if (
      !code ||
      (!corrected && kept.start - (kept === b ? a.end : b.end) > 1.3)
    )
      continue
    const precise =
      a.timed &&
      b.timed &&
      kept.timed &&
      a.end <= b.start &&
      b.start <= kept.start
    issues.push({
      code,
      severity: precise ? 'error' : 'warning',
      start: a.start,
      end: kept.end,
      message: '疑似口播重起：“' + a.text + '” → “' + kept.text + '”。',
      ...(precise ? { remove: { start: a.start, end: kept.start } } : {}),
    })
    if (kept !== b) i++
  }
  return issues
}

export function findMissingSpeechAnchors(
  project: VideoProject,
  anchors: readonly SpeechAnchor[],
  duration: number,
): SpeechAuditIssue[] {
  const issues: SpeechAuditIssue[] = []
  for (const source of anchors) {
    if (!(source.end > source.start)) continue
    const visible = project.clips
      .filter((c) => c.assetId === source.assetId && c.timelineStart < duration)
      .map((c) => ({
        ...c,
        sourceOut: Math.min(
          c.sourceOut,
          c.sourceIn + (duration - c.timelineStart) * c.speed,
        ),
      }))
    const audible = visible
      .filter((c) => !c.muted && c.volume > 0)
      .sort((a, b) => a.sourceIn - b.sourceIn)
    let cursor = source.start,
      missing = 0
    for (const clip of audible) {
      const start = Math.max(source.start, clip.sourceIn),
        end = Math.min(source.end, clip.sourceOut)
      if (end <= cursor || start >= end) continue
      missing += Math.max(0, start - cursor)
      cursor = end
    }
    missing += source.end - cursor
    if (missing <= Math.min(0.24, (source.end - source.start) * 0.12) + 1e-6)
      continue
    let distance = Infinity,
      time = 0
    for (const clip of visible) {
      const pos = Math.min(
        clip.sourceOut,
        Math.max(clip.sourceIn, source.start),
      )
      if (Math.abs(pos - source.start) < distance) {
        distance = Math.abs(pos - source.start)
        time = clip.timelineStart + (pos - clip.sourceIn) / clip.speed
      }
    }
    issues.push({
      code: 'speech_missing',
      severity: 'error',
      source,
      start: time,
      end: time,
      message:
        '关键原声“' +
        source.text +
        '”有 ' +
        missing.toFixed(2) +
        ' 秒未被有声片段覆盖。',
    })
  }
  return issues
}
