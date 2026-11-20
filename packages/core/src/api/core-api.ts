import { timelineLayout } from '../editing/timeline'
/** Desktop facade for Cutroom projects, conversations, model configuration and editing resources. */
import { realpathSync, statSync } from 'node:fs'

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import type { SubmittedReference } from '../harness/host/message-references'
import type { AttachmentStore } from '../attachments/store'
import {
  filePreviewResult,
  previewCanonicalFile,
  type FilePreviewInput,
  type FilePreviewResult,
  type FileStatInput,
  type FileStatResult,
} from '../workspace/file-preview'
import type { RuntimePaths } from '../runtime/paths'
import { HarnessHost, type HarnessHostOptions } from '../harness/host/host'

import {
  SessionRequiredError,
  type BackgroundTurnOptions,
  type BackgroundTurnOutcome,
  type ViewScope,
} from '../harness/host/scope'
import type { UiAnswers } from '../harness/host/interactions'

import { LOG_FILE } from '../session-log/store'
import { readUtf8Page, type ResultPage } from '../harness/tools/spill'
import type { SessionEvent } from '../session-log/types'
import {
  sanitizeForWire,
  type SessionHistoryPage,
} from '../session-log/history'
import type {
  SessionLineage,
  SubagentChildView,
} from '../harness/host/session-views'

import { CoreMutationGuardError } from './mutation-guard'
import {
  ChatService,
  InvalidSessionError,
  type DraftSessionInput,
} from './chat-service'
import {
  CoreConfigService,
  type UserConfigPayload,
} from './services/config-service'

import {
  CoreSessionDefaultsService,
  type SessionDefaults,
} from './services/session-defaults-service'
import type { SessionPermission } from '../config/local-config'

import { CoreMemoryService } from './services/memory-service'
import {
  CoreModelService,
  type ModelConnectionInput,
  type ModelDiscoveryInput,
} from './services/model-service'
import { CoreSkillService } from './services/skill-service'

import { logger } from '../util/log'

import { CoreSessionApplicationService } from './services/session-application-service'

import type { DataVersionsReport } from '../storage/data-files'
import { searchSessionLogs, type SessionSearchHit } from '../sessions/search'

import {
  CoreCommandApplicationService,
  type CommandPlanSwitchOutcome,
} from './services/command-application-service'
import type { WebFetchClient } from '../network/web-fetch-client'

import {
  WorkspaceFilesService,
  type WorkspaceFileReadResult,
} from '../workspace/files'

import { VideoProjectService } from '../editing/project-store'
import { VideoAnalysisService } from '../editing/analysis/service'
import type { EditRunService } from '../editing/edit-run'
import { importLegacyDeepSeek } from './services/legacy-model-import'

import { WorkspaceOperationError } from '../workspace/common'
import { WorkspaceReferenceService } from '../workspace/references'
import {
  WorkspaceMediaGrants,
  workspaceMediaUrl,
  type MediaGrant,
} from '../workspace/media-grants'
import {
  enrichFilePreview,
  PreviewConverter,
  type EnrichedPreview,
  type PreviewToolRunner,
} from '../workspace/preview-convert'

import { CommandPlatform, type CommandOwner } from '../commands/platform'
import { SessionTransitionService } from '../commands/session-transition'

import type {
  CommandCompletion,
  CommandInvocationResult,
  CommandInvocationSource,
} from '../commands/types'

type Dict = Record<string, unknown>

export interface CoreApiCreateOptions extends HarnessHostOptions {
  renderMotionFrame?: import('../editing/motion-export').RenderMotionFrame
  validateMotionFrame?(
    scene: import('../editing/motion').MotionScene,
    frame: number,
    signal?: AbortSignal,
  ): Promise<void>
  /**
   * Desktop: the original Agent Home whose saved DeepSeek models are imported
   * once into this profile. Null/absent: no import.
   */
  legacyModelHome?: string | null
  /** Test hook: use an existing host instead of creating one. */
  host?: HarnessHost | null
  appVersion?: string
  runtimeRevision?: string
  /** Host public HTTP client used by Skill imports and reference previews. */
  webFetchClient?: WebFetchClient | null
  /** Where the host writes its logs (REL-01); diagnostics show it. */
  logDirectory?: string | null
  /** Test hook: runs sips, qlmanage, textutil and osascript (BUG-10). */
  previewTools?: PreviewToolRunner | null
  /** Test hook: the platform the preview converters believe they are on. */
  previewPlatform?: NodeJS.Platform
}

export interface CoreRuntimeEventPayload {
  event: string
  [key: string]: unknown
}

export interface CoreRuntimeReplayPayload {
  sessionId: string
  afterSeq: number
  latestSeq: number
  format: 'projection'
  events: CoreRuntimeEventPayload[]
  [key: string]: unknown
}

/** A Task-panel row: a background job, a subagent session, or a workflow run. */
export interface CoreTaskRecord {
  id: string
  kind: 'job' | 'subagent' | 'workflow' | 'external-agent'
  delegation_id?: string
  backend?: string
  model?: string
  capabilities?: import('../harness/delegation/types').ExecutorCapabilities
  acceptance?: import('../harness/delegation/types').DelegationRunRecord['acceptance']
  receipt_id?: string
  usage?: import('../harness/delegation/types').DelegationRunRecord['usage']
  workspace_summary?: string
  recoverable?: boolean
  revision?: number
  job_kind?: string
  label: string
  description: string
  status: string
  session_id: string
  owner_id: string | null
  started_at: number
  finished_at: number | null
  exit_code?: number | null
  detail?: string | null
  depth?: number
  mode?: string
  last_stop_reason?: string | null
  /** Workflow runs: which tool started the run. */
  workflow_tool?: 'workflow' | 'ralph'
  /** Workflow runs: accepted `agent()` calls (Ralph: rounds started). */
  rounds?: number
  current_phase?: string | null
  call_id?: string | null
  agents?: Array<{
    seq: number
    label: string
    phase: string | null
    child_id: string
    outcome: string | null
  }>
  result?: string | null
}

export class CoreApi {
  readonly root: string

  readonly paths: RuntimePaths

  readonly host: HarnessHost

  readonly attachmentStore: AttachmentStore

  readonly chatService: ChatService

  readonly configService: CoreConfigService

  readonly sessionDefaultsService: CoreSessionDefaultsService

  readonly memoryService: CoreMemoryService

