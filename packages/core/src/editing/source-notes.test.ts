import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  currentObservedSourceIds,
  readSourceNotes,
  saveSourceNotes,
  sourceFileFingerprint,
} from './source-notes'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'video-source-notes-')))
})
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('project-local source notes', () => {
  const original = {
    assetId: 'take-a',
    fingerprint: 'original-a',
    start: 12,
    end: 16,
    provenance: 'observed' as const,
    observation: '片头说完后抬手。',
    action: '抬手',
    scene: '近景口播',
    speechHighlights: [{ start: 12.1, end: 13, text: '这个工具。' }],
    retakes: [
      { assetId: 'take-b', start: 2, end: 4, relationship: '改为完整讲法' },
    ],
    relatedFingerprints: { 'take-b': 'original-b' },
    evidence: [
      {
        kind: 'frame' as const,
        id: 'frame-1',
        assetId: 'take-a',
        start: 12,
        end: 16,
      },
    ],
  }

  it('stores evidence and provenance in the project root, with idempotent concurrent saves', async () => {
    await Promise.all([
      saveSourceNotes('project', root, [original]),
      saveSourceNotes('project', root, [
        original,
        {
          assetId: 'take-a',
          fingerprint: 'original-a',
          start: 19,
          end: 22,
          provenance: 'user-provided',
          observation: '保留演示结尾。',
          userQuote: '保留演示结尾',
        },
      ]),
    ])
    const stored = JSON.parse(
      await readFile(join(root, 'source-notes.json'), 'utf8'),
    )
    expect(stored).toMatchObject({
      projectId: 'project',
      notes: [
        original,
        {
          provenance: 'user-provided',
          userQuote: '保留演示结尾',
        },
      ],
    })
    const page = await readSourceNotes(
      'project',
      root,
      { 'take-a': 'original-a' },
      { assetId: 'take-a', start: 16, end: 20 },
    )
    expect(page.notes.map((note) => note.observation)).toEqual([
      '保留演示结尾。',
    ])
  })

  it('moves only notes attached to changed assets or related retakes into pending review', async () => {
    await saveSourceNotes('project', root, [
      { ...original, relatedFingerprints: { 'take-b': 'original-b' } },
      {
        ...original,
        assetId: 'take-b',
        fingerprint: 'original-b',
        retakes: undefined,
      },
      {
        ...original,
        assetId: 'take-c',
        fingerprint: 'original-c',
        retakes: undefined,
      },
    ])
    const page = await readSourceNotes('project', root, {
      'take-a': 'original-a',
      'take-b': 'replacement-b',
      'take-c': 'original-c',
    })
    expect(page.notes.map((note) => note.assetId)).toEqual(['take-c'])
    expect(
      page.pendingReview.map(({ assetId, affectedAssetIds }) => ({
        assetId,
        affectedAssetIds,
      })),
    ).toEqual([
      { assetId: 'take-a', affectedAssetIds: ['take-b'] },
      { assetId: 'take-b', affectedAssetIds: ['take-b'] },
    ])
    await expect(
      currentObservedSourceIds('project', root, {
        'take-a': 'original-a',
        'take-b': 'replacement-b',
        'take-c': 'original-c',
      }),
    ).resolves.toEqual(new Set(['take-c']))
  })

  it('bounds result pages and validates source-relative intervals', async () => {
    await expect(
      saveSourceNotes('project', root, [
        {
          ...original,
          speechHighlights: [{ start: 9, end: 11, text: 'wrong source time' }],
        },
      ]),
    ).rejects.toThrow()
    await saveSourceNotes('project', root, [
      original,
      { ...original, start: 20, end: 22, speechHighlights: undefined },
    ])
    const first = await readSourceNotes(
      'project',
      root,
      { 'take-a': 'original-a', 'take-b': 'original-b' },
      { limit: 1 },
    )
    const second = await readSourceNotes(
      'project',
      root,
      { 'take-a': 'original-a', 'take-b': 'original-b' },
      { limit: 1, offset: 1 },
    )
    expect(first).toMatchObject({ notes: [{ start: 12 }], hasMore: true })
    expect(second).toMatchObject({ notes: [{ start: 20 }], hasMore: false })
  })

  it('finds a current observation after stale records and includes stills at source time zero', async () => {
    const zero = {
      ...original,
      start: 0,
      end: 0,
      speechHighlights: undefined,
      retakes: undefined,
    }
    await saveSourceNotes('project', root, [
      zero,
      { ...zero, fingerprint: 'replacement-a' },
    ])
    const page = await readSourceNotes(
      'project',
      root,
      { 'take-a': 'replacement-a' },
      {
        assetId: 'take-a',
        start: 0,
        end: 10,
        limit: 1,
        status: 'current',
      },
    )
    expect(page).toMatchObject({
      notes: [{ fingerprint: 'replacement-a', start: 0, end: 0 }],
      pendingReview: [],
      hasMore: false,
    })
  })

  it('detects in-place replacement with restored file length and modification time', async () => {
    const path = join(root, 'take.mov')
    await writeFile(path, 'original')
    await utimes(path, 1_800_000_000, 1_800_000_000)
    const before = await stat(path, { bigint: true })
    const identity = await sourceFileFingerprint(root, 'take.mov')
    await writeFile(path, 'replaced')
    await utimes(path, 1_800_000_000, 1_800_000_000)
    const after = await stat(path, { bigint: true })
    expect([after.size, after.ino, after.mtimeNs]).toEqual([
      before.size,
      before.ino,
      before.mtimeNs,
    ])
    expect(await sourceFileFingerprint(root, 'take.mov')).not.toBe(identity)
  })
})
