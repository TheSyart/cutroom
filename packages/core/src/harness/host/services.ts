/** Cutroom bootstraps the profile, project sessions, memory, skills and model configuration here. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { loadLocalConfig } from '../../config/local-config'
import { loadModelConfig, type ModelConfig } from '../../config/model-config'

import { MemoryStore } from '../../memory/store'
import { TokenTracker } from '../../memory/token-tracker'

import { ProjectStore } from '../../projects/store'
import {
  bootstrapEmperorHome,
  runPendingDataMigrations,
} from '../../runtime/installation'
import { cutroomProfilePaths } from '../../runtime/cutroom-profile-paths'
import { migrateCutroomProfile } from '../../runtime/cutroom-profile-migration'
import { acquireStateDirectoryLock } from '../../runtime/cutroom-writer-lock'
import {
  ensureRuntimeStateDirs,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../../runtime/paths'
import {
  createLocalKeySealer,
  type SecretSealer,
} from '../../security/secret-sealer'

import { ensureUserProfileFile } from '../../sessions/onboarding'
import { SessionStore } from '../../sessions/store'
import type { WebFetchClient } from '../../network/web-fetch-client'
import { SkillChangeDetector } from '../../skills/change-detector'
import { SkillLoaders, type FileSkillsLoader } from '../../skills/file-loader'
import { SkillInstallService } from '../../skills/install'
import { SkillLibrary } from '../../skills/library'
import { SkillManager } from '../../skills/manager'

/** Marks a sessions directory written by the harness kernel. */
export const HARNESS_SESSIONS_MARKER = '.harness-kernel-v1'

/**
 * The harness kernel starts with fresh sessions: a sessions directory from
 * the previous kernel is moved aside (never deleted) to
 * `sessions.legacy-<timestamp>` on first start.
 */
