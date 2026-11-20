import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { EmperorError } from '../errors'

export const cacheKinds = [
  'proxies',
  'thumbnails',
  'waveforms',
  'frames',
] as const
type CacheKind = (typeof cacheKinds)[number]
const opaqueHash = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const kinds = new Set<string>(cacheKinds)
const projectKey = /^[a-f0-9]{64}$/
const mediaName = /^[a-f0-9]{64}\.(?:mp4|jpg|json)$/

type MediaBinding = {
  sessionId: string
  projectId: string
  assetId: string
  file: string
  source: string
  signature: string
}

export type CacheUsage = {
  bytes: number
  files: number
  removedBytes: number
  removedFiles: number
  skipped: number
  byKind: Record<CacheKind, number>
}

export class EditingMediaCache {
  readonly profileRoot: string
  private readonly writing = new Map<string, number>()
  private readonly handles = new Map<
    string,
    MediaBinding & { players: Map<string, number> }
  >()
  private readonly byFile = new Map<string, string>()

  constructor(
    stateRoot: string,
    base = process.env.CUTROOM_CACHE_DIR ||
      join(homedir(), 'Library', 'Caches', 'com.video-edit-agent.desktop'),
  ) {
    this.profileRoot = join(resolve(base), opaqueHash(resolve(stateRoot)))
  }

  async directory(project: string, kind: CacheKind): Promise<string> {
    const key = opaqueHash(await realpath(project))
    // Resolve the OS cache parent before creating any managed child.
    const base = dirname(this.profileRoot)
    await mkdir(base, { recursive: true, mode: 0o700 })
    if (!(await lstat(base)).isDirectory())
      throw new Error('媒体缓存根目录无效。')
    const profile = join(await realpath(base), basename(this.profileRoot))
    let current = profile
    for (const entry of [
      profile,
      join(profile, key),
      join(profile, key, kind),
    ]) {
      await mkdir(entry, { mode: 0o700 }).catch(
        (cause: NodeJS.ErrnoException) => {
          if (cause.code !== 'EEXIST') throw cause
        },
      )
      if (
        !(await lstat(entry)).isDirectory() ||
        (await realpath(entry)) !== entry
      )
        throw new Error('媒体缓存目录无效。')
      current = entry
    }
    return current
  }

  begin(file: string) {
    this.writing.set(file, (this.writing.get(file) ?? 0) + 1)
    return () => {
      const count = (this.writing.get(file) ?? 1) - 1
      if (count) this.writing.set(file, count)
      else this.writing.delete(file)
    }
  }

  handle(binding: MediaBinding): string {
    const key = JSON.stringify(binding)
    const previous = this.byFile.get(key)
    if (previous) return previous
    if (this.handles.size >= 4096) {
      for (const [oldKey, oldId] of this.byFile) {
        const old = this.handles.get(oldId)
        if (old && this.busy(old.file)) continue
        this.byFile.delete(oldKey)
        this.handles.delete(oldId)
        break
      }
    }
    const id = randomBytes(16).toString('hex')
    this.byFile.set(key, id)
    this.handles.set(id, { ...binding, players: new Map() })
    return id
  }

  resolveHandle(sessionId: string, id: string) {
    const entry = this.handles.get(id)
    if (!entry || entry.sessionId !== sessionId)
      throw new EmperorError(
        '预览地址已失效，请重新加载。',
        'preview_unavailable',
      )
    return entry
  }

  playback(sessionId: string, id: string, player: string, active: boolean) {
    const entry = this.resolveHandle(sessionId, id)
    if (active) entry.players.set(player, Date.now() + 90_000)
    else entry.players.delete(player)
  }

  busy(file: string): boolean {
    if (this.writing.has(file)) return true
    for (const entry of this.handles.values()) {
      if (entry.file !== file) continue
      for (const [player, expires] of entry.players) {
        if (expires > Date.now()) return true
        entry.players.delete(player)
      }
    }
    return false
  }

  async usage(clear = false): Promise<CacheUsage> {
    const usage: CacheUsage = {
      bytes: 0,
      files: 0,
      removedBytes: 0,
      removedFiles: 0,
      skipped: 0,
      byKind: { proxies: 0, thumbnails: 0, waveforms: 0, frames: 0 },
    }
    const inProgress = clear ? new Set(this.writing.keys()) : new Set<string>()
    let profile: string
    try {
      const base = dirname(this.profileRoot)
      if (
        !(await lstat(base)).isDirectory() ||
        !(await lstat(this.profileRoot)).isDirectory()
      )
        return usage
      profile = await realpath(this.profileRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return usage
      throw error
    }
    for (const project of await readdir(profile, { withFileTypes: true })) {
      if (!project.isDirectory() || !projectKey.test(project.name)) continue
      const projectDir = join(profile, project.name)
      for (const group of await readdir(projectDir, { withFileTypes: true })) {
        if (!group.isDirectory() || !kinds.has(group.name)) continue
        const dir = join(projectDir, group.name)
        if ((await realpath(dir)) !== dir) continue
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !mediaName.test(entry.name)) continue
          const file = join(dir, entry.name)
          const info = await lstat(file).catch(
            (cause: NodeJS.ErrnoException) => {
              if (cause.code !== 'ENOENT') throw cause
              return null
            },
          )
          if (!info?.isFile()) continue
          if (clear && !this.busy(file)) {
            await unlink(file).catch((cause: NodeJS.ErrnoException) => {
              if (cause.code !== 'ENOENT') throw cause
            })
            usage.removedFiles++
            usage.removedBytes += info.size
          } else {
            if (clear) {
              usage.skipped++
              inProgress.delete(file)
            }
            usage.files++
            usage.bytes += info.size
            usage.byKind[group.name as CacheKind] += info.size
          }
        }
      }
    }
    usage.skipped += inProgress.size
    return usage
  }
}