  readonly modelService: CoreModelService

  readonly skillService: CoreSkillService

  readonly workspaceFilesService: WorkspaceFilesService

  readonly videoProject: VideoProjectService

  readonly videoAnalysis: VideoAnalysisService

  private videoEditRunService?: Promise<EditRunService>

  readonly workspaceReferenceService: WorkspaceReferenceService

  private readonly mediaGrants = new WorkspaceMediaGrants()

  private readonly previewConverter: PreviewConverter

  private closePromise?: Promise<void>

  readonly sessionApplicationService: CoreSessionApplicationService

  private readonly appVersion: string

  readonly commandApplicationService: CoreCommandApplicationService

  readonly sessionTransitionService: SessionTransitionService

  readonly commandPlatform: CommandPlatform

  private readonly renderMotionFrame?: CoreApiCreateOptions['renderMotionFrame']

  private constructor(
    root: string,
    host: HarnessHost,
    opts: CoreApiCreateOptions,
  ) {
    this.renderMotionFrame = opts.renderMotionFrame
    this.root = resolve(root)
    this.host = host
    const kept = host.kept
    this.paths = kept.paths
    this.attachmentStore = host.attachments
    this.chatService = new ChatService(host)
    this.configService = new CoreConfigService(
      this.paths.stateRoot,
      {},
      { templatesDir: kept.templatesDir },
    )
    this.sessionDefaultsService = new CoreSessionDefaultsService(this.root, {
      stateRoot: this.paths.stateRoot,
      host,
    })
    this.modelService = new CoreModelService(this.paths.stateRoot, {
      sealer: kept.secretSealer,
      refreshModelConfig: () => host.refreshModelConfig(),
    })
    this.memoryService = new CoreMemoryService({
      stateRoot: this.paths.stateRoot,
      sharedMemory: kept.sharedMemory,
      projectStore: kept.projectStore,
      tokenTracker: kept.tokenTracker,
      sessionStore: kept.sessionStore,
      sessionLog: (sessionId) => host.sessionLog(sessionId),
      compactNow: (sessionId) => host.compactNow(sessionId),
      measureContext: (sessionId) => host.measureContext(sessionId),
    })
    this.skillService = new CoreSkillService(this.paths.stateRoot, {
      runtimeRoot: this.paths.runtimeRoot,
      manager: kept.skillManager,
      installService: kept.skillInstallService,
      toolNames: (sessionId) =>
        host
          .toolSchemasFor(sessionId ? host.scopeFor(sessionId) : null)
          .map((schema) => ({
            ...schema,
            category: host.toolCategory(schema.name),
          })),
      library: kept.skillLibrary,
      // `null` = chat (no project Skills); callers always name the session.
      projectRootFor: (sessionId) => host.projectRootForSession(sessionId),
    })
    this.appVersion = opts.appVersion ?? '0.0.0-dev'
    const resolveWorkspaceProject = (sessionId: string) => {
      const session = this.requireReadableSession(sessionId, 'workspace') as {
        id: string
        mode?: string | null
        project_path?: string | null
        project_name?: string | null
        title?: string | null
      }
      if (session.mode !== 'build' || !session.project_path)
        throw new WorkspaceOperationError(
          'workspace_project_required',
          '当前会话没有绑定 Build 项目。',
        )
      return {
        sessionId: session.id,
        projectRoot: resolve(session.project_path),
        projectName:
          String(session.project_name ?? session.title ?? '').trim() ||
          session.project_path.split(/[\\/]/).pop() ||
          '项目',
      }
    }
    this.previewConverter = new PreviewConverter({
      cacheDir: join(this.paths.stateRoot, 'cache', 'previews'),
      ...(opts.previewTools ? { run: opts.previewTools } : {}),
      ...(opts.previewPlatform ? { platform: opts.previewPlatform } : {}),
    })
    this.workspaceFilesService = new WorkspaceFilesService({
      resolveProject: resolveWorkspaceProject,
    })
    this.workspaceReferenceService = new WorkspaceReferenceService({
      resolveProject: resolveWorkspaceProject,
      resolveFileRoot: (sessionId) =>
        this.host.sessionWorkspaceRoot(
          this.requireReadableLogSession(sessionId, 'references.resolve'),
        ),
      authorizeSession: (sessionId) => {
        this.requireReadableLogSession(sessionId, 'references.preview')
      },
      webFetchClient: opts.webFetchClient ?? null,
      resolveAttachment: (attachmentId) => {
        const attachment = this.attachmentStore.get(attachmentId)
        return attachment
          ? {
              root: this.attachmentStore.base,
              relativePath: relative(
                this.attachmentStore.base,
                resolve(this.attachmentStore.root, attachment.rel_path),
              ),
              label: attachment.name,
            }
          : null
      },
    })
    this.sessionApplicationService = new CoreSessionApplicationService({
      sessions: kept.sessionStore,
      resolveProject: (projectPath) =>
        kept.projectStore.resolve(projectPath) as unknown as Dict,
      unloadSession: (sessionId) => host.unloadSession(sessionId),
      forgetSessionTree: (sessionId, dir) =>
        host.forgetSessionTree(sessionId, join(dir, LOG_FILE)),
      stopSession: (sessionId) => {
        host.stop(sessionId)
      },
      activateSession: (sessionId) => this.activateSession(sessionId),
    })
    this.videoAnalysis = new VideoAnalysisService({
      stateRoot: this.paths.stateRoot,
      sealer: kept.secretSealer,
    })
    this.videoProject = new VideoProjectService({
      stateRoot: this.paths.stateRoot,
      grantPreview: ({ sessionId, file, source }) =>
        workspaceMediaUrl(
          this.mediaGrants.grant({
            sessionId,
            absPath: file,
            filePath: source,
            streamable: true,
            mimeType: file.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
          }).token,
        ),
      validateMotionFrame: opts.validateMotionFrame,
      getSession: (sessionId) => kept.sessionStore.get(sessionId),
      analysis: this.videoAnalysis,
      editRuns: () => this.videoEditRuns(),
      currentTurn: (sessionId) => host.currentMotionTurn(sessionId),
      onMotionWork: (sessionId, work) =>
        host.emitHost({
          event: 'video_motion_work',
          session_id: sessionId,
          work,
        }),
      onMotionCommit: ({ sessionId, project }) =>
        host.emitHost({
          event: 'video_project_changed',
          session_id: sessionId,
          revision: project.revision,
          totalDuration: timelineLayout(project).totalDuration,
        }),
      onAnalysisProgress: (event) =>
        host.emitHost({
          event: 'video_project_analysis',
          session_id: event.sessionId,
          asset_id: event.assetId,
          stage: event.stage,
          progress: event.progress,
        }),
      createBuildSession: (projectPath, title) =>
        this.sessionApplicationService.create({
          title,
          mode: 'build',
          project_path: projectPath,
        }),
      // A workspace session may be opened before its first message: open its
      // runtime log now, or sessions.history sees no session log.
      ensureSession: (sessionId) => {
        host.agentFor(sessionId)
      },
    })
    host.installVideoProjectTools(this.videoProject)
    this.sessionTransitionService = new SessionTransitionService({
      stateRoot: this.paths.stateRoot,
      sessions: kept.sessionStore,
      assertBoundary: (sessionId) => this.assertClearBoundary(sessionId),
      runSessionEnd: async (sessionId) => {
        host.stop(sessionId)
      },
      activate: (sessionId) => this.activateSession(sessionId),
      permissionPresetOf: (sessionId) => {
        const session = host.sessionLog(sessionId)
        if (session === undefined) return null
        const preset = host.presets.current(session.events)
        return host.presets.names.includes(preset) ? preset : null
      },
      applyPermissionPreset: (sessionId, preset) => {
        host.setPermissionPreset(sessionId, preset)
      },
    })
    this.commandApplicationService = new CoreCommandApplicationService({
      models: this.modelService,
      sessionTransitions: this.sessionTransitionService,
      getSession: (sessionId) => kept.sessionStore.get(sessionId),
      skillsForSession: (sessionId) =>
        this.skillService.list({ sessionId }).skills,
      // A draft's session will be Build on its project or Chat (FIX-14),
      // as `materializeSession` creates it.
      skillsForDraft: (draft) =>
        this.skillService.listForProject(
          host.projectRootFor({
            mode: draft.mode === 'build' ? 'build' : 'chat',
            project_path: draft.project?.project_path ?? null,
          }),
        ).skills,
      // Prompts held after a failed or stopped turn wait for the user; they
      // do not make the session busy.
      sessionBusy: (sessionId) =>
        host.isBusy(sessionId) ||
        host
          .queuedPrompts(sessionId)
          .some((prompt) => prompt.state === 'queued'),
      compact: (sessionId) => host.compactNow(sessionId),
      stop: (sessionId) => host.stop(sessionId),
      activateModel: async (entryId, sessionId) =>
        await this.model.activate({ entryId }, { sessionId }),
      setReasoningEffort: async (entryId, reasoningEffort, sessionId) =>
        await this.model.setReasoningEffort(
          { entryId, reasoningEffort },
          { sessionId },
        ),
      setPermissionPreset: (sessionId, preset) =>
        host.setPermissionPreset(sessionId, preset),
      presets: () => host.presets.options(),
      controlPayload: (sessionId) => host.controlPayload(sessionId),
      setPlanMode: (sessionId, active) =>
        host.setPlanMode(sessionId, active) as CommandPlanSwitchOutcome,
      submitPrompt: async (input) =>
        await this.chat.submit({ ...input, attachments: input.attachmentIds }),
    })
    this.commandPlatform = new CommandPlatform({
      stateRoot: this.paths.stateRoot,
      listSkills: (sessionId) =>
        this.commandApplicationService.skillsForSession(sessionId),
      listDraftSkills: (draft) =>
        this.commandApplicationService.skillsForDraft(draft),
      sessionContext: async (sessionId) =>
        await this.commandApplicationService.sessionContext(sessionId),
      isBusy: (sessionId) =>
        this.commandApplicationService.sessionBusy(sessionId),
      executeBuiltin: async (context) =>
        await this.commandApplicationService.executeBuiltin(context),
      submitSkill: async (context) =>
        await this.commandApplicationService.submitSkill(context),
      queueAfterTurn: async ({ sessionId, requestId, run }) => {
        // After-turn commands wait for the session's agent to go idle.
        const agent = host.agentFor(sessionId)
        void agent
          .whenIdle()
          .then(run)
          .catch(() => undefined)
        return requestId
      },
      completeDynamic: async (descriptor, rawArgs, cursor, sessionId) =>
        await this.commandApplicationService.complete(
          descriptor.name,
          rawArgs,
          cursor,
          sessionId,
        ),
    })
  }
  static async create(opts: CoreApiCreateOptions): Promise<CoreApi> {
    const root = resolve(opts.root)
    const host = opts.host ?? (await HarnessHost.create(opts))
    let api: CoreApi | null = null
    try {
      api = new CoreApi(root, host, opts)
      if (opts.legacyModelHome) {
        try {
          const imported = await importLegacyDeepSeek({
            legacyHome: opts.legacyModelHome,
            stateRoot: api.paths.stateRoot,
            sealer: api.host.kept.secretSealer,
          })
          if (imported.imported.length > 0) await host.refreshModelConfig()
        } catch (error) {
          logger.warn('legacy DeepSeek import failed', {
            error: String(error),
          })
        }
      }
      await api.sessionTransitionService.recover()
      return api
    } catch (error) {
      if (api) await api.close().catch(() => {})
      else await host.close().catch(() => {})
      throw error
    }
  }

