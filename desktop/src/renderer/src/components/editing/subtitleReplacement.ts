import {
  clipTimelineDuration,
  type SubtitleCue,
  type VideoClip,
} from '@emperor/core/editing'

type InputCue = Omit<SubtitleCue, 'id'>

/** The subtitle lane is time-based. Keep existing IDs outside the edited ranges,
 * and keep the visible pieces of cues that straddle a range boundary. */
export function subtitleReplacement(
  existing: SubtitleCue[],
  clips: VideoClip[],
  generated: InputCue[],
) {
  const ranges = clips
    .map((clip) => ({
      start: clip.timelineStart,
      end: clip.timelineStart + clipTimelineDuration(clip),
    }))
    .sort((a, b) => a.start - b.start)
  const replaceIds: string[] = []
  const cues = [...generated]
  for (const cue of existing) {
    let start = cue.start
    let touched = false
    for (const range of ranges) {
      if (range.start >= cue.end) break
      if (range.end <= start) continue
      touched = true
      if (range.start - start >= 0.05)
        cues.push({ start, end: range.start, text: cue.text })
      start = Math.max(start, range.end)
    }
    if (!touched) continue
    replaceIds.push(cue.id)
    if (cue.end - start >= 0.05)
      cues.push({ start, end: cue.end, text: cue.text })
  }
  return { type: 'replaceSubtitles' as const, replaceIds, cues }
}
