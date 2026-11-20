import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { EmperorError } from '../errors'
import { writeTextAtomic } from '../store/atomic-json'

export const editingBriefFile = 'editing-brief.md'
const line = z.string().trim().min(1).max(500)
export const projectBriefSchema = z
  .object({
    goal: line,
    mustKeep: z.array(line).max(20),
    cutRules: line,
    pacing: line,
    picture: line,
    audio: line,
    captions: line,
  })
  .strict()
export type ProjectBrief = z.infer<typeof projectBriefSchema>

export const savedEditingBriefSchema = z
  .object({
    revision: z.number().int().positive(),
    markdown: z.string().min(1).max(40_000),
  })
  .strict()
export type SavedEditingBrief = z.infer<typeof savedEditingBriefSchema>

export function projectBriefMarkdown(brief: ProjectBrief): string {
  const sections = [
    ['成片目标', brief.goal],
    ['必留内容', brief.mustKeep.map((item) => `- ${item}`).join('\n')],
    ['剪辑取舍', brief.cutRules],
    ['节奏', brief.pacing],
    ['画面', brief.picture],
    ['原声', brief.audio],
    ['字幕', brief.captions],
  ]
  return (
    [
      '# 剪辑思路',
      ...sections
        .filter(([, value]) => value)
        .map(([title, value]) => `## ${title}\n\n${value}`),
    ].join('\n\n') + '\n'
  )
}

function digest(revision: number, markdown: string): string {
  return createHash('sha256').update(`${revision}\n${markdown}`).digest('hex')
}

export async function readEditingBrief(
  root: string,
): Promise<SavedEditingBrief | null> {
  const file = join(root, editingBriefFile)
  const info = await lstat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (!info) return null
  if (!info.isFile() || info.size > 160_000)
    throw new EmperorError('剪辑思路文件不可读取。', 'editing_brief_invalid')
  const text = await readFile(file, 'utf8')
  const marker = /^<!-- cutroom-brief (\d+) ([a-f0-9]{64}) -->\n/.exec(text)
  const brief =
    marker &&
    savedEditingBriefSchema.safeParse({
      revision: Number(marker[1]),
      markdown: text.slice(marker[0].length),
    })
  if (
    !brief ||
    !brief.success ||
    marker![2] !== digest(brief.data.revision, brief.data.markdown)
  )
    throw new EmperorError(
      '剪辑思路文件与已确认版本不一致。',
      'editing_brief_invalid',
    )
  return brief.data
}

export async function saveEditingBrief(
  root: string,
  previous: SavedEditingBrief | undefined,
  next: SavedEditingBrief,
): Promise<void> {
  const readCurrent = () => readEditingBrief(root)
  const assertPrevious = (current: SavedEditingBrief | null) => {
    if (
      current?.revision !== previous?.revision ||
      current?.markdown !== previous?.markdown
    )
      throw new EmperorError(
        '工程剪辑思路已更新，请重新核对最新版本。',
        'editing_brief_conflict',
      )
  }
  const current = await readCurrent()
  if (current?.revision === next.revision && current.markdown === next.markdown)
    return
  assertPrevious(current)
  const checksum = digest(next.revision, next.markdown)
  await writeTextAtomic(
    join(root, editingBriefFile),
    `<!-- cutroom-brief ${next.revision} ${checksum} -->\n${next.markdown}`,
    {
      mode: 0o600,
      beforeCommit: async () => assertPrevious(await readCurrent()),
    },
  )
}
