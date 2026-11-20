import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { EmperorError } from '../errors'
import { writeJsonAtomic } from '../store/atomic-json'
import { probeMedia } from './analysis/media-process'
import type { VideoAsset, VideoProjectResult } from './types'

const kinds = new Map<string, VideoAsset['kind']>([
  ...['.mp4', '.mov', '.m4v', '.webm'].map((ext) => [ext, 'video'] as const),
  ...['.png', '.jpg', '.jpeg', '.webp', '.gif'].map(
    (ext) => [ext, 'image'] as const,
  ),
  ...['.wav', '.m4a', '.mp3', '.aac', '.flac', '.ogg'].map(
    (ext) => [ext, 'audio'] as const,
  ),
])
const referenceExts = new Set(['.txt', '.md', '.srt', '.vtt'])
const receiptFolder = '.cutroom'
const receiptFile = `${receiptFolder}/output-receipts.json`
const receiptLocks = new Map<string, Promise<unknown>>()
const receiptSchema = z.object({
  projectId: z.string().min(1).max(128),
  outputs: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        fingerprint: z.string().min(1).max(4500),
      }),
    )
    .max(2000),
})

export interface WorkspaceMediaCandidate {
  path: string
  kind: VideoAsset['kind']
  displayName: string
}

export interface WorkspaceMediaInventory {
  sources: VideoAsset[]
  outputs: WorkspaceMediaCandidate[]
  unresolved: WorkspaceMediaCandidate[]
}

export async function workspaceInputs(
  root: string,
  limit = 1000,
): Promise<string[]> {
  const files: string[] = []
  const pending = [{ path: '', depth: 0 }]
  let inspected = 0
  while (pending.length && files.length < limit && inspected < 12_000) {
    const { path, depth } = pending.shift()!
    const absolute = resolve(root, path)
    if (absolute !== root && !(await safeWorkspaceFile(root, path, true)))
      continue
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++inspected > 12_000 || files.length >= limit) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const relative = path ? `${path}/${entry.name}` : entry.name
      if (entry.isDirectory() && depth < 6)
        pending.push({ path: relative, depth: depth + 1 })
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (kinds.has(ext) || referenceExts.has(ext)) files.push(relative)
    }
  }
  return files
}

export async function safeWorkspaceFile(
  root: string,
  path: string,
  directory = false,
): Promise<string | null> {
  const absolute = resolve(root, path)
  if (!absolute.startsWith(`${root}${sep}`)) return null
  try {
    const info = await lstat(absolute)
    if (!(directory ? info.isDirectory() : info.isFile())) return null
    return (await realpath(absolute)) === absolute ? absolute : null
  } catch (cause) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (cause as NodeJS.ErrnoException).code ?? '',
      )
    )
      return null
    throw cause
  }
}

export async function sourceFileFingerprint(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = await safeWorkspaceFile(root, path)
  if (!absolute) return undefined
  const info = await lstat(absolute, { bigint: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    },
  )
  if (!info?.isFile() || !info.size) return undefined
  return JSON.stringify([
    path,
    String(info.size),
    String(info.mtimeNs),
    String(info.ino),
    String(info.ctimeNs),
  ])
}

export function editingReferences(files: readonly string[]): string[] {
  return files
    .filter((file) => referenceExts.has(extname(file).toLowerCase()))
    .slice(0, 100)
}

async function outputReceipts(root: string, projectId: string) {
  const path = await safeWorkspaceFile(root, receiptFile)
  if (!path || (await lstat(path)).size > 12 * 1024 * 1024) return []
  const raw: unknown = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  const data = receiptSchema.safeParse(raw)
  return data.success && data.data.projectId === projectId
    ? data.data.outputs
    : []
}

/** Records the exact in-workspace file produced by the explicit export action. */
export async function recordWorkspaceOutput(
  snapshot: VideoProjectResult,
  absolutePath: string,
): Promise<void> {
  const root = await realpath(snapshot.projectPath)
  const path = relative(root, absolutePath).split(sep).join('/')
  if (
    !path ||
    path.startsWith('../') ||
    path === '..' ||
    path.split('/').some((part) => part.startsWith('.'))
  )
    return
  const before = receiptLocks.get(root) ?? Promise.resolve()
  const operation = before
    .catch(() => {})
    .then(async () => {
      const fingerprint = await sourceFileFingerprint(root, path)
      if (!fingerprint) return
      const directory = join(root, receiptFolder)
      await mkdir(directory, { recursive: true })
      if (!(await safeWorkspaceFile(root, receiptFolder, true)))
        throw new EmperorError(
          '无法记录工程内的已导出文件。',
          'output_receipt_unavailable',
        )
      const existing = await outputReceipts(root, snapshot.project.projectId)
      const outputs = [
        ...existing.filter((output) => output.path !== path),
        { path, fingerprint },
      ].slice(-2000)
      await writeJsonAtomic(
        join(root, receiptFile),
        { projectId: snapshot.project.projectId, outputs },
        { mode: 0o600 },
      )
    })
  receiptLocks.set(root, operation)
  try {
    await operation
  } finally {
    if (receiptLocks.get(root) === operation) receiptLocks.delete(root)
  }
}

