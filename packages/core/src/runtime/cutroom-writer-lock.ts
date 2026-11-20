import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { canonicalProfilePath } from './cutroom-profile-paths'
import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'

/** Who holds a data directory, written beside the lock by the holder. */
export interface LockOwner {
  pid: number
  version: string
  startedAt: number
  packaged: boolean
  /** The holder's .app bundle (packaged builds), for 「切换到它」. */
  appPath: string | null
}

function ownerPath(lockPath: string): string {
  return `${lockPath}.owner.json`
}

/** Record this process as the holder (best effort; the lock itself is the truth). */
export function writeLockOwner(
  lock: StateDirectoryLock,
  owner: LockOwner,
): void {
  try {
    writeFileSync(ownerPath(lock.path), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    })
  } catch {
    // An unreadable owner only makes the busy message less specific.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The live holder recorded beside one of these lock files, if any. */
function readLockOwner(lockPaths: readonly string[]): LockOwner | undefined {
  for (const lockPath of lockPaths) {
    try {
      const raw = JSON.parse(
        readFileSync(ownerPath(lockPath), 'utf8'),
      ) as Partial<LockOwner>
      const pid = Number(raw.pid)
      if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) continue
      return {
        pid,
        version: String(raw.version ?? ''),
        startedAt: Number(raw.startedAt) || 0,
        packaged: raw.packaged === true,
        appPath:
          typeof raw.appPath === 'string' && raw.appPath.endsWith('.app')
            ? raw.appPath
            : null,
      }
    } catch {
      // Missing or malformed: try the next one.
    }
  }
  return undefined
}

export class StateDirectoryLockError extends Error {
  /** The Emperor holding the directory, when it recorded itself. */
  owner?: LockOwner

  constructor(
    readonly code: 'state_root_in_use' | 'state_root_lock_failed',
    readonly root: string,
    options?: ErrorOptions,
  ) {
    super(
      code === 'state_root_in_use'
        ? 'The data directory is already in use by another App.'
        : 'Unable to establish exclusive data directory ownership.',
      options,
    )
    this.name = 'StateDirectoryLockError'
  }
}

const closeTemporaryReservation = Symbol('close temporary profile reservation')

export class StateDirectoryLock {
  constructor(
    readonly root: string,
    readonly path: string,
    // Strongly retain the connection. There is deliberately no release API:
    // even other process exit hooks must run before the OS releases ownership.
    private readonly connections: readonly Database[],
  ) {}

  [closeTemporaryReservation](): void {
    for (const database of this.connections) database.close()
  }
}

/**
 * SQLite holds an OS file lock, not a lease based on PID, age or heartbeat.
 * Keep its exclusive transaction alive until the App process actually exits.
 * Never unlink the file: replacing its inode could admit two owners.
 */
export function acquireStateDirectoryLock(
  input: string,
  legacyRoot?: string | null,
  compatibilityWriter = false,
): StateDirectoryLock {
  const databases: Database[] = []
  /** Lock files tried, for reading the holder when one is busy. */
  const attempted: string[] = []
  let root = resolve(input)
  try {
    const snapshot = () => {
      const current = canonicalProfilePath(input)
      const targets = new Map<string, string>()
      const add = (dir: string, includeOld: boolean) => {
        const base = join(dirname(dir), `.${basename(dir)}`)
        targets.set(`${base}.cutroom-writer.sqlite`, dir)
        if (includeOld || existsSync(`${base}.emperor-writer.sqlite`))
          targets.set(`${base}.emperor-writer.sqlite`, dir)
      }
      add(current, compatibilityWriter)
      if (legacyRoot) add(canonicalProfilePath(legacyRoot), true)
      return { current, targets }
    }
    let observed = snapshot()
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite')
    const held = new Set<string>()
    let primaryPath = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const [path, target] of observed.targets) {
        if (held.has(path)) continue
        root = target
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error('Profile writer lock is a symlink')
        primaryPath ||= path
        attempted.push(path)
        try {
          closeSync(openSync(path, 'wx', 0o600))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const database = new DatabaseSync(path)
        databases.push(database)
        database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
        held.add(path)
      }
      // Another cooperating process can finish migration between canonical
      // discovery and acquisition. Claim its resulting identity as well.
      observed = snapshot()
      root = observed.current
      if ([...observed.targets.keys()].every((path) => held.has(path)))
        return new StateDirectoryLock(root, primaryPath, databases)
    }
    throw new Error(
      'Data directory identity changed repeatedly during acquisition',
    )
  } catch (cause) {
    // No state writer was started, so a failed multi-directory claim must
    // release every partial reservation before showing the recovery page.
    for (const database of databases) database.close()
    const busy =
      typeof cause === 'object' &&
      cause !== null &&
      'errcode' in cause &&
      Number(cause.errcode) === 5
    const error = new StateDirectoryLockError(
      busy ? 'state_root_in_use' : 'state_root_lock_failed',
      root,
      { cause },
    )
    if (busy) {
      const owner = readLockOwner(attempted)
      if (owner) error.owner = owner
    }
    throw error
  }
}

/** The source is only busy while making the snapshot. The destination stays locked for the full run. */
export function withPreviousCutroomWriterLock<T>(
  source: string,
  run: () => T,
): T {
  const reservation = acquireStateDirectoryLock(source, null, true)
  try {
    return run()
  } finally {
    reservation[closeTemporaryReservation]()
  }
}