  flushAll(): void {
    this.host.sessions.flush(undefined, { sync: true })
  }

  forceStop(): void {
    for (const sessionId of this.host.busySessions()) this.host.stop(sessionId)
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      await this.videoEditRunService?.then(
        (runs) => runs.dispose(),
        () => undefined,
      )
      this.flushAll()
      await this.host.close()
    })()
    return this.closePromise
  }

  async bootstrap(opts: { sessionId?: string | null } = {}) {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (sessionId)
      this.activateSession(
        this.requireReadableSession(sessionId, 'bootstrap').id,
      )
    const kept = this.host.kept
    // The UI's starting state is the session it shows (KRN-01: besides
    // activateSession, the only reader of it).
    const focused = this.focusedSessionId
    const activeSessionId =
      focused !== null && kept.sessionStore.get(focused) ? focused : null
    const view: ViewScope = { sessionId: activeSessionId }
    const sessionDiagnostics = kept.sessionStore.diagnostics()
    const route = this.host.llm.activeRoute()
    const replay =
      activeSessionId && kept.sessionStore.get(activeSessionId)
        ? this.runtime.replay({ sessionId: activeSessionId })
        : { events: [], latestSeq: 0 }
    return {
      app: 'Cutroom',
      /** The session this bootstrap describes: the one the UI shows (null: none). */
      sessionId: activeSessionId,
      sessionIndexSource: sessionDiagnostics.sessionIndexSource,
      repairedSessions: sessionDiagnostics.repairedSessions,
      model: route?.modelId ?? '',
      provider: route?.catalogProvider ?? '',
      providerLabel: route?.displayName ?? '',
      tools: this.skills.tools(view),
      ...(() => {
        const catalog = this.skills.list({ sessionId: activeSessionId })
        return { skills: catalog.skills, invalidSkills: catalog.invalid }
      })(),
      memory: this.memory.get(view),
      modelConfig: await this.model.getConfig(),
      control: this.control.get(activeSessionId),
      context_used: kept.tokenTracker.lastInputTokensValue(),
      unarchivedHistory: this.memoryService.historyPayload(),
      runtime: {
        events: replay.events,
        latestSeq: replay.latestSeq,
        busy: this.host.isBusy(activeSessionId),
        active_tasks: this.activeTaskInfos(),
        stats: this.runtimeStats(activeSessionId),
      },
      projects: this.projects.list(),
    }
  }

  private videoEditRuns(): Promise<EditRunService> {
    this.videoEditRunService ??= import('../editing/precision-runtime')
      .then(({ installPrecisionEditing }) =>
        installPrecisionEditing({
          host: this.host,
          renderMotionFrame: this.renderMotionFrame,
          projects: this.videoProject,
          analysis: this.videoAnalysis,
          stateRoot: this.paths.stateRoot,
        }),
      )
      .catch((error: unknown) => {
        this.videoEditRunService = undefined
        throw error
      })
    return this.videoEditRunService
  }

  readonly chat = {
    submit: async (opts: {
      content: string
      displayContent?: string | null
      clientMessageId?: string | null
      sessionId?: string | null
      uiHidden?: boolean | null
      delivery?: 'queue' | 'interject' | null
      clientDraftId?: string | null
      draftSession?: DraftSessionInput | null
      attachments?: string[] | null
      requestedSkills?: Array<{ name: string; source?: string }> | null
      references?: SubmittedReference[] | null
      /** In-process adapters only; IPC validation never accepts AbortSignal objects. */
      signal?: AbortSignal | null
      /** Trusted in-process adapter provenance. Browser IPC remains `chat`. */
      source?: string | null
      /** In-process adapters only: this session's UI events during the submit. */
      emit?: ((event: Record<string, unknown>) => void | Promise<void>) | null
      /** In-process adapters only: discard the prompt if no turn takes it. */
      unconsumed?: 'keep' | 'withdraw' | null
      /** Accepted for adapter compatibility; turn ids are assigned by the kernel. */
      turnId?: string | null
    }) =>
      await this.chatService.submit({
        content: String(opts.content ?? ''),
        displayContent: opts.displayContent ?? null,
        clientMessageId: opts.clientMessageId ?? null,
        sessionId: opts.sessionId ?? null,
        uiHidden: opts.uiHidden ?? false,
        delivery: opts.delivery ?? 'queue',
        clientDraftId: opts.clientDraftId ?? null,
        draftSession: opts.draftSession ?? null,
        attachmentIds: opts.attachments ?? null,
        requestedSkills: opts.requestedSkills ?? null,
        references: opts.references ?? null,
        signal: opts.signal ?? null,
        source: opts.source ?? 'chat',
        emit: opts.emit ?? null,
        unconsumed: opts.unconsumed ?? null,
      }),
    listQueuedPrompts: (opts: { sessionId: string }) =>
      this.chatService.listQueuedPrompts(opts),
    manageQueuedPrompt: (opts: {
      sessionId: string
      promptId: string
      action: 'cancel' | 'interject' | 'send'
    }) => this.chatService.manageQueuedPrompt(opts),
    /** Stop a task, or the turn of the named session (KRN-01: never a default). */
    stopRuntime: async (
      opts: {
        taskId?: string | null
        kind?: string | null
        sessionId?: string | null
      } = {},
    ) => {
      const sessionId = String(opts.sessionId ?? '').trim()
      if (!sessionId) throw new SessionRequiredError('chat.stopRuntime')
      const cancelled = this.host.stop(sessionId) ? 1 : 0
      return { cancelled, active: this.activeTaskInfos() }
    },
    /**
     * In-process adapters (ACP): one background turn in the named session,
     * which keeps its own scope and never moves the session in view.
     */
    runBackground: async (
      input: { sessionId: string; content: string } & BackgroundTurnOptions,
    ): Promise<BackgroundTurnOutcome> => {
      const session = this.requireReadableSession(
        String(input.sessionId ?? '').trim(),
        `${input.source}.runBackground`,
      ) as { id: string; transitioned_to_session_id?: string | null }
      if (session.transitioned_to_session_id)
        throw new InvalidSessionError(
          `${input.source}.runBackground cannot append to transitioned session ${session.id}`,
          session.id,
        )
      return await this.host.runBackgroundTurn(
        this.host.scopeFor(session.id),
        String(input.content ?? ''),
        input,
      )
    },
  }

  readonly commands = {
    list: (
      input: CommandOwner & {
        includeUnavailable?: boolean
        invocationSource?: CommandInvocationSource
      },
    ) => this.commandPlatform.list(input),
    complete: (
      input: CommandOwner & {
        commandId: string
        rawArgs: string
        cursor: number
        invocationSource: CommandInvocationSource
      },
    ): Promise<CommandCompletion[]> => this.commandPlatform.complete(input),
    invoke: (input: {
      sessionId: string
      commandId: string
      rawInput: string
      invocationId: string
      invocationSource: CommandInvocationSource
      attachments?: string[]
      references?: SubmittedReference[]
    }): Promise<CommandInvocationResult> => this.commandPlatform.invoke(input),
  }

  readonly runtime = {
    replay: (
      opts: {
        sessionId?: string | null
        afterSeq?: number | string | null
        after_seq?: number | string | null
        limit?: number | string | null
        /** Accepted for compatibility; the session log has no archive or compaction split. */
        includeArchive?: boolean | string | null
        compact?: boolean | string | null
        format?: 'projection' | null
      } = {},
    ): CoreRuntimeReplayPayload => {
      if (!String(opts.sessionId ?? '').trim())
        throw new SessionRequiredError('runtime.replay')
      const sessionId = this.requireReadableSessionId(
        opts.sessionId,
        'runtime.replay',
      )
      const afterSeq = normalizedNonNegativeNumber(
        opts.afterSeq ?? opts.after_seq ?? 0,
      )
      const limit = normalizedPositiveNumber(opts.limit ?? null)
      const replay = this.host.replay(sessionId, afterSeq)
      const events =
        limit === null ? replay.events : replay.events.slice(-limit)
      return {
        sessionId,
        afterSeq,
        latestSeq: replay.latestSeq,
        format: 'projection',
        events: events as CoreRuntimeEventPayload[],
      }
    },
  }

  readonly config = {
    get: (): UserConfigPayload => this.configService.getUserConfig(),
    save: async (
      body: { content?: unknown } | string | undefined,
      _view: ViewScope,
    ): Promise<UserConfigPayload> => {
      const content =
        typeof body === 'string' ? body : String(body?.content ?? '')
      return this.configService.saveUserConfig(content)
    },
  }

  readonly attachments = {
    save: (opts: { raw: Buffer | Uint8Array; name: string; mime: string }) =>
      this.attachmentStore.save(opts),
    rawPath: (attachmentId: string) => {
      const ref = this.attachmentStore.get(attachmentId)
      return ref
        ? { path: join(this.attachmentStore.root, ref.rel_path), ref }
        : null
    },
  }

  readonly model = {
    getConfig: async () => this.modelService.getConfig(),
    resolveProfile: (
      input: Parameters<CoreModelService['resolveProfile']>[0],
    ) => this.modelService.resolveProfile(input),
    saveEntry: async (
      entry: Parameters<CoreModelService['saveEntry']>[0],
      _view: ViewScope,
    ) => {
      return this.modelService.saveEntry(entry)
    },
    saveEntries: async (
      input: Parameters<CoreModelService['saveEntries']>[0],
      _view: ViewScope,
    ) => {
      return this.modelService.saveEntries(input)
    },
    updateConnection: async (
      input: Parameters<CoreModelService['updateConnection']>[0],
      _view: ViewScope,
    ) => {
      return this.modelService.updateConnection(input)
    },
    refreshMetadata: async (
      input: Parameters<CoreModelService['refreshMetadata']>[0],
      _view: ViewScope,
    ) => {
      // A preview only reads; applying writes the file.
      return this.modelService.refreshMetadata(input)
    },
    replaceEntry: async (
      input: Parameters<CoreModelService['replaceEntry']>[0],
      _view: ViewScope,
    ) => {
      return this.modelService.replaceEntry(input)
    },
    lookupDefaults: (
      input: Parameters<CoreModelService['lookupDefaults']>[0],
    ) => this.modelService.lookupDefaults(input),
    discardRejected: async ({ key }: { key: string }, _view: ViewScope) => {
      return this.modelService.discardRejected(key)
    },
    savePolicy: async (
      policy: Parameters<CoreModelService['savePolicy']>[0],
      _view: ViewScope,
    ) => {
      return this.modelService.savePolicy(policy)
    },
    deleteEntry: async ({ entryId }: { entryId: string }, _view: ViewScope) => {
      return this.modelService.deleteEntry(entryId)
    },
    activate: async ({ entryId }: { entryId: string }, _view: ViewScope) => {
      return this.modelService.activate(entryId)
    },
    setReasoningEffort: async (
      {
        entryId,
        reasoningEffort,
      }: {
        entryId: string
        reasoningEffort: string | null
      },
      _view: ViewScope,
    ) => {
      return this.modelService.setReasoningEffort(entryId, reasoningEffort)
    },
    /** Read-only: the vendor's model list for a draft connection. */
    discoverModels: async (body: ModelDiscoveryInput) =>
      this.modelService.discoverModels(body),
    /** Read-only: check a draft connection's key and address (UI-29). */
    probeConnection: async (body: ModelConnectionInput) =>
      this.modelService.probeConnection(body),
    test: async (body: Dict): Promise<Dict> => this.modelService.test(body),
  }

  readonly control = {
    /** The control state of a session (null: none, e.g. a draft: the defaults). */
    get: (sessionId: string | null) =>
      this.host.controlPayload(this.controlSessionId(sessionId)),
    /** Switch the permission preset (`read-only` | `workspace-write` | `danger-full-access`). */
    setPermissionMode: (preset: string, sessionId: string) =>
      this.host.setPermissionPreset(
        this.requireControlSession(sessionId, 'control.setPermissionMode'),
        preset,
      ),
    /** `plan` enters plan mode, anything else leaves it. */
    setMode: (mode: string, sessionId: string) => {
      const id = this.requireControlSession(sessionId, 'control.setMode')
      const outcome = this.host.setPlanMode(id, mode === 'plan')
      return { outcome, control: this.host.controlPayload(id) }
    },
    answerInteraction: async (
      id: string,
      answers: Dict,
      _opts: Dict = {},
    ): Promise<Dict> =>
      this.settleInteraction(id, () =>
        this.host.answerInteraction(id, answers as UiAnswers),
      ),
    commentPlan: async (
      id: string,
      comment: string,
      _opts: Dict = {},
    ): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.commentPlan(id, comment)),
    approvePlan: async (id: string, _opts: Dict = {}): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.approvePlan(id)),
    cancelInteraction: async (id: string): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.cancelInteraction(id)),
  }

  readonly sessions = {
    list: (opts: { includeArchived?: boolean } = {}) =>
      this.sessionApplicationService.list(opts),
    /**
     * `plan` / `preset`: a draft's own settings when a typed command creates
     * its session (FIX-13), set before anything runs in it.
     */
    create: (
      opts: {
        title?: string
        mode?: string
        project?: Dict | null
        project_path?: string | null
        plan?: boolean
        preset?: string
      } = {},
    ) => {
      const { plan, preset, ...rest } = opts
      this.chatService.checkDraftSettings({ preset })
      const session = this.sessionApplicationService.create(rest)
      this.chatService.applyDraftSettings(session.id, { plan, preset })
      return session
    },
    rename: async (
      sessionId: string,
      patch: string | { title?: string | null; archived?: boolean | null },
    ) => this.sessionApplicationService.rename(sessionId, patch),
    /** Soft delete: the session goes to 最近删除 and can be restored. */
    delete: (sessionId: string): Promise<Dict> =>
      this.sessionApplicationService.delete(sessionId),
    listDeleted: () => this.sessionApplicationService.listDeleted(),
    /** 设置 › 常规 › 会话: the permission preset a new session starts in. */
    defaults: (): SessionDefaults => this.sessionDefaultsService.get(),
    setDefaults: (
      change: { permission: SessionPermission },
      view: ViewScope,
    ): Promise<SessionDefaults> =>
      this.sessionDefaultsService.update(change, view),
    restoreDeleted: (sessionId: string) =>
      this.sessionApplicationService.restoreDeleted(sessionId),
    purgeDeleted: (sessionId: string) =>
      this.sessionApplicationService.purgeDeleted(sessionId),
    purgeExpiredDeleted: (now?: number) =>
      this.sessionApplicationService.purgeExpiredDeleted(now),
    activate: (sessionId: string) =>
      this.sessionApplicationService.activate(sessionId),
    /** One message-boundary page of a session's raw log, sanitized for the wire. */
    history: (input: {
      sessionId: string
      beforeSeq?: number
      maxMessages?: number
    }): SessionHistoryPage => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.history',
      )
      const page = this.host.history(sessionId, {
        ...(input.beforeSeq === undefined
          ? {}
          : { beforeSeq: input.beforeSeq }),
        ...(input.maxMessages === undefined
          ? {}
          : { maxMessages: input.maxMessages }),
      })
      if (page === undefined)
        throw new InvalidSessionError(
          `sessions.history received unknown session ${sessionId}`,
          sessionId,
        )
      return { ...page, events: page.events.map(sanitizeForWire) }
    },
    /**
     * One raw log event by seq, NOT sanitized: the inspector loads the full
     * payload of an event the history page truncated (`wire` marker).
     */
    event: (input: { sessionId: string; seq: number }): SessionEvent => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.event',
      )
      const event = this.host.event(sessionId, input.seq)
      if (event === undefined)
        throw new InvalidSessionError(
          `sessions.event found no event ${input.seq} in session ${sessionId}`,
          sessionId,
        )
      return event
    },
    /**
     * 命令面板 (UI-S02): sessions whose own messages or replies contain the
     * query, newest first, one snippet each. Archived sessions are included.
     */
    search: async (input: {
      query: string
      limit?: number
    }): Promise<{ hits: SessionSearchHit[] }> => {
      this.host.sessions.flush(undefined, { sync: true })
      const hits = await searchSessionLogs({
        root: this.host.sessions.root,
        sessions: this.sessionApplicationService.list({
          includeArchived: true,
        }),
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      return { hits }
    },
    /** Ancestor chain of a (child) session, root first. */
    lineage: (input: { sessionId: string }): SessionLineage => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.lineage',
      )
      return this.host.lineage(sessionId) ?? { chain: [{ sessionId }] }
    },
    /** Delegated children of a session with their live status. */
    children: (input: { sessionId: string }): SubagentChildView[] => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.children',
      )
      return this.host.children(sessionId)
    },
    /**
     * Replace the set of sessions whose raw log events the desktop bridge
     * streams to the renderer. Unreadable ids are dropped.
     */
    watch: (input: { sessionIds: string[] }): { watching: string[] } => {
      const next = new Set<string>()
      for (const raw of input.sessionIds) {
        try {
          next.add(this.requireReadableLogSession(raw, 'sessions.watch'))
        } catch {
          // A deleted or unknown session is simply not watched.
        }
      }
      this.watchedSessions = next
      return { watching: [...next] }
    },
  }

  private watchedSessions = new Set<string>()

  private focusedSessionId: string | null = null

  isSessionWatched(sessionId: string): boolean {
    return this.watchedSessions.has(sessionId)
  }

  readonly references = {
    siteIcon: (input: Parameters<WorkspaceReferenceService['siteIcon']>[0]) =>
      this.workspaceReferenceService.siteIcon(input),
    preview: (input: Parameters<WorkspaceReferenceService['preview']>[0]) =>
      this.workspaceReferenceService.preview(input),
    image: async (input: { sessionId: string; referenceId: string }) => {
      this.requireReadableSession(input.sessionId, 'references.image')
      const descriptor = this.workspaceReferenceService.authorize(
        input.referenceId,
        input.sessionId,
      )
      const target = this.workspaceReferenceService.previewPath(
        input.referenceId,
        input.sessionId,
      )
      if (!/\.(png|jpe?g|gif|webp)$/i.test(target))
        throw new WorkspaceOperationError(
          'reference_image_unsupported',
          '该文件不支持图片预览。',
        )
      if (descriptor.kind === 'project_file')
        // Same path as files.preview: works for Build projects and for the
        // workspace of an ordinary chat.
        return this.workspaceReferenceService.previewFile(input)
      const ownedRoots = [this.host.sessionWorkspaceRoot(input.sessionId)]
      for (const root of ownedRoots) {
        let cwd: string
        try {
          cwd = realpathSync(root)
        } catch {
          continue
        }
        const path = relative(cwd, target)
        if (
          !path ||
          isAbsolute(path) ||
          path === '..' ||
          path.startsWith('..' + sep)
        )
          continue
        const files = new WorkspaceFilesService({
          resolveProject: () => ({
            sessionId: input.sessionId,
            projectRoot: cwd,
          }),
        })
        return files.read({ sessionId: input.sessionId, relativePath: path })
      }
      throw new WorkspaceOperationError(
        'reference_image_outside_workspace',
        '图片不属于当前会话工作区。',
      )
    },
    resolve: (input: Parameters<WorkspaceReferenceService['resolve']>[0]) =>
      this.workspaceReferenceService.resolve(input),
    /** Electron main-only capability; returns a path only after reference ownership checks. */
    revealPath: (input: { sessionId: string; referenceId: string }) =>
      this.workspaceReferenceService.revealPath(
        input.referenceId,
        input.sessionId,
      ),
  }

  readonly files = {
    /**
     * What the Files pane shows (BUG-10 adds what macOS can make: HEIC as
     * PNG, a document's first page and text, and whether the file may be
     * opened in its default app).
     */
    preview: async (input: FilePreviewInput): Promise<FilePreviewResult> =>
      (await this.enrichedPreview(input)).preview,
    /**
     * An `app://workspace-media/<token>` address for a file the caller may
     * preview, under the same checks as files.preview (BUG-05, BUG-10). It
     * streams what the pane shows — a video, a song, a picture (or the PNG
     * of a HEIC), a document's first page — and nothing for other files;
     * either way it names the file to 用默认应用打开 and 在访达中显示.
     */
    mediaUrl: async (input: FilePreviewInput): Promise<{ url: string }> => {
      const { preview, media } = await this.enrichedPreview(input)
      if (preview.kind === 'directory')
        throw new WorkspaceOperationError(
          'workspace_media_unsupported',
          '这个位置是目录，没有可以显示的内容。',
        )
      const grant = this.mediaGrants.grant({
        absPath: media?.path ?? preview.path,
        filePath: preview.path,
        streamable: media !== null,
        sessionId: input.source === 'attachment' ? '' : input.sessionId,
        // An attachment carries the mime it was saved with.
        mimeType:
          media && /^(?:video|audio|image)\//.test(media.mimeType)
            ? media.mimeType
            : 'application/octet-stream',
      })
      return { url: workspaceMediaUrl(grant.token) }
    },
    /** Electron main only (not an operation): the file behind a media token. */
    mediaGrant: (token: string): MediaGrant | null =>
      this.mediaGrants.lookup(token),
    /** Size and mtime of a preview that can change on disk (FIX-05). */
    stat: async (input: FileStatInput): Promise<FileStatResult> =>
      input.source === 'reference'
        ? this.workspaceReferenceService.statFile(input)
        : this.workspaceFilesService.stat({
            sessionId: input.sessionId,
            relativePath: input.path,
          }),
    read: async (
      input: Parameters<WorkspaceFilesService['read']>[0] & { turn?: number },
    ): Promise<WorkspaceFileReadResult> => {
      if (input.turn === undefined)
        return this.workspaceFilesService.read(input)
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'files.read',
      )
      const recorded = this.host
        .sessionLog(sessionId)
        ?.events.some(
          (event) =>
            event.type === 'turn/files' &&
            event.data.turn === input.turn &&
            event.data.status === 'recorded' &&
            event.data.files.some((file) => file.path === input.relativePath),
        )
      if (!recorded)
        throw new WorkspaceOperationError(
          'turn_file_not_recorded',
          '这份改动记录里没有这个文件。',
        )
      // The persisted record authorizes this exact path, not the whole Chat workspace.
      // Reuse the existing bounded reader and canonical path / symlink checks.
      return new WorkspaceFilesService({
        resolveProject: () => ({
          sessionId,
          projectRoot: this.host.sessionWorkspaceRoot(sessionId),
        }),
      }).read({ sessionId, relativePath: input.relativePath })
    },
  }

  private async enrichedPreview(
    input: FilePreviewInput,
  ): Promise<EnrichedPreview> {
    return enrichFilePreview(
      await this.rawFilePreview(input),
      this.previewConverter,
    )
  }

  private async rawFilePreview(
    input: FilePreviewInput,
  ): Promise<FilePreviewResult> {
    if (input.source === 'reference')
      return this.workspaceReferenceService.previewFile(input)
    if (input.source === 'attachment') {
      const ref = this.attachmentStore.get(input.attachmentId)
      if (!ref)
        throw new WorkspaceOperationError(
          'reference_attachment_unknown',
          '附件不存在或已被移除。',
        )
      // Managed attachments have the same global access as attachments.rawPath.
      const root = realpathSync(this.attachmentStore.root)
      const path = resolve(root, ref.rel_path)
      const canonical = realpathSync(path)
      const fromRoot = relative(root, canonical)
      if (
        fromRoot.startsWith('..') ||
        isAbsolute(fromRoot) ||
        canonical !== path
      )
        throw new WorkspaceOperationError(
          'reference_attachment_invalid',
          '附件路径超出存储范围。',
        )
      const value = await previewCanonicalFile(canonical)
      const extracted =
        ref.mime === 'application/pdf' && ref.has_text
          ? this.attachmentStore.readText(ref, 1024 * 1024)
          : ''
      return {
        ...value,
        name: ref.name,
        mimeType: ref.mime,
        revealable: true,
        ...(extracted
          ? {
              kind: 'document' as const,
              content: Buffer.from(extracted)
                .subarray(0, 1024 * 1024)
                .toString('utf8'),
              extractedText: true,
              truncated: Buffer.byteLength(extracted) >= 1024 * 1024,
            }
          : {}),
      }
    }
    return filePreviewResult(
      await this.files.read({
        sessionId: input.sessionId,
        relativePath: input.path,
        ...(input.source === 'turn' ? { turn: input.turn } : {}),
      }),
    )
  }

  readonly memory = {
    /** Memory and the context gauge of the session in view. */
    get: (view: ViewScope) =>
      this.memoryService.getMemory(this.viewedSession(view)?.id ?? null),
    save: (content: string) => this.memoryService.saveMemory(content),
    getEpisode: (date?: string | null) =>
      this.memoryService.getEpisode(String(date ?? '')),
    saveEpisode: (content: string, date?: string | null) =>
      this.memoryService.saveEpisode(content, String(date ?? '')),
    listVersions: (opts: { limit?: number; target?: string | null } = {}) =>
      this.memoryService.listVersions(opts),
    getVersion: (versionId: string) => this.memoryService.getVersion(versionId),
    restoreVersion: (versionId: string, view: ViewScope) =>
      this.memoryService.restoreVersion(
        versionId,
        this.viewedSession(view)?.id ?? null,
      ),
    tokens: (view: ViewScope) =>
      this.memoryService.tokens(this.viewedSession(view)?.id ?? null),
    compact: (opts: { force?: boolean; sessionId: string | null }) =>
      this.memoryService.compact(opts),
    explainContext: (opts: {
      sessionId: string | null
      turnId?: string | null
    }) => this.memoryService.explainContext(opts),
  }

  readonly projects = {
    list: () => this.host.kept.projectStore.list(),
    resolve: (path: string) => this.host.kept.projectStore.resolve(path),
  }

  readonly skills = {
    /** The tools the session in view sees (its project's MCP tools included). */
    tools: (view: ViewScope) =>
      this.skillService.tools(this.viewedSession(view)?.id ?? null),
    list: (opts: { sessionId: string | null }) => this.skillService.list(opts),
    get: (name: string, opts: { sessionId: string | null }) =>
      this.skillService.get(name, opts),
    create: (
      input: Parameters<CoreSkillService['create']>[0],
      _view: ViewScope,
    ) => {
      return this.skillService.create(input)
    },
    validate: (input: Parameters<CoreSkillService['validate']>[0]) =>
      this.skillService.validate(input),
    save: (
      name: string,
      content: string,
      opts: { sessionId: string | null },
      _view: ViewScope,
    ) => {
      return this.skillService.save(name, content, opts)
    },
    delete: (
      name: string,
      opts: {
        sessionId: string | null
        scope?: 'user' | 'project' | null
      },
      _view: ViewScope,
    ) => {
      return this.skillService.delete(name, opts)
    },
    import: async (
      input: Parameters<CoreSkillService['import']>[0],
      _view: ViewScope,
    ) => {
      return await this.skillService.import(input)
    },
    copyToUser: (
      input: Parameters<CoreSkillService['copyToUser']>[0],
      _view: ViewScope,
    ) => {
      return this.skillService.copyToUser(input)
    },
    /** Electron main-only capability: the Skills folder of a scope (created when missing). */
    folderPath: (input: Parameters<CoreSkillService['folderPath']>[0]) =>
      this.skillService.folderPath(input),
  }

  readonly storage = {
    /** REL-03: the runs, the data version, files a newer Emperor wrote. */
    versions: async (): Promise<DataVersionsReport> => {
      const { dataVersionsReport } = await import('../storage/data-files')
      return dataVersionsReport(this.paths.stateRoot, this.appVersion)
    },
  }

  readonly tools = {
    /**
     * A spilled tool result (`ref` is the spill file path) in 256 KiB pages
     * that end on a character boundary (KRN-12); `page` counts from 1. The
     * real file (links resolved) must be a file inside the spill store.
     */
    readResult: (opts: { ref: string; page?: number }): ResultPage => {
      let target: string | null = null
      try {
        const real = realpathSync(resolve(String(opts?.ref ?? '')))
        const rel = relative(
          realpathSync(resolve(this.paths.stateRoot, 'spill')),
          real,
        )
        if (rel && !rel.startsWith('..') && !isAbsolute(rel))
          target = statSync(real).isFile() ? real : null
      } catch {
        target = null
      }
      if (target === null)
        throw new CoreMutationGuardError(
          403,
          'tool result ref is outside the spill store',
        )
      return readUtf8Page(target, opts?.page ?? 1)
    },
  }

  private activateSession(sessionId: string) {
    const entry = this.host.kept.sessionStore.get(sessionId)
    if (entry === null)
      throw new InvalidSessionError(`unknown session ${sessionId}`, sessionId)
    this.focusedSessionId = sessionId
    return entry
  }

  private viewedSession(view: ViewScope | undefined) {
    const id = String(view?.sessionId ?? '').trim()
    if (!id || id.startsWith(DRAFT_SESSION_PREFIX)) return null
    const entry = this.host.kept.sessionStore.get(id)
    return entry && !entry.archived_at ? entry : null
  }

  private requireSessionId(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new SessionRequiredError(operation)
    return id
  }

  private controlSessionId(
    sessionId: string | null | undefined,
  ): string | null {
    const id = String(sessionId ?? '').trim()
    return id || null
  }

  private requireControlSession(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    return this.requireReadableSession(
      this.requireSessionId(sessionId, operation),
      operation,
    ).id
  }

  private settleInteraction(id: string, action: () => void): Dict {
    const sessionId = this.host.pending.sessionOf(id) ?? null
    if (sessionId === null)
      throw new CoreMutationGuardError(409, `interaction ${id} is not pending`)
    action()
    const result: Dict = {
      interactionId: id,
      sessionId,
      control: this.host.controlPayload(sessionId),
    }
    return result
  }

  private activeTaskInfos(): Dict[] {
    return this.host.busySessions().map((sessionId) => ({
      id: `turn:${sessionId}`,
      kind: 'turn',
      session_id: sessionId,
      status: 'running',
    }))
  }

  private runtimeStats(sessionId: string | null): Dict {
    const session =
      sessionId === null ? undefined : this.host.sessionLog(sessionId)
    return {
      events: session?.events.length ?? 0,
      latestSeq: session === undefined ? 0 : session.seq - 1,
      busy: this.host.isBusy(sessionId),
    }
  }

  private assertClearBoundary(sessionId: string): void {
    this.requireReadableSession(sessionId, 'commands.clear')
    if (this.host.pending.hasPending(sessionId))
      throw new CoreMutationGuardError(
        409,
        '请先处理当前的提问、权限或计划审批，再创建新上下文。',
      )
    if (this.host.queuedPrompts(sessionId).length)
      throw new CoreMutationGuardError(
        409,
        '请先处理当前会话中的排队消息，再创建新上下文。',
      )
  }

  private requireReadableSessionId(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    return this.requireReadableSession(
      String(sessionId ?? '').trim(),
      operation,
    ).id
  }

  private requireReadableLogSession(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    const id = String(sessionId ?? '').trim()
    if (id && !id.startsWith(DRAFT_SESSION_PREFIX)) {
      const indexed = this.host.kept.sessionStore.get(id)
      if (indexed === null && this.host.sessions.has(id)) {
        const root = this.host.lineage(id)?.chain[0]?.sessionId
        if (root !== undefined && root !== id) {
          this.requireReadableSession(root, operation)
          return id
        }
      }
    }
    return this.requireReadableSession(id, operation).id
  }

  private requireReadableSession(
    sessionId: string,
    operation: string,
  ): { id: string; archived_at?: string | null } {
    if (!sessionId)
      throw new InvalidSessionError(
        `${operation} requires a real sessionId`,
        null,
      )
    if (sessionId.startsWith(DRAFT_SESSION_PREFIX))
      throw new InvalidSessionError(
        `${operation} cannot read draft session ${sessionId}`,
        sessionId,
      )
    const session = this.host.kept.sessionStore.get(sessionId)
    if (!session || session.archived_at)
      throw new InvalidSessionError(
        `${operation} received unknown session ${sessionId}`,
        sessionId,
      )
    return session
  }
}

function normalizedNonNegativeNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function normalizedPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}
