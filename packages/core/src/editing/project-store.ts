import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { z } from 'zod'
import { promisify } from 'node:util'
import { EmperorError } from '../errors'
import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import { writeJsonAtomic } from '../store/atomic-json'
import { applyVideoProjectCommand, assertValidVideoProject } from './commands'
import { findExecutable } from './analysis/paths'
import {
  prepareProjectLayout,
  readPrivateMetadata,
  PROJECT_PRIVATE_DIR,
} from './project-layout'
import { recoverEditingStaging } from './staging'
import { EditingMediaCache } from './media-cache'
import type { PreviewMediaCache, PreviewMediaKind } from './preview-media'
import type { AnalysisConfig, ResolvedAnalysisConfig } from './analysis/config'
import type {
  AnalysisProgress,
  AnalysisStatus,
  TranscriptCache,
  TranscriptResult,
  VideoAnalysisService,
} from './analysis/service'
import {
  MotionAuthoring,
  type MotionContext,
  type MotionTarget,
  type MotionWork,
} from './motion-authoring'
import type { MotionScene } from './motion'
import type { EditRunAction, EditRunMode, EditRunService } from './edit-run'
import {
  videoProjectSchema,
  videoProjectSchemaV1,
  type VideoAsset,
  type VideoProject,
  type VideoProjectCommitDraftInput,
  type VideoProjectImportInput,
  type VideoProjectMetadataInput,
  type VideoProjectMutateInput,
  type VideoProjectOpenInput,
  type VideoProjectResult,
  type VideoProjectRelinkInput,
  type VideoProjectRemoveMissingAssetInput,
  type VideoProjectRevisionInput,
  type VideoProjectSession,
  type VideoProjectV1,
} from './types'

const runFile = promisify(execFile)

const TIMELINE_FILE = 'timeline.json'
// An unbound folder with both files may be an older project with an unrelated timeline.json.
export const VIDEO_PROJECT_MANIFEST_FILES = [
  'video-edit.json',
  TIMELINE_FILE,
] as const
type ProjectManifestFile = (typeof VIDEO_PROJECT_MANIFEST_FILES)[number]
const WORKSPACE_DIRECTORY = PROJECT_PRIVATE_DIR
const WORKSPACE_FILE = `${WORKSPACE_DIRECTORY}/workspace.json`
const MIGRATIONS_DIRECTORY = `${WORKSPACE_DIRECTORY}/migrations`
const workspaceMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(128),
    chatSessionId: z.string().min(1).max(256),
    motionEnabled: z.boolean().optional(),
    manifest: z.enum(VIDEO_PROJECT_MANIFEST_FILES).optional(),
  })
  .strict()

type WorkspaceMetadata = z.infer<typeof workspaceMetadataSchema>

function migrateVideoProjectV1(project: VideoProjectV1): VideoProject {
  const track = { id: 'main', kind: 'video' as const, name: '主画面', index: 0 }
  let start = 0
  const clips = project.clips.map((clip) => {
    const duration = (clip.sourceOut - clip.sourceIn) / clip.speed
    const migrated = { ...clip, trackId: 'main', timelineStart: start }
    start += duration
    return migrated
  })
  return {
    ...project,
    schemaVersion: 2,
    tracks: [track],
    clips,
    subtitles: [],
  }
}

export interface VideoProjectServiceOptions {
  getSession(sessionId: string): VideoProjectSession | null
  createBuildSession(projectPath: string, title: string): VideoProjectSession
  /** Open the session's runtime log so the renderer can read its history. */
  ensureSession?(sessionId: string): void
  stateRoot?: string
  grantPreview?(input: {
    sessionId: string
    file: string
    source: string
  }): string
  analysis?: VideoAnalysisService
  editRuns?(): Promise<EditRunService>
  validateMotionFrame?(
    scene: MotionScene,
    frame: number,
    signal?: AbortSignal,
  ): Promise<void>
  currentTurn?(sessionId: string): number | undefined
  onMotionWork?(sessionId: string, work: MotionWork): void
  onMotionCommit?(snapshot: VideoProjectResult): void
  onAnalysisProgress?(event: {
    sessionId: string
    assetId: string
    stage: AnalysisProgress['stage']
    progress: number
  }): void
  now?: () => Date
}

interface HistoryEntry {
  projectId: string
  revision: number
  undo: VideoProject[]
  redo: VideoProject[]
}

