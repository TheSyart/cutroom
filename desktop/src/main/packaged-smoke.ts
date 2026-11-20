import { existsSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
/** EX_USAGE: the smoke flag was given without a disposable state root. */
export const PACKAGED_SMOKE_REFUSED_EXIT = 64

/**
 * `fresh`: the full smoke on an empty state root. `upgrade` (REL-04): the
 * runner's second launch, on a copy of the 0.1.0-preview.4 fixture home.
 */
export type PackagedSmokeScenario = 'fresh' | 'upgrade'

export type PackagedSmokeLaunch =
  | { kind: 'none' }
  | { kind: 'run'; receiptPath: string; scenario: PackagedSmokeScenario }
  | { kind: 'refuse'; reason: string }

/**
 * The system's temporary directories, as real paths. Fixed per platform, not
 * read from TMPDIR, so the environment cannot widen them; Windows has no
 * fixed one and uses the TEMP directory.
 */
export function systemTempRoots(
  platform: NodeJS.Platform | string = process.platform,
): string[] {
  if (platform === 'darwin') return ['/private/tmp', '/private/var/folders']
  if (platform === 'linux') return ['/tmp', '/var/tmp', '/dev/shm']
  if (platform === 'win32') return [tmpdir()]
  return []
}

/**
 * MAIN-28: the production binary accepts `--emperor-packaged-smoke` only for
 * a state root inside the system temp directory, never the user's own
 * `~/.emperor`; anything else is refused before any state is touched (the
 * caller exits with PACKAGED_SMOKE_REFUSED_EXIT).
 */
export function packagedSmokeLaunch(
  argv: readonly string[],
  options: {
    readonly stateRoot: string
    readonly platform?: NodeJS.Platform | string
    /** The user's home from the account database, not $HOME. */
    readonly userHome?: string
  },
): PackagedSmokeLaunch {
  if (!argv.includes('--emperor-packaged-smoke')) return { kind: 'none' }
  let receiptPath: string
  let scenario: PackagedSmokeScenario
  try {
    ;({ receiptPath, scenario } = parsePackagedSmokeArgs(argv)!)
  } catch (error) {
    return { kind: 'refuse', reason: (error as Error).message }
  }
  if (!isAbsolute(options.stateRoot))
    return {
      kind: 'refuse',
      reason: 'packaged smoke state root is not absolute',
    }
  const stateRoot = realPathOfFuture(options.stateRoot)
  const temp = systemTempRoots(options.platform).map(realPathOfFuture)
  if (!temp.some((root) => strictlyInside(root, stateRoot)))
    return {
      kind: 'refuse',
      reason:
        'packaged smoke needs EMPEROR_CONFIG_DIR inside the system temp directory',
    }
  const home = realPathOfFuture(options.userHome ?? userInfo().homedir)
  if (containsPath(join(home, '.emperor'), stateRoot))
    return {
      kind: 'refuse',
      reason: "packaged smoke never runs on the user's own ~/.emperor",
    }
  return { kind: 'run', receiptPath, scenario }
}

/** realpath of the longest existing prefix, plus the part not created yet. */
function realPathOfFuture(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    rest.unshift(basename(existing))
    existing = parent
  }
  try {
    existing = realpathSync(existing)
  } catch {
    // Unreadable: compare the path as written.
  }
  return join(existing, ...rest)
}

function strictlyInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function parsePackagedSmokeArgs(
  argv: readonly string[],
): { receiptPath: string; scenario: PackagedSmokeScenario } | null {
  if (!argv.includes('--emperor-packaged-smoke')) return null
  const index = argv.indexOf('--emperor-smoke-receipt')
  const receiptPath = index >= 0 ? String(argv[index + 1] || '').trim() : ''
  if (!receiptPath || !isAbsolute(receiptPath))
    throw new Error('packaged smoke receipt path must be absolute')
  const scenarioIndex = argv.indexOf('--emperor-smoke-scenario')
  const scenario =
    scenarioIndex >= 0 ? String(argv[scenarioIndex + 1] || '') : 'fresh'
  if (scenario !== 'fresh' && scenario !== 'upgrade')
    throw new Error(`unknown packaged smoke scenario: ${scenario}`)
  return { receiptPath: resolve(receiptPath), scenario }
}

function containsPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
