import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { EmperorError } from '../errors'
import { writeJsonAtomic } from '../store/atomic-json'

export { sourceFileFingerprint } from './workspace-inputs'

const filename = 'source-notes.json'
const maxFileBytes = 16 * 1024 * 1024
const maxPageBytes = 32 * 1024
const maxNotes = 4_000
const projectLocks = new Map<string, Promise<unknown>>()
const id = z.string().min(1).max(128)
const timestamp = z.number().finite().min(0).max(86_400)
const fingerprint = z.string().min(1).max(4_500)
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0)
const interval = z.object({ start: timestamp, end: timestamp })
const range = (value: { start: number; end: number }) => value.end > value.start

export const sourceNoteInputSchema = interval
  .extend({
    assetId: id,
    provenance: z.enum(['observed', 'user-provided', 'inference']),
    observation: text(1_000),
    action: text(500).optional(),
    scene: text(500).optional(),
    userQuote: text(500).optional(),
    speechHighlights: z
      .array(
        interval
          .extend({ text: text(500) })
          .strict()
          .refine(range),
      )
      .max(8)
      .optional(),
    retakes: z
      .array(
        interval
          .extend({ assetId: id, relationship: text(300) })
          .strict()
          .refine(range),
      )
      .max(8)
      .optional(),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['frame', 'transcript', 'audio']),
            id: z.string().min(1).max(256),
            assetId: id.optional(),
            start: timestamp.optional(),
            end: timestamp.optional(),
          })
          .strict()
          .refine(
            (evidence) =>
              (evidence.end ?? Infinity) >= (evidence.start ?? -Infinity),
          ),
      )
      .max(16)
      .optional(),
  })
  .strict()
  .refine((note) => range(note) || (note.start === 0 && note.end === 0))
  .refine(
    (note) =>
      note.speechHighlights?.every(
        (highlight) =>
          highlight.start >= note.start && highlight.end <= note.end,
      ) ?? true,
    { message: '原声摘录必须位于这条记录的源素材时间范围内。' },
  )
  .refine(
    (note) => note.provenance !== 'observed' || Boolean(note.evidence?.length),
    { message: '已观察记录必须引用画面或转写证据。' },
  )

const writeSchema = sourceNoteInputSchema.safeExtend({
  fingerprint,
  relatedFingerprints: z.record(id, fingerprint).optional(),
})
const noteSchema = writeSchema.safeExtend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
})
const storeSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: id,
    notes: z.array(noteSchema).max(maxNotes),
  })
  .strict()

export type SourceNoteInput = z.input<typeof sourceNoteInputSchema>
export type SourceNoteWrite = z.input<typeof writeSchema>
export type SourceNote = z.infer<typeof noteSchema>
type SourceNotesStore = z.infer<typeof storeSchema>

export const sourceNoteQuerySchema = z
  .object({
    assetId: id.optional(),
    start: timestamp.optional(),
    end: timestamp.optional(),
    limit: z.number().int().min(1).max(24).default(12),
    offset: z.number().int().min(0).max(maxNotes).default(0),
    status: z.enum(['current', 'pendingReview']).optional(),
    provenance: z.enum(['observed', 'user-provided', 'inference']).optional(),
  })
  .strict()
  .refine((query) => (query.end ?? Infinity) > (query.start ?? -Infinity))

export type SourceNoteQuery = z.input<typeof sourceNoteQuerySchema>
export interface SourceNotePendingReview {
  id: string
  assetId: string
  start: number
  end: number
  affectedAssetIds: string[]
}

async function load(
  projectId: string,
  path: string,
): Promise<SourceNotesStore> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (!file) return { schemaVersion: 1, projectId, notes: [] }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxFileBytes)
      throw new TypeError('Invalid source notes file size or type')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > maxFileBytes)
        throw new TypeError('Source notes file exceeds size limit')
      chunks.push(chunk)
    }
    const store = storeSchema.parse(
      JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')),
    )
    if (store.projectId !== projectId)
      throw new TypeError('Source notes project does not match')
    return store
  } catch (cause) {
    if (!(
      cause instanceof SyntaxError ||
      cause instanceof z.ZodError ||
      cause instanceof TypeError
    ))
      throw cause
    throw new EmperorError(
      '无法读取素材识别记录，请检查工程根目录的 source-notes.json。',
      'invalid_source_notes',
    )
  } finally {
    await file.close()
  }
}