export function archiveLegacySessions(sessionsRoot: string): string | null {
  if (existsSync(`${sessionsRoot}/${HARNESS_SESSIONS_MARKER}`)) return null
  let archived: string | null = null
  const hasSessions =
    existsSync(sessionsRoot) &&
    readdirSync(sessionsRoot).some(
      (name) =>
        name !== '.scratch' || readdirSync(join(sessionsRoot, name)).length > 0,
    )
  if (hasSessions) {
    archived = `${sessionsRoot}.legacy-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(sessionsRoot, archived)
  }
  mkdirSync(sessionsRoot, { recursive: true })
  writeFileSync(
    `${sessionsRoot}/${HARNESS_SESSIONS_MARKER}`,
    `${new Date().toISOString()}\n`,
  )
  return archived
}

export interface KeptServicesOptions {
  root: string
  stateRoot?: string | null
  stateRootSource?: 'explicit' | 'env' | 'default' | null
  templatesDir?: string | null
  emperorHomePrepared?: boolean
  appVersion?: string
  runtimeRevision?: string
  legacyRuntimeRoot?: string | null
  legacyRuntimeSkillsHandled?: boolean
  /** Host public-HTTPS client (Skill URL imports). */
  webFetchClient?: WebFetchClient | null
  /**
   * Seals model API keys at rest (SEC-06). The desktop main
   * process passes one over its `LocalSecretStore`; when absent,
   * Core uses its own implementation over the same key file.
   */
  secretSealer?: SecretSealer | null
}

export interface KeptServices {
  paths: RuntimePaths
  root: string
  templatesDir: string
  /** Where pre-harness sessions were moved on first start, if any. */
  archivedLegacySessions: string | null
  localConfig: Awaited<ReturnType<typeof loadLocalConfig>>
  /** The one sealer for `model_config.json` and `mcp_config.json` secrets. */
  secretSealer: SecretSealer
  modelConfig: ModelConfig
  sessionStore: SessionStore
  projectStore: ProjectStore
  tokenTracker: TokenTracker
  sharedMemory: MemoryStore
  skillManager: SkillManager
  skillInstallService: SkillInstallService
  /** Per-project Skill loaders (one per project root; `forProject(null)` = chat). */
  skillLoaders: SkillLoaders
  /** The chat (no project) loader, for project-independent views. */
  skillsLoader: FileSkillsLoader
  /** Skill writes shared by the Skill API and the `skill_manage` tool. */
  skillLibrary: SkillLibrary
  skillChangeDetector: SkillChangeDetector
}

export interface KeptServiceHooks {
  /** Host event sink (non-session events: scheduler, MCP, environment, skills). */
  emit(event: Record<string, unknown>): Promise<void> | void
}

export async function createKeptServices(
  opts: KeptServicesOptions,
  hooks: KeptServiceHooks,
): Promise<KeptServices> {
  const paths = resolveRuntimePaths(opts.root, {
    stateRoot: opts.stateRoot ?? null,
    stateRootSource: opts.stateRootSource ?? null,
    templatesDir: opts.templatesDir ?? null,
  })
  // runtimeRoot holds bundled read-only resources (in dev it is the repo, in
  // headless ACP the cwd), so it is never created here; only Emperor Home is.
  const root = paths.runtimeRoot
  if (!opts.emperorHomePrepared) {
    const previous =
      paths.stateRootSource === 'default'
        ? cutroomProfilePaths().previous
        : null
    if (previous) {
      const lock = acquireStateDirectoryLock(paths.stateRoot)
      process.once('exit', () => {
        void lock.root
      })
    }
    migrateCutroomProfile(paths.stateRoot, previous)
    bootstrapEmperorHome({
      emperorHome: paths.stateRoot,
      source: paths.stateRootSource,
      legacyHome: null,
      appVersion: opts.appVersion ?? '0.0.0-headless',
      runtimeRevision: opts.runtimeRevision ?? 'cutroom',
    })
    await runPendingDataMigrations(paths.stateRoot, {
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    })
  }
  ensureRuntimeStateDirs(paths)
  const localConfig = await loadLocalConfig(paths.stateRoot, {
    preserveCorrupt: false,
  })
  const templatesDir = paths.templatesDir
  const userFile = ensureUserProfileFile(paths.stateRoot, templatesDir)
  const sharedMemory = new MemoryStore(paths.memoryRoot, userFile, {
    memoryTemplate: existsSync(join(templatesDir, 'init', 'MEMORY.md'))
      ? join(templatesDir, 'init', 'MEMORY.md')
      : null,
  })
  const secretSealer =
    opts.secretSealer ?? createLocalKeySealer(paths.stateRoot)
  const modelConfig = await loadModelConfig(paths.stateRoot, {
    create: true,
    sealer: secretSealer,
  })
  const archivedLegacySessions = archiveLegacySessions(paths.sessionsRoot)
  const sessionStore = new SessionStore(paths.stateRoot)
  const projectStore = new ProjectStore(paths.stateRoot, {
    versions: sharedMemory.versions,
  })
  const tokenTracker = new TokenTracker(paths.tokensFile)
  const skillManager = new SkillManager({
    runtimeRoot: root,
    stateRoot: paths.stateRoot,
  })
  const skillInstallService = new SkillInstallService({
    manager: skillManager,
    stateRoot: paths.stateRoot,
  })
  const skillLoaders = new SkillLoaders({
    runtimeRoot: root,
    stateRoot: paths.stateRoot,
  })
  const skillsLoader = skillLoaders.forProject(null)
  const skillChangeDetector = new SkillChangeDetector(
    [paths.userSkillsRoot],
    async ({ catalogVersion }) => {
      await hooks.emit({
        event: 'skill_catalog_changed',
        catalog_version: catalogVersion,
      })
    },
  )
  const skillLibrary = new SkillLibrary({
    loaders: skillLoaders,
    fetchClient: () => opts.webFetchClient ?? null,
    onChanged: () => {
      skillChangeDetector.notify()
    },
  })
  return {
    paths,
    root,
    templatesDir,
    archivedLegacySessions,
    localConfig,
    secretSealer,
    modelConfig,
    sessionStore,
    sharedMemory,
    projectStore,
    tokenTracker,
    skillManager,
    skillInstallService,
    skillLoaders,
    skillsLoader,
    skillLibrary,
    skillChangeDetector,
  }
}