async function legacyReviewSizes(root: string): Promise<Map<number, string[]>> {
  const folder = `${receiptFolder}/precision`
  const directory = await safeWorkspaceFile(root, folder, true)
  const filesBySize = new Map<number, string[]>()
  if (!directory) return filesBySize
  const runs = await readdir(directory, { withFileTypes: true })
  for (const run of runs
    .filter(
      (entry) => entry.isDirectory() && /^[a-f\d-]{36}$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40)) {
    const runPath = `${folder}/${run.name}`
    const current = await safeWorkspaceFile(root, runPath, true)
    if (!current) continue
    const entries = await readdir(current, { withFileTypes: true })
    const reviews = entries
      .filter((entry) => entry.isFile() && /^review-\d+\.mp4$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
    for (const review of reviews.slice(0, 24)) {
      const path = await safeWorkspaceFile(root, `${runPath}/${review.name}`)
      if (!path) continue
      const { size } = await lstat(path)
      if (size > 0)
        filesBySize.set(size, [...(filesBySize.get(size) ?? []), path])
    }
  }
  return filesBySize
}

async function digestFile(
  path: string,
  size: number,
): Promise<string | undefined> {
  try {
    const hash = createHash('sha256')
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.size !== BigInt(size)) return undefined
    for await (const chunk of createReadStream(path, { end: size - 1 }))
      hash.update(chunk)
    const after = await lstat(path, { bigint: true })
    if (after.ino !== before.ino || after.ctimeNs !== before.ctimeNs)
      return undefined
    return hash.digest('hex')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    return undefined
  }
}

export async function workspaceMediaInventory(
  snapshot: VideoProjectResult,
): Promise<WorkspaceMediaInventory> {
  const root = await realpath(snapshot.projectPath)
  const sources = snapshot.project.assets
  const registered = new Set(sources.map((asset) => resolve(root, asset.path)))
  const [files, storedOutputs, legacyReviews] = await Promise.all([
    workspaceInputs(root),
    outputReceipts(root, snapshot.project.projectId),
    legacyReviewSizes(root),
  ])
  const receipts = new Map(
    storedOutputs.map((output) => [output.path, output.fingerprint]),
  )
  const outputHashes = new Map<string, string | undefined>()
  const outputs: WorkspaceMediaCandidate[] = []
  const unresolved: WorkspaceMediaCandidate[] = []
  let comparisonBytes = 512 * 1024 * 1024
  for (const path of files) {
    const kind = kinds.get(extname(path).toLowerCase())
    if (!kind || registered.has(resolve(root, path))) continue
    const absolute = await safeWorkspaceFile(root, path)
    if (!absolute) continue
    const candidate = { path, kind, displayName: basename(path) }
    const fingerprint = receipts.get(path)
    let isOutput =
      Boolean(fingerprint) &&
      fingerprint === (await sourceFileFingerprint(root, path))
    if (!isOutput && kind === 'video') {
      const { size } = await lstat(absolute)
      const matches = legacyReviews.get(size)
      if (matches && size <= comparisonBytes) {
        comparisonBytes -= size
        const hash = await digestFile(absolute, size)
        for (const match of matches) {
          if (!hash) break
          if (!outputHashes.has(match)) {
            if (size > comparisonBytes) continue
            comparisonBytes -= size
            outputHashes.set(match, await digestFile(match, size))
          }
          isOutput = hash === outputHashes.get(match)
          if (isOutput) break
        }
      }
    }
    // Receipts and matching review bytes identify previous renders.
    if (isOutput) outputs.push(candidate)
    else unresolved.push(candidate)
  }
  return { sources, outputs, unresolved }
}

export async function discoverWorkspaceMedia(
  snapshot: VideoProjectResult,
  ffmpegPath: string,
  selectedPaths: readonly string[] = [],
): Promise<VideoAsset[]> {
  const paths = [...new Set(selectedPaths)]
  if (!paths.length) return []
  const projectPath = await realpath(snapshot.projectPath)
  const { unresolved, sources } = await workspaceMediaInventory(snapshot)
  const candidates = new Map(unresolved.map((item) => [item.path, item]))
  if (
    paths.length + sources.length > 2_000 ||
    paths.some((path) => !candidates.has(path))
  )
    throw new EmperorError(
      '请选择素材清单中待确认的文件。',
      'invalid_workspace_source_selection',
    )
  const assets: VideoAsset[] = []
  for (let index = 0; index < paths.length; index += 4) {
    const batch = await Promise.all(
      paths
        .slice(index, index + 4)
        .map(async (path): Promise<VideoAsset | null> => {
          const file = await safeWorkspaceFile(projectPath, path)
          if (!file) return null
          const { kind, displayName } = candidates.get(path)!
          const media = await probeMedia(ffmpegPath, file).catch(() => null)
          if (!media) return null
          if (kind !== 'image' && (!media.duration || media.duration > 86_400))
            return null
          if (kind !== 'audio' && !media.video) return null
          if (kind === 'audio' && !media.audio) return null
          return {
            id: `workspace-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`,
            kind,
            path,
            displayName,
            duration: kind === 'image' ? null : media.duration,
            width: media.video?.width ?? null,
            height: media.video?.height ?? null,
          }
        }),
    )
    assets.push(...batch.filter((asset) => asset !== null))
  }
  if (assets.length !== paths.length)
    throw new EmperorError(
      '有已选择的素材无法读取，请检查文件后重试。',
      'workspace_source_unavailable',
    )
  return assets
}
