import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  assertCutroomProfilePath,
  cutroomProfilePaths,
} from '@emperor/core/host-capabilities'
import { moduleDirFromUrl } from './esm-path'

export type RootSource = 'explicit' | 'env' | 'default' | 'packaged'

export interface ResolvedConfig {
  runtimeRoot: string
  runtimeRootSource: RootSource
  stateRoot: string
  stateRootSource: RootSource
  configSource: 'file' | 'default'
}

export interface ResolveConfigOptions {
  argv?: string[]
  env?: Record<string, string | undefined>
  readFile?: (p: string) => string
  defaultRoot?: string
  forcedRuntimeRoot?: string
  inspectSettings?: boolean
}

const mainDir = moduleDirFromUrl(import.meta.url)

function defaultReadFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return undefined
}

function resolveRuntimeRoot(
  argv: string[],
  env: Record<string, string | undefined>,
  defaultRoot?: string,
  forcedRuntimeRoot?: string,
): { root: string; source: RootSource } {
  if (forcedRuntimeRoot) return { root: forcedRuntimeRoot, source: 'packaged' }
  const explicit = argValue(argv, '--root')
  if (explicit) return { root: explicit, source: 'explicit' }
  if (env.CUTROOM_ROOT) return { root: env.CUTROOM_ROOT, source: 'env' }
  if (env.VIDEO_EDIT_AGENT_ROOT)
    return { root: env.VIDEO_EDIT_AGENT_ROOT, source: 'env' }
  if (env.EMPEROR_AGENT_ROOT)
    return { root: env.EMPEROR_AGENT_ROOT, source: 'env' }
  if (defaultRoot) return { root: defaultRoot, source: 'default' }
  return { root: path.resolve(mainDir, '..', '..', '..'), source: 'default' }
}

/** Runtime resources and private state stay independent. The legacy variables
 * remain accepted for Emperor's own isolated test and helper scripts. */
function resolveStateRoot(env: Record<string, string | undefined>): {
  root: string
  source: RootSource
} {
  const override =
    env.CUTROOM_DATA_DIR ||
    env.VIDEO_EDIT_AGENT_DATA_DIR ||
    env.EMPEROR_CONFIG_DIR
  const root = override ? path.resolve(override) : cutroomProfilePaths().current
  assertCutroomProfilePath(root)
  return { root, source: override ? 'env' : 'default' }
}

export function resolveConfig({
  argv = [],
  env = {},
  readFile = defaultReadFile,
  defaultRoot,
  forcedRuntimeRoot,
  inspectSettings = true,
}: ResolveConfigOptions = {}): ResolvedConfig {
  const { root: runtimeRoot, source: runtimeRootSource } = resolveRuntimeRoot(
    argv,
    env,
    defaultRoot,
    forcedRuntimeRoot,
  )
  if (runtimeRootSource === 'env' || runtimeRootSource === 'explicit')
    assertCutroomProfilePath(runtimeRoot)
  const { root: stateRoot, source: stateRootSource } = resolveStateRoot(env)

  let configSource: 'file' | 'default' = 'default'
  if (inspectSettings)
    try {
      JSON.parse(readFile(path.join(stateRoot, 'settings.json')))
      configSource = 'file'
    } catch {
      // Missing or malformed settings.json must not crash the shell; we
      // silently continue with the packaged Core runtime defaults.
      configSource = 'default'
    }

  return {
    runtimeRoot,
    runtimeRootSource,
    stateRoot,
    stateRootSource,
    configSource,
  }
}
