import type { CaptionStyle, SubtitleCue } from './types'

export const CAPTION_WIDTH = 1920
export const CAPTION_HEIGHT = 1080
export const CAPTION_FPS = 30
export const CAPTION_SAFE_X = 154
export const CAPTION_SAFE_Y = 76
export const CAPTION_FONT = 'Hiragino Sans GB'
export const defaultCaptionStyle: Required<CaptionStyle> = {
  fontSize: 54,
  color: '#ffffff',
  position: 'bottom',
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  outlineColor: '#000000',
  outlineWidth: 3,
}

export function resolveCaptionStyle(
  style?: CaptionStyle,
): Required<CaptionStyle> {
  return { ...defaultCaptionStyle, ...style }
}

function glyphEm(character: string): number {
  if (/\s/u.test(character)) return 0.32
  if (/[ilI.,'!|:;]/u.test(character)) return 0.35
  if (/[MW@%]/u.test(character)) return 0.91
  return character.length === 1 && character.charCodeAt(0) <= 0x7f ? 0.66 : 1.02
}

/** Explicit wrapping shared by the preview and libass. Render review measures the actual glyphs. */
export function captionLayout(text: string, style: Required<CaptionStyle>) {
  const paddingX = Math.ceil(style.fontSize * 0.24) + style.outlineWidth
  const paddingY = Math.ceil(style.fontSize * 0.16) + style.outlineWidth
  const limit = CAPTION_WIDTH - 2 * (CAPTION_SAFE_X + paddingX)
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    let used = 0
    for (const glyph of paragraph) {
      const width = glyphEm(glyph) * style.fontSize
      if (line.trim() && used + width > limit) {
        const word = /(?:^|\s)([A-Za-z0-9-]+)$/.exec(line)
        if (word?.[1] && word.index > 0 && /[A-Za-z0-9-]/.test(glyph)) {
          lines.push(line.slice(0, word.index).trim())
          line = word[1]
          used = [...line].reduce(
            (sum, value) => sum + glyphEm(value) * style.fontSize,
            0,
          )
        } else {
          lines.push(line.trim())
          line = ''
          used = 0
        }
      }
      if (line || !/\s/u.test(glyph)) {
        line += glyph
        used += width
      }
    }
    lines.push(line.trim())
  }
  const textWidth = Math.max(
    ...lines.map((line) =>
      [...line].reduce(
        (sum, glyph) => sum + glyphEm(glyph) * style.fontSize,
        0,
      ),
    ),
  )
  const width = Math.min(
    CAPTION_WIDTH - 2 * CAPTION_SAFE_X,
    Math.ceil(textWidth + paddingX * 2),
  )
  const height = Math.ceil(lines.length * style.fontSize * 1.16 + paddingY * 2)
  return {
    lines,
    width,
    height,
    paddingY,
    x: Math.floor((CAPTION_WIDTH - width) / 2),
    y:
      style.position === 'top'
        ? CAPTION_SAFE_Y
        : CAPTION_HEIGHT - CAPTION_SAFE_Y - height,
  }
}

export function captionFrame(seconds: number): number {
  return Math.ceil(seconds * CAPTION_FPS - 1e-7)
}

function assTime(seconds: number): string {
  const centis = Math.floor((captionFrame(seconds) * 100) / CAPTION_FPS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${Math.floor(centis / 360000)}:${pad(Math.floor(centis / 6000) % 60)}:${pad(Math.floor(centis / 100) % 60)}.${pad(centis % 100)}`
}

function assColour(color: string, opacity = 1): string {
  const alpha = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, '0')
  return (
    '&H' + alpha + color.slice(5, 7) + color.slice(3, 5) + color.slice(1, 3)
  )
}

function literal(line: string) {
  return line
    .replace(/\\/g, '\\\u200b')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
}

/** The mask shares precisely the caption placement, but emits only white glyph ink. */
export function captionAss(
  cues: readonly SubtitleCue[],
  input?: CaptionStyle,
  mask = false,
): string {
  const style = resolveCaptionStyle(input)
  const ink = assColour(mask ? '#ffffff' : style.color)
  const outline = assColour(style.outlineColor)
  const box = assColour(style.backgroundColor, style.backgroundOpacity)
  const margin = CAPTION_SAFE_Y
  const styleRow = (
    name: string,
    color: string,
    border: string,
    thickness: number,
    align: number,
  ) =>
    `Style: ${name},${CAPTION_FONT},${style.fontSize},${color},${color},${border},&H00000000,0,0,0,0,100,100,0,0,1,${thickness},0,${align},${CAPTION_SAFE_X},${CAPTION_SAFE_X},${margin},1`
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${CAPTION_WIDTH}`,
    `PlayResY: ${CAPTION_HEIGHT}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleRow(
      'Caption',
      ink,
      outline,
      mask ? 0 : style.outlineWidth,
      style.position === 'top' ? 8 : 2,
    ),
    styleRow('Back', box, box, 0, 7),
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (const cue of cues) {
    const { start, end, text } = cue
    const timing = `${assTime(start)},${assTime(end)}`
    const layout = captionLayout(text, style)
    if (!mask && style.backgroundOpacity > 0) {
      const { x, y, width, height } = layout
      header.push(
        `Dialogue: 0,${timing},Back,,0,0,0,,{\\an7\\pos(${x},${y})\\p1}m 0 0 l ${width} 0 ${width} ${height} 0 ${height}{\\p0}`,
      )
    }
    const padding = style.backgroundOpacity > 0 ? layout.paddingY : 0
    const y =
      style.position === 'top'
        ? margin + padding
        : CAPTION_HEIGHT - margin - padding
    header.push(
      `Dialogue: 1,${timing},Caption,,0,0,0,,{\\pos(${CAPTION_WIDTH / 2},${y})}${layout.lines.map(literal).join('\\N')}`,
    )
  }
  return header.join('\n')
}