export async function saveSourceNotes(
  projectId: string,
  root: string,
  input: readonly SourceNoteWrite[],
): Promise<SourceNote[]> {
  const proposed = z.array(writeSchema).min(1).max(24).parse(input)
  const path = join(await realpath(root), filename)
  const before = projectLocks.get(path) ?? Promise.resolve()
  const operation = before
    .catch(() => {})
    .then(async () => {
      const store = await load(projectId, path)
      const existing = new Map(store.notes.map((note) => [note.id, note]))
      const results = proposed.map((note) => {
        const relatedIds = [
          ...new Set(note.retakes?.map((retake) => retake.assetId)),
        ]
          .filter((assetId) => assetId !== note.assetId)
          .sort()
        const relatedEntries = relatedIds.map((assetId) => {
          const related = note.relatedFingerprints
          const signature =
            related && Object.hasOwn(related, assetId)
              ? related[assetId]
              : undefined
          if (!signature)
            throw new EmperorError(
              '重录关系涉及的源素材缺少已核验的文件指纹。',
              'source_note_asset_unavailable',
            )
          return [assetId, signature] as const
        })
        const normalized = {
          ...note,
          relatedFingerprints: relatedEntries.length
            ? Object.fromEntries(relatedEntries)
            : undefined,
        }
        const id = createHash('sha256')
          .update(JSON.stringify(normalized))
          .digest('hex')
        const stored = existing.get(id)
        if (stored) return stored
        const record = {
          ...normalized,
          id,
          createdAt: new Date().toISOString(),
        }
        existing.set(id, record)
        return record
      })
      if (existing.size !== store.notes.length) {
        const data = { ...store, notes: [...existing.values()] }
        if (
          existing.size > maxNotes ||
          Buffer.byteLength(JSON.stringify(data, null, 2)) + 1 > maxFileBytes
        ) {
          throw new EmperorError(
            '这个工程的素材识别记录已达到存储上限。',
            'source_notes_limit',
          )
        }
        await writeJsonAtomic(path, data, { mode: 0o600 })
      }
      return results
    })
  projectLocks.set(path, operation)
  try {
    return await operation
  } finally {
    if (projectLocks.get(path) === operation) projectLocks.delete(path)
  }
}

export async function readSourceNotes(
  projectId: string,
  root: string,
  fingerprints: Readonly<Record<string, string>>,
  input: SourceNoteQuery = {},
): Promise<{
  notes: SourceNote[]
  pendingReview: SourceNotePendingReview[]
  hasMore: boolean
  nextOffset?: number
}> {
  const query = sourceNoteQuerySchema.parse(input)
  const store = await load(projectId, join(await realpath(root), filename))
  const matching = store.notes
    .filter(
      (note) =>
        (query.assetId === undefined || note.assetId === query.assetId) &&
        (query.provenance === undefined ||
          note.provenance === query.provenance) &&
        (query.start === undefined ||
          (note.start === note.end
            ? note.end >= query.start
            : note.end > query.start)) &&
        (query.end === undefined || note.start < query.end),
    )
    .sort(
      (a, b) =>
        a.assetId.localeCompare(b.assetId) ||
        a.start - b.start ||
        a.end - b.end,
    )
    .map((note) => ({
      note,
      affectedAssetIds: affectedAssets(note, fingerprints),
    }))
    .filter(
      ({ affectedAssetIds }) =>
        query.status === undefined ||
        (affectedAssetIds.length === 0
          ? query.status === 'current'
          : query.status === 'pendingReview'),
    )
  const notes: SourceNote[] = []
  const pendingReview: SourceNotePendingReview[] = []
  let offset = query.offset
  let bytes = 0
  for (const { note, affectedAssetIds } of matching.slice(
    query.offset,
    query.offset + query.limit,
  )) {
    const pending = {
      id: note.id,
      assetId: note.assetId,
      start: note.start,
      end: note.end,
      affectedAssetIds,
    }
    const size = Buffer.byteLength(
      JSON.stringify(affectedAssetIds.length ? pending : note),
    )
    if (offset > query.offset && bytes + size > maxPageBytes) break
    bytes += size
    offset++
    if (affectedAssetIds.length) pendingReview.push(pending)
    else notes.push(note)
  }
  const hasMore = offset < matching.length
  return {
    notes,
    pendingReview,
    hasMore,
    nextOffset: hasMore ? offset : undefined,
  }
}

function affectedAssets(
  note: SourceNote,
  fingerprints: Readonly<Record<string, string>>,
): string[] {
  const recorded = {
    ...note.relatedFingerprints,
    [note.assetId]: note.fingerprint,
  }
  return Object.keys(recorded).filter(
    (assetId) =>
      !Object.hasOwn(fingerprints, assetId) ||
      fingerprints[assetId] !== recorded[assetId],
  )
}

export async function currentObservedSourceIds(
  projectId: string,
  root: string,
  fingerprints: Readonly<Record<string, string>>,
): Promise<Set<string>> {
  const store = await load(projectId, join(await realpath(root), filename))
  return new Set(
    store.notes
      .filter(
        (note) =>
          note.provenance === 'observed' &&
          affectedAssets(note, fingerprints).length === 0,
      )
      .map((note) => note.assetId),
  )
}