function error(message: string, code: string): never {
  throw new EmperorError(message, code)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class VideoProjectService {
  readonly motion: MotionAuthoring
  private readonly motionSessions = new Set<string>()
  readonly mediaCache: EditingMediaCache
  private previewCache?: Promise<PreviewMediaCache>
  private readonly blockedLayouts = new Map<string, string>()
  private readonly histories = new Map<string, HistoryEntry>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly missingAssets = new WeakMap<VideoProject, string[]>()
  private readonly manifestPaths = new WeakMap<VideoProject, string>()
  private readonly now: () => Date

  constructor(private readonly options: VideoProjectServiceOptions) {
    this.mediaCache =
      options.analysis?.mediaCache ??
      new EditingMediaCache(options.stateRoot ?? 'cutroom')
    if (options.stateRoot) void recoverEditingStaging()
    this.now = options.now ?? (() => new Date())
    this.motion = new MotionAuthoring({
      inspect: (ctx) => this.motionTarget(ctx),
      commit: (ctx, target, scene) => this.commitMotion(ctx, target, scene),
      validate: options.validateMotionFrame,
      emit: (sessionId, work) => options.onMotionWork?.(sessionId, work),
    })
  }

  async open(input: VideoProjectOpenInput): Promise<VideoProjectResult> {
    const root =
      'sessionId' in input
        ? await this.rootForSession(input.sessionId)
        : await this.canonicalRoot(input.projectPath)
    return this.serialized(root, () => this.openAt(root, input))
  }

  private async openAt(
    root: string,
    input: VideoProjectOpenInput,
  ): Promise<VideoProjectResult> {
    let metadata: WorkspaceMetadata | null = null
    let metadataProblem: unknown
    let editRunRecovery: string | undefined
    let hadCurrentBinding = false
    try {
      metadata = await this.readWorkspaceMetadata(root)
      hadCurrentBinding = Boolean(metadata)
      metadata ??= await this.readWorkspaceMetadata(root, true)
    } catch (cause) {
      metadataProblem = cause
    }
    const existingManifest =
      metadata?.manifest ?? (await this.findManifest(root))
    if (!existingManifest && !input.initialize)
      error('这个文件夹还没有剪辑工程，请先初始化。', 'project_not_initialized')
    let sessionId = 'sessionId' in input ? input.sessionId : null
    const manifest = existingManifest ?? TIMELINE_FILE
    const loaded = existingManifest
      ? await this.loadProject(root, manifest)
      : null
    if (loaded) {
      try {
        if (metadataProblem) throw metadataProblem
        editRunRecovery = await prepareProjectLayout(
          root,
          loaded.project.projectId,
          loaded.project.assets,
          this.options.stateRoot,
        )
        if (!hadCurrentBinding && metadata)
          hadCurrentBinding = Boolean(await this.readWorkspaceMetadata(root))
        this.blockedLayouts.delete(root)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        this.blockedLayouts.set(root, reason)
        return {
          ...this.result(root, metadata?.chatSessionId ?? '', loaded.project),
          readOnlyReason: reason,
          canUndo: false,
          canRedo: false,
        }
      }
    } else if (metadataProblem || metadata) {
      error('已有工程绑定缺少有效的时间线，请恢复后重试。', 'project_invalid')
    }
    if (sessionId !== null && metadata && metadata.chatSessionId !== sessionId)
      error('当前会话未绑定这个剪辑工程。', 'workspace_session_required')
    const project = loaded?.project ?? (await this.initialize(root))
    if (metadata?.projectId === project.projectId && sessionId === null) {
      try {
        if ((await this.rootForSession(metadata.chatSessionId)) === root)
          sessionId = metadata.chatSessionId
      } catch {
        // The old Build session is no longer available.
      }
    }
    if (
      'sessionId' in input &&
      metadata &&
      metadata.projectId !== project.projectId
    )
      error(
        '工程绑定已经改变，请从文件夹重新打开。',
        'workspace_session_required',
      )
    if (!sessionId) {
      sessionId = this.options.createBuildSession(root, project.name).id
      if ((await this.rootForSession(sessionId)) !== root)
        error('无法建立工作区会话。', 'workspace_session_required')
    }
    const current = loaded?.migrated
      ? await this.persistMigration(root, project)
      : project
    if (
      !hadCurrentBinding ||
      metadata?.projectId !== project.projectId ||
      metadata.chatSessionId !== sessionId ||
      metadata.manifest !== manifest
    )
      await this.writeWorkspaceMetadata(root, {
        ...(metadata?.projectId === project.projectId ? metadata : {}),
        schemaVersion: 1,
        projectId: project.projectId,
        chatSessionId: sessionId,
        manifest,
      })
    this.rememberMotionSetting(
      sessionId,
      metadata?.projectId === project.projectId &&
        metadata?.motionEnabled === true,
    )
    this.motion.reopen(sessionId)
    this.options.ensureSession?.(sessionId)
    return {
      ...this.result(root, sessionId, current),
      ...(editRunRecovery ? { editRunRecovery } : {}),
    }
  }

  /** Read the bound project without writing metadata or touching history. */
  async inspect(sessionId: string): Promise<VideoProjectResult> {
    const root = await this.rootForSession(sessionId)
    return this.serialized(root, async () =>
      this.result(
        root,
        sessionId,
        await this.readBoundProject(root, sessionId),
      ),
    )
  }

  private rememberMotionSetting(sessionId: string, enabled: boolean) {
    if (enabled) this.motionSessions.add(sessionId)
    else {
      this.motionSessions.delete(sessionId)
      this.motion.end(sessionId, '项目动效制作已关闭。')
    }
  }

  motionEnabled(sessionId: string): boolean {
    return this.motionSessions.has(sessionId)
  }

  async motionSettings({ sessionId }: { sessionId: string }) {
    const root = await this.rootForSession(sessionId)
    return this.serialized(root, async () => {
      await this.readBoundProject(root, sessionId)
      return { enabled: this.motionEnabled(sessionId) }
    })
  }

  async setMotionEnabled({
    sessionId,
    enabled,
  }: {
    sessionId: string
    enabled: boolean
  }) {
    const root = await this.rootForSession(sessionId)
    return this.serialized(root, async () => {
      await this.readBoundProject(root, sessionId)
      const metadata = await this.readWorkspaceMetadata(root)
      if (!metadata || metadata.chatSessionId !== sessionId)
        error('工程绑定已变化。', 'workspace_session_required')
      if ((metadata.motionEnabled ?? false) !== enabled)
        await this.writeWorkspaceMetadata(root, {
          ...metadata,
          motionEnabled: enabled,
        })
      this.rememberMotionSetting(sessionId, enabled)
      return { enabled }
    })
  }

  leaveMotionWorkspace({ sessionId }: { sessionId: string }): Promise<void> {
    if (!this.options.getSession(sessionId)) return Promise.resolve()
    return this.motion.leave(sessionId, this.options.currentTurn?.(sessionId))
  }

  async motionWork({ sessionId }: { sessionId: string }) {
    await this.motionSettings({ sessionId })
    return this.motion.latest(sessionId)
  }

  async motionTarget(ctx: MotionContext): Promise<MotionTarget> {
    const current = await this.inspect(ctx.sessionId)
    if (!this.motionEnabled(ctx.sessionId))
      error('请先在当前工程开启动效制作。', 'motion_disabled')
    const runs = await this.options.editRuns?.()
    const draft = await runs?.motionTarget(
      ctx.sessionId,
      ctx.scope,
      ctx.precisionTurn,
    )
    if (ctx.precisionTurn && !draft)
      error('当前精剪回合已结束。', 'edit_run_inactive')
    return draft ?? { project: current.project }
  }

  private async commitMotion(
    ctx: MotionContext,
    target: MotionTarget,
    scene: MotionScene,
  ) {
    const runs = await this.options.editRuns?.()
    if (target.runId) {
      if (!runs) error('精剪任务已结束。', 'motion_target_changed')
      const result = await runs.stageMotion(
        ctx.sessionId,
        ctx.scope,
        target.runId,
        target.generation!,
        scene,
        ctx.signal,
      )
      return { generation: result.generation }
    }
    const write = () =>
      this.applyMutation(
        {
          sessionId: ctx.sessionId,
          expectedRevision: target.project.revision,
          command: { type: 'upsertMotionScene', scene },
          signal: ctx.signal,
        },
        true,
      )
    const committed = runs
      ? await runs.withLiveMotionTarget(ctx.sessionId, write)
      : await write()
    this.options.onMotionCommit?.(committed)
    return { revision: committed.project.revision }
  }

  async previewMedia(input: {
    sessionId: string
    assetId: string
    kind: PreviewMediaKind
    posterTime?: number
    posterEnd?: number
    force?: boolean
  }) {
    const snapshot = await this.inspect(input.sessionId)
    const asset = await this.previewAsset(snapshot, input.assetId)
    const ffmpeg = this.options.analysis
      ? (await this.options.analysis.status()).ffmpegPath
      : findExecutable('ffmpeg')
    this.previewCache ??= import('./preview-media').then(
      ({ PreviewMediaCache }) => new PreviewMediaCache(this.mediaCache),
    )
    const result = await (
      await this.previewCache
    ).prepare(
      snapshot.projectPath,
      asset,
      ffmpeg,
      input.kind,
      input.force ?? false,
      input.posterTime,
      input.posterEnd,
    )
    if (!result.proxy) return { path: result.path, proxy: false }
    const handle = this.mediaCache.handle({
      sessionId: input.sessionId,
      projectId: snapshot.project.projectId,
      assetId: asset.id,
      file: result.path,
      source: resolve(snapshot.projectPath, asset.path),
      signature: result.signature,
    })
    return { path: 'cutroom-preview:' + handle, proxy: true }
  }

  private async previewAsset(snapshot: VideoProjectResult, assetId: string) {
    const live = snapshot.project.assets.find((asset) => asset.id === assetId)
    if (live) return live
    const runs = await this.options.editRuns?.()
    const draft = await runs?.draftSnapshot(snapshot.sessionId)
    const asset = draft?.project.assets.find((asset) => asset.id === assetId)
    if (!asset) error('当前工程没有此素材。', 'asset_not_found')
    return asset
  }

  async cacheMediaUrl(input: { sessionId: string; handle: string }) {
    const snapshot = await this.inspect(input.sessionId)
    const entry = this.mediaCache.resolveHandle(input.sessionId, input.handle)
    const asset = await this.previewAsset(snapshot, entry.assetId)
    const { previewSourceIdentity } = await import('./preview-media')
    if (
      entry.projectId !== snapshot.project.projectId ||
      entry.source !== resolve(snapshot.projectPath, asset.path) ||
      (await realpath(entry.source)) !== entry.source ||
      (await previewSourceIdentity(entry.source)) !== entry.signature ||
      !this.options.grantPreview ||
      (await realpath(entry.file)) !== entry.file ||
      !(await lstat(entry.file)).isFile()
    )
      error('预览文件已失效。', 'preview_unavailable')
    return {
      url: this.options.grantPreview({
        sessionId: input.sessionId,
        file: entry.file,
        source: entry.source,
      }),
    }
  }

  async startEditRun(
    input: {
      sessionId: string
      brief: string
      mode?: EditRunMode
    },
    fromConversation = false,
  ) {
    const runs = await this.requireEditRuns()
    const status = await runs.create(input.sessionId, input.brief, input.mode)
    this.motion.end(input.sessionId, '已开始新的精剪任务。')
    runs.launch(input.sessionId, input.brief, fromConversation)
    return status
  }

  async editRunStatus(input: { sessionId: string }) {
    return (await this.requireEditRuns()).status(input.sessionId)
  }

  async editRunDraft(input: { sessionId: string; runId?: string }) {
    return (await this.requireEditRuns()).draftSnapshot(
      input.sessionId,
      input.runId,
    )
  }

  async editRunAction(input: {
    sessionId: string
    action: EditRunAction
    runId?: string
  }) {
    const status = await (
      await this.requireEditRuns()
    ).action(input.sessionId, input.action, input.runId)
    this.motion.end(input.sessionId, '精剪任务状态已变化。')
    return status
  }

  private async requireEditRuns(): Promise<EditRunService> {
    if (!this.options.editRuns)
      error('自主精剪服务不可用。', 'edit_run_unavailable')
    return this.options.editRuns()
  }

  async importAssets(
    input: VideoProjectImportInput,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      const current = await this.readBoundProject(root, input.sessionId)
      await this.ensureDirectory(root, 'assets')
      const sources = await Promise.all(
        input.sourcePaths.map((sourcePath) => this.importSource(sourcePath)),
      )
      const copied: string[] = []
      try {
        const assets: VideoAsset[] = []
        for (const source of sources) {
          const id = randomUUID()
          const path = `assets/${id}${source.extension}`
          const destination = this.assetPath(root, path)
          await copyFile(
            source.canonicalPath,
            destination,
            constants.COPYFILE_EXCL,
          )
          copied.push(destination)
          assets.push({
            id,
            kind: source.kind,
            path,
            displayName: basename(source.canonicalPath),
            duration: null,
            width: null,
            height: null,
          })
        }
        const next = clone(current)
        next.assets.push(...assets)
        const saved = await this.saveNext(root, current, next)
        this.history(root, current).revision = saved.revision
        return this.result(root, input.sessionId, saved)
      } catch (cause) {
        await Promise.all(
          copied.map((path) => unlink(path).catch(() => undefined)),
        )
        throw cause
      }
    })
  }

  async relinkAsset(
    input: VideoProjectRelinkInput,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      this.assertMissing(current, input.assetId)
      const next = clone(current)
      const asset = next.assets.find((item) => item.id === input.assetId)!
      const source = await this.importSource(input.sourcePath)
      if (source.kind !== asset.kind)
        error('替换文件的素材类型不匹配。', 'invalid_import')
      await this.ensureDirectory(root, 'assets')
      const path = `assets/${randomUUID()}${source.extension}`
      const destination = this.assetPath(root, path)
      await copyFile(source.canonicalPath, destination, constants.COPYFILE_EXCL)
      let saved: VideoProject
      try {
        if (asset.kind !== 'image') {
          const history = this.history(root, current)
          let requiredEnd = 0
          for (const version of [current, ...history.undo, ...history.redo])
            for (const clip of version.clips)
              if (clip.assetId === asset.id)
                requiredEnd = Math.max(requiredEnd, clip.sourceOut)
          if (requiredEnd > 0) {
            const metadata = await this.probeReplacementVideo(
              destination,
              asset.kind,
            )
            if (metadata.duration + 1e-6 < requiredEnd)
              error(
                '替换视频太短，无法覆盖当前片段及可撤销编辑所需的源区间。',
                'replacement_too_short',
              )
            Object.assign(asset, metadata)
          } else {
            asset.duration = null
            asset.width = null
            asset.height = null
          }
        }
        asset.path = path
        asset.displayName = basename(source.canonicalPath)
        saved = await this.saveNext(root, current, next)
      } catch (cause) {
        await unlink(destination).catch(() => undefined)
        throw cause
      }
      this.history(root, current).revision = saved.revision
      return this.result(root, input.sessionId, saved)
    })
  }

  private async probeReplacementVideo(
    path: string,
    kind: VideoAsset['kind'],
  ): Promise<{
    duration: number
    width: number | null
    height: number | null
  }> {
    const ffmpeg = (await this.options.analysis?.status())?.ffmpegPath
    const ffprobe = findExecutable(
      'ffprobe',
      ffmpeg ? resolve(dirname(ffmpeg), 'ffprobe') : undefined,
    )
    if (!ffprobe)
      error(
        '重新定位时间线中的视频需要 ffprobe 来验证素材时长。',
        'ffprobe_missing',
      )
    try {
      const { stdout } = await runFile(
        ffprobe,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-select_streams',
          kind === 'audio' ? 'a:0' : 'v:0',
          '-show_entries',
          'stream=index,width,height:format=duration',
          '-of',
          'json',
          path,
        ],
        { timeout: 15_000, maxBuffer: 65_536 },
      )
      const media = JSON.parse(stdout) as {
        streams?: Array<{ width?: number; height?: number }>
        format?: { duration?: string }
      }
      const stream = media.streams?.[0]
      const duration = Number(media.format?.duration)
      if (
        !stream ||
        (kind !== 'audio' && (!stream.width || !stream.height)) ||
        !Number.isFinite(duration) ||
        duration <= 0
      )
        error('替换文件没有有效的视频信息。', 'invalid_import')
      return {
        duration,
        width: stream.width ?? null,
        height: stream.height ?? null,
      }
    } catch {
      error(
        '无法读取替换文件的视频信息，请选择可播放的视频。',
        'invalid_import',
      )
    }
  }

  async removeMissingAsset(
    input: VideoProjectRemoveMissingAssetInput,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      this.assertMissing(current, input.assetId)
      const next = clone(current)
      next.assets = next.assets.filter((item) => item.id !== input.assetId)
      next.clips = next.clips.filter((item) => item.assetId !== input.assetId)
      const remainingClips = new Set(next.clips.map((clip) => clip.id))
      for (const scene of next.motionScenes ?? [])
        if (scene.anchor && !remainingClips.has(scene.anchor.clipId))
          scene.anchor.status = 'lost'
      const saved = await this.saveNext(root, current, next)
      this.histories.delete(root)
      return this.result(root, input.sessionId, saved)
    })
  }

  private assertMissing(project: VideoProject, assetId: string): void {
    if (!project.assets.some((asset) => asset.id === assetId))
      error('找不到这个素材。', 'asset_not_found')
    if (!this.missingAssets.get(project)?.includes(assetId))
      error('素材文件仍然存在。', 'asset_not_missing')
  }

  async updateAssetMetadata(
    input: VideoProjectMetadataInput,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      const next = clone(current)
      const asset = next.assets.find((item) => item.id === input.assetId)
      if (!asset) error('找不到这个素材。', 'asset_not_found')
      if (asset.kind === 'image' && input.duration !== null)
        error('图片素材没有媒体时长。', 'invalid_metadata')
      asset.duration = input.duration
      asset.width = input.width
      asset.height = input.height
      const saved = await this.saveNext(root, current, next)
      this.history(root, current).revision = saved.revision
      return this.result(root, input.sessionId, saved)
    })
  }

  async mutate(
    input: VideoProjectMutateInput & {
      signal?: AbortSignal
      requireMotionEnabled?: boolean
    },
  ): Promise<VideoProjectResult> {
    return this.applyMutation(input, false)
  }

  private async applyMutation(
    input: VideoProjectMutateInput & {
      signal?: AbortSignal
      requireMotionEnabled?: boolean
    },
    authoredMotion: boolean,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      input.signal?.throwIfAborted()
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      if (
        (authoredMotion || input.requireMotionEnabled) &&
        !this.motionEnabled(input.sessionId)
      )
        error('项目动效制作已关闭。', 'motion_disabled')
      if (
        'sceneId' in input.command &&
        this.motion.isEditingLiveScene(input.sessionId, input.command.sceneId)
      )
        error('这幕动效正在制作中。', 'motion_work_active')
      if (input.command.type === 'upsertMotionScene' && !authoredMotion)
        error('请使用逐对象动效工具写入场景。', 'motion_authoring_required')
      const applied = applyVideoProjectCommand(current, input.command)
      if (JSON.stringify(applied.project) === JSON.stringify(current))
        return this.result(
          root,
          input.sessionId,
          current,
          applied.selectedClipId,
          applied.selectedSubtitleId,
          applied.selectedMotionSceneId,
        )
      const history = this.history(root, current)
      const saved = await this.saveNext(
        root,
        current,
        applied.project,
        input.signal,
      )
      history.revision = saved.revision
      history.undo.push(clone(current))
      history.redo = []
      return this.result(
        root,
        input.sessionId,
        saved,
        applied.selectedClipId,
        applied.selectedSubtitleId,
        applied.selectedMotionSceneId,
      )
    })
  }

  /** Commit a completed draft as a single compare-and-swap and undo step. */
  async commitEditDraft(
    input: VideoProjectCommitDraftInput,
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      input.signal?.throwIfAborted()
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      if (current.projectId !== input.draft.projectId)
        error('草稿属于另一个工程。', 'draft_project_mismatch')
      const sourceById = new Map(
        input.draft.assets.map((asset) => [asset.id, asset]),
      )
      const currentById = new Map(
        current.assets.map((asset) => [asset.id, asset]),
      )
      const workspaceIds = new Set(input.workspaceAssetIds)
      for (const { assetId } of input.draft.clips) {
        const source = sourceById.get(assetId)
        if (
          source &&
          !currentById.has(assetId) &&
          workspaceIds.has(assetId) &&
          (await this.assertAssetContained(root, source.path))
        )
          currentById.set(assetId, source)
        if (!source || currentById.get(assetId)?.path !== source.path)
          error('草稿使用的素材已经变化。', 'draft_asset_changed')
      }
      const next = {
        ...input.draft,
        name: current.name,
        createdAt: current.createdAt,
        assets: [...currentById.values()],
      }
      const saved = await this.saveNext(root, current, next, input.signal)
      const history = this.history(root, current)
      history.revision = saved.revision
      history.undo.push(clone(current))
      history.redo = []
      return this.result(root, input.sessionId, saved)
    })
  }

  async undo(
    input: VideoProjectRevisionInput & { signal?: AbortSignal },
  ): Promise<VideoProjectResult> {
    return this.restoreHistory(input, 'undo')
  }

  async redo(
    input: VideoProjectRevisionInput & { signal?: AbortSignal },
  ): Promise<VideoProjectResult> {
    return this.restoreHistory(input, 'redo')
  }

  async analysisStatus(): Promise<AnalysisStatus> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    return this.options.analysis.status()
  }

  async getAnalysisConfig(): Promise<ResolvedAnalysisConfig> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    return this.options.analysis.readConfig()
  }

  async setAnalysisConfig(
    input: AnalysisConfig,
  ): Promise<ResolvedAnalysisConfig> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    return this.options.analysis.saveConfig(input)
  }

  async transcribe(input: {
    sessionId: string
    assetId: string
    language?: 'auto' | 'zh' | 'en'
    force?: boolean
    signal?: AbortSignal
  }): Promise<{ asset: VideoAsset; transcript: TranscriptResult }> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    const root = await this.rootForSession(input.sessionId)
    const project = await this.readBoundProject(root, input.sessionId)
    const asset = project.assets.find((item) => item.id === input.assetId)
    if (!asset) error('找不到这个素材。', 'asset_not_found')
    const transcript = await this.options.analysis.transcribe(
      root,
      asset,
      { language: input.language, force: input.force, signal: input.signal },
      (progress) =>
        this.options.onAnalysisProgress?.({
          sessionId: input.sessionId,
          assetId: asset.id,
          stage: progress.stage,
          progress: progress.progress,
        }),
    )
    return { asset, transcript }
  }

  async transcript(input: {
    sessionId: string
    assetId: string
  }): Promise<{ asset: VideoAsset; transcript: TranscriptCache } | null> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    const root = await this.rootForSession(input.sessionId)
    const project = await this.readBoundProject(root, input.sessionId)
    const asset = project.assets.find((item) => item.id === input.assetId)
    if (!asset) error('找不到这个素材。', 'asset_not_found')
    const status = await this.options.analysis.status()
    const transcript = await this.options.analysis.readTranscript(
      root,
      asset,
      status,
    )
    if (!transcript) return null
    const peaks = await this.options.analysis.waveform(
      root,
      asset,
      status.ffmpegPath,
    )
    return { asset, transcript: { ...transcript, peaks } }
  }

  async transcripts(
    snapshot: VideoProjectResult,
    assetIds: readonly string[],
  ): Promise<Map<string, TranscriptCache>> {
    const result = new Map<string, TranscriptCache>()
    const analysis = this.options.analysis
    if (!analysis || assetIds.length === 0) return result
    const status = await analysis.status()
    const ids = new Set(assetIds)
    const missing = new Set(snapshot.missingAssetIds)
    const assets = snapshot.project.assets.filter(
      (asset) =>
        asset.kind !== 'image' && ids.has(asset.id) && !missing.has(asset.id),
    )
    for (let i = 0; i < assets.length; i += 8) {
      await Promise.all(
        assets.slice(i, i + 8).map(async (asset) => {
          const transcript = await analysis.readTranscript(
            snapshot.projectPath,
            asset,
            status,
          )
          if (transcript) result.set(asset.id, transcript)
        }),
      )
    }
    return result
  }

  async inspectFrames(input: {
    sessionId: string
    assetId: string
    times: number[]
    signal?: AbortSignal
    expected?: { projectId: string; revision: number }
  }): Promise<{
    asset: VideoAsset
    frames: Awaited<ReturnType<VideoAnalysisService['frames']>>
  }> {
    if (!this.options.analysis)
      error('媒体分析服务不可用。', 'analysis_unavailable')
    const root = await this.rootForSession(input.sessionId)
    const project = await this.readBoundProject(root, input.sessionId)
    if (input.expected) {
      if (project.projectId !== input.expected.projectId)
        error('工程已修改，请重新确认要发送的关键帧。', 'revision_conflict')
      this.assertRevision(project, input.expected.revision)
    }
    const asset = project.assets.find((item) => item.id === input.assetId)
    if (!asset) error('找不到这个素材。', 'asset_not_found')
    const frames = await this.options.analysis.frames(
      root,
      asset,
      input.times,
      input.signal,
    )
    return { asset, frames }
  }

  private async restoreHistory(
    input: VideoProjectRevisionInput & { signal?: AbortSignal },
    direction: 'undo' | 'redo',
  ): Promise<VideoProjectResult> {
    const root = await this.rootForSession(input.sessionId)
    return this.serialized(root, async () => {
      input.signal?.throwIfAborted()
      const current = await this.readBoundProject(root, input.sessionId)
      this.assertRevision(current, input.expectedRevision)
      const history = this.history(root, current)
      const source = history[direction]
      const target = source.at(-1)
      if (!target) error('没有可以恢复的操作。', 'history_empty')
      const restored = {
        ...current,
        tracks: target.tracks,
        clips: target.clips,
        subtitles: target.subtitles,
        captionStyle: target.captionStyle,
        annotations: target.annotations,
        motionScenes: target.motionScenes,
        canvas: target.canvas,
      }
      const saved = await this.saveNext(root, current, restored, input.signal)
      history.revision = saved.revision
      source.pop()
      history[direction === 'undo' ? 'redo' : 'undo'].push(clone(current))
      return this.result(root, input.sessionId, saved)
    })
  }

  private async initialize(root: string): Promise<VideoProject> {
    const timestamp = this.now().toISOString()
    const project: VideoProject = {
      schemaVersion: 2,
      projectId: randomUUID(),
      name: basename(root) || '未命名剪辑',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      assets: [],
      tracks: [{ id: 'main', kind: 'video', name: '主画面', index: 0 }],
      clips: [],
      subtitles: [],
      canvas: { fit: 'contain', background: '#000000' },
    }
    await this.validateProject(root, project)
    await prepareProjectLayout(
      root,
      project.projectId,
      project.assets,
      this.options.stateRoot,
    )
    await this.ensureDirectory(root, 'assets')
    await this.ensureDirectory(root, WORKSPACE_DIRECTORY)
    await writeJsonAtomic(resolve(root, TIMELINE_FILE), project)
    return project
  }

  private async readBoundProject(
    root: string,
    sessionId: string,
  ): Promise<VideoProject> {
    if (this.blockedLayouts.has(root))
      error(this.blockedLayouts.get(root)!, 'project_migration_blocked')
    const metadata = await this.readWorkspaceMetadata(root)
    if (metadata?.chatSessionId !== sessionId)
      error('当前会话未绑定这个剪辑工程。', 'workspace_session_required')
    const manifest = metadata.manifest ?? (await this.findManifest(root))
    if (!manifest) error('剪辑工程清单无法读取。', 'project_invalid')
    const loaded = await this.loadProject(root, manifest)
    if (metadata.projectId !== loaded.project.projectId)
      error(
        '工程绑定已经改变，请从文件夹重新打开。',
        'workspace_session_required',
      )
    this.rememberMotionSetting(sessionId, metadata.motionEnabled === true)
    return loaded.project
  }

  private async persistMigration(
    root: string,
    project: VideoProject,
  ): Promise<VideoProject> {
    const migrations = resolve(root, MIGRATIONS_DIRECTORY)
    await this.ensureDirectory(root, MIGRATIONS_DIRECTORY)
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const path = this.manifestPath(project)
    await copyFile(
      path,
      resolve(migrations, `${basename(path, '.json')}-v1-${stamp}.json`),
    )
    return this.saveNext(root, project, project)
  }

  private async loadProject(
    root: string,
    manifest: ProjectManifestFile,
  ): Promise<{ project: VideoProject; migrated: boolean }> {
    const path = resolve(root, manifest)
    let raw: unknown
    try {
      if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
        throw new Error('invalid manifest')
      raw = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      error(
        `剪辑工程已损坏或无法读取，请恢复 ${manifest} 后重试。`,
        'project_invalid',
      )
    }
    const version =
      raw && typeof raw === 'object' && 'schemaVersion' in raw
        ? (raw as { schemaVersion?: unknown }).schemaVersion
        : undefined
    let project: VideoProject
    let migrated = false
    if (version === 1) {
      const parsed = videoProjectSchemaV1.safeParse(raw)
      if (!parsed.success)
        error(`剪辑工程格式无效，请恢复有效的 ${manifest}。`, 'project_invalid')
      project = migrateVideoProjectV1(parsed.data)
      migrated = true
    } else {
      const parsed = videoProjectSchema.safeParse(raw)
      if (!parsed.success)
        error(`剪辑工程格式无效，请恢复有效的 ${manifest}。`, 'project_invalid')
      project = parsed.data
    }
    await this.validateProject(root, project)
    this.manifestPaths.set(project, path)
    return { project, migrated }
  }

  private async validateProject(
    root: string,
    project: VideoProject,
  ): Promise<void> {
    assertValidVideoProject(project)
    const missing: string[] = []
    for (const asset of project.assets) {
      if (!(await this.assertAssetContained(root, asset.path)))
        missing.push(asset.id)
    }
    this.missingAssets.set(project, missing)
  }

  private async saveNext(
    root: string,
    current: VideoProject,
    next: VideoProject,
    signal?: AbortSignal,
  ): Promise<VideoProject> {
    const saved = clone(next)
    saved.revision = current.revision + 1
    saved.updatedAt = this.now().toISOString()
    await this.validateProject(root, saved)
    signal?.throwIfAborted()
    await writeJsonAtomic(this.manifestPath(current), saved, { signal })
    return saved
  }

  private async importSource(sourcePath: string): Promise<{
    canonicalPath: string
    extension: string
    kind: VideoAsset['kind']
  }> {
    if (!isAbsolute(sourcePath))
      error('导入路径必须是绝对路径。', 'invalid_import')
    const extension = extname(sourcePath).toLowerCase()
    const kind = ['.mp4', '.mov', '.m4v', '.webm'].includes(extension)
      ? ('video' as const)
      : ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)
        ? ('image' as const)
        : ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)
          ? ('audio' as const)
          : null
    if (kind === null)
      error(
        `不支持 ${extension || '这种'} 文件，请选择视频、音频或图片。`,
        'unsupported_media',
      )
    let canonicalPath: string
    try {
      canonicalPath = await realpath(sourcePath)
      if (!(await stat(canonicalPath)).isFile()) throw new Error('not file')
    } catch {
      error('导入素材不存在或不是文件。', 'invalid_import')
    }
    return { canonicalPath, extension, kind }
  }

  private async rootForSession(sessionId: string): Promise<string> {
    if (!sessionId || sessionId.startsWith(DRAFT_SESSION_PREFIX))
      error('剪辑操作需要持久 Build 会话。', 'workspace_session_required')
    const session = this.options.getSession(sessionId)
    if (
      !session ||
      session.archived_at ||
      session.mode !== 'build' ||
      !session.project_path
    )
      error(
        '剪辑操作需要有效的 Build 工作区会话。',
        'workspace_session_required',
      )
    return this.canonicalRoot(session.project_path)
  }

  private async canonicalRoot(projectPath: string): Promise<string> {
    try {
      const root = await realpath(resolve(projectPath))
      if (!(await stat(root)).isDirectory()) throw new Error('not directory')
      return root
    } catch {
      error('工作区文件夹不存在或不可读。', 'workspace_not_found')
    }
  }

  private manifestPath(project: VideoProject): string {
    const path = this.manifestPaths.get(project)
    if (!path) error('剪辑工程清单无法读取。', 'project_invalid')
    return path
  }

  private async findManifest(
    root: string,
  ): Promise<ProjectManifestFile | undefined> {
    for (const filename of VIDEO_PROJECT_MANIFEST_FILES)
      if (await this.exists(resolve(root, filename))) return filename
  }

  private assetPath(root: string, projectRelativePath: string): string {
    if (
      isAbsolute(projectRelativePath) ||
      projectRelativePath.includes('\\') ||
      projectRelativePath.includes('\0') ||
      posix.normalize(projectRelativePath) !== projectRelativePath ||
      projectRelativePath.startsWith('../') ||
      projectRelativePath === '..'
    )
      error('工程包含无效素材路径。', 'project_invalid')
    const target = resolve(root, projectRelativePath)
    const rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      error('工程素材路径超出工作区。', 'project_invalid')
    return target
  }

  private async assertAssetContained(
    root: string,
    projectRelativePath: string,
  ): Promise<boolean> {
    const target = this.assetPath(root, projectRelativePath)
    // Inspect each existing parent even when the last path component is missing.
    let parent = root
    for (const component of relative(root, dirname(target))
      .split(sep)
      .filter(Boolean)) {
      parent = resolve(parent, component)
      if (!(await this.checkDirectory(parent))) return false
    }
    try {
      const info = await lstat(target)
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        (await realpath(target)) !== target
      )
        error('工作区素材必须是工作区内的普通文件。', 'workspace_path_escape')
      return true
    } catch (cause) {
      if (cause instanceof EmperorError) throw cause
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      error('工程素材不可读。', 'asset_missing')
    }
  }

  private async checkDirectory(path: string): Promise<boolean> {
    try {
      if (!(await lstat(path)).isDirectory())
        error('工作区目录必须是普通目录。', 'workspace_path_escape')
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw cause
    }
  }

  private async ensureDirectory(
    root: string,
    relativePath: string,
  ): Promise<void> {
    let path = root
    for (const component of relativePath.split('/')) {
      path = resolve(path, component)
      if (!(await this.checkDirectory(path))) await mkdir(path)
    }
  }

  private async readWorkspaceMetadata(
    root: string,
    legacy = false,
  ): Promise<WorkspaceMetadata | null> {
    const raw = await readPrivateMetadata(root, legacy)
    if (raw === null) return null
    const parsed = workspaceMetadataSchema.safeParse(raw)
    if (!parsed.success)
      error('工作区绑定无效，请从备份恢复后重试。', 'project_invalid')
    return parsed.data
  }

  private async writeWorkspaceMetadata(
    root: string,
    metadata: WorkspaceMetadata,
  ): Promise<void> {
    await this.ensureDirectory(root, WORKSPACE_DIRECTORY)
    await writeJsonAtomic(resolve(root, WORKSPACE_FILE), metadata)
  }

  private assertRevision(
    project: VideoProject,
    expectedRevision: number,
  ): void {
    if (project.revision !== expectedRevision)
      error('工程已在其他位置更新，请重新加载后再编辑。', 'revision_conflict')
  }

  private history(root: string, project: VideoProject): HistoryEntry {
    let history = this.histories.get(root)
    if (
      history?.projectId !== project.projectId ||
      history.revision !== project.revision
    ) {
      history = {
        projectId: project.projectId,
        revision: project.revision,
        undo: [],
        redo: [],
      }
      this.histories.set(root, history)
    }
    return history
  }

  private result(
    root: string,
    sessionId: string,
    project: VideoProject,
    selectedClipId?: string | null,
    selectedSubtitleId?: string | null,
    selectedMotionSceneId?: string | null,
  ): VideoProjectResult {
    const history = this.history(root, project)
    return {
      missingAssetIds: this.missingAssets.get(project) ?? [],
      project,
      sessionId,
      projectPath: root,
      ...(selectedClipId !== undefined ? { selectedClipId } : {}),
      ...(selectedSubtitleId !== undefined ? { selectedSubtitleId } : {}),
      ...(selectedMotionSceneId !== undefined ? { selectedMotionSceneId } : {}),
      canUndo: (history?.undo.length ?? 0) > 0,
      canRedo: (history?.redo.length ?? 0) > 0,
    }
  }

  private async serialized<T>(
    root: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(root) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(action)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(root, settled)
    try {
      return await run
    } finally {
      if (this.locks.get(root) === settled) this.locks.delete(root)
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      error('剪辑工程清单无法读取。', 'project_invalid')
    }
  }
}
