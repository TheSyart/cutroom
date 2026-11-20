import { computed, reactive, toRaw } from 'vue'
import type {
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core/api'
import {
  clipTimelineDuration,
  MOTION_FPS,
  motionTimelineFrame,
  type MotionScene,
  timelineClipsAt,
  minSplitTimelineOffset,
  timelineLayout,
  type TimelineChip,
  type TimelineSnapshot,
  type TimelineReferenceTarget,
  type VideoAsset,
  type VideoProjectCommand,
  type VideoProjectMetadataInput,
  type VideoProjectOpenInput,
  type VideoProjectResult,
} from '@emperor/core/editing'
import { timelineLabel, timelineTargetDetail } from './timelineReference'
export type { TimelineReferenceTarget } from '@emperor/core/editing'
import { readLocalMediaMetadata } from './mediaMetadata'
import { core } from '../../api/http'
import { useSession } from '../../composables/useSession'
import { selectDirectory, selectMediaFiles } from '../../api/backend'
import { confirm, type ConfirmOptions } from '../ui/confirm'

export type EditingCore = <Key extends CoreOperationKey>(
  operation: Key,
  ...args: CoreOperationArgs<Key>
) => Promise<CoreOperationResult<Key>>

export interface WorkspaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface EditingWorkspaceDependencies {
  core: EditingCore
  selectDirectory(options?: {
    title?: string
    createDirectory?: boolean
  }): Promise<string | null>
  selectMediaFiles(): Promise<string[]>
  confirm(options: ConfirmOptions): Promise<boolean>
  storage?: WorkspaceStorage
  /** Refresh the renderer's session list after a workspace opens. */
  refreshSessions?: () => Promise<void>
}

export interface ProjectOrigin {
  sessionId: string
  projectId: string
  revision: number
  generation: number
}

export type InspectorTab = 'clip' | 'canvas' | 'speed' | 'audio' | 'subtitle'
type ProjectView = 'live' | 'draft'
type EditRunDraft = NonNullable<
  CoreOperationResult<'videoProject.editRunDraft'>
>
export type MotionWork = NonNullable<
  CoreOperationResult<'videoProject.motionWork'>
>
type TimeRange = { start: number; end: number }
function initialPosition() {
  return {
    selectedMotionSceneId: null as string | null,
    selectedMotionObjectId: null as string | null,
    selectedMotionMarkerFrame: null as number | null,
    selectedMotionVersion: null as number | null,
    selectedClipId: null as string | null,
    selectedSubtitleId: null as string | null,
    selectedTrackId: null as string | null,
    selectedAssetId: null as string | null,
    activeTab: 'canvas' as InspectorTab,
    playhead: 0,
  }
}

function setMotionSelection(
  position: ReturnType<typeof initialPosition>,
  scene?: MotionScene,
  objectId?: string,
  markerFrame?: number,
): void {
  position.selectedMotionSceneId = scene?.id ?? null
  position.selectedMotionObjectId = objectId ?? null
  position.selectedMotionMarkerFrame = markerFrame ?? null
  position.selectedMotionVersion = scene?.version ?? null
}

export interface RecentVideoProject {
  projectPath: string
  name: string
  sessionId: string
  openedAt: string
  /** Unknown until the project has been opened once in this app. */
  assetCount?: number
  clipCount?: number
}

const RECENT_PROJECTS_KEY = 'video-edit-agent:recent-projects'
const MAX_RECENT_PROJECTS = 12

function browserStorage(): WorkspaceStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function code(cause: unknown): string {
  return typeof (cause as { code?: unknown })?.code === 'string'
    ? (cause as { code: string }).code
    : ''
}

function readRecentProjects(
  storage: WorkspaceStorage | undefined,
): RecentVideoProject[] {
  if (!storage) return []
  try {
    const parsed = JSON.parse(
      storage.getItem(RECENT_PROJECTS_KEY) ?? '[]',
    ) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== 'object') return false
        const value = item as Record<string, unknown>
        return (
          typeof value.projectPath === 'string' &&
          typeof value.name === 'string' &&
          typeof value.sessionId === 'string' &&
          typeof value.openedAt === 'string'
        )
      })
      .map((value) => ({
        projectPath: value.projectPath as string,
        name: value.name as string,
        sessionId: value.sessionId as string,
        openedAt: value.openedAt as string,
        ...(typeof value.assetCount === 'number'
          ? { assetCount: value.assetCount }
          : {}),
        ...(typeof value.clipCount === 'number'
          ? { clipCount: value.clipCount }
          : {}),
      }))
      .slice(0, MAX_RECENT_PROJECTS)
  } catch {
    return []
  }
}

export function createEditingWorkspace(
  dependencies: EditingWorkspaceDependencies,
) {
  const livePosition = reactive(initialPosition())
  const draftPosition = reactive(initialPosition())
  function position() {
    return state.view === 'draft' ? draftPosition : livePosition
  }
  const state = reactive({
    readOnlySnapshot: null as VideoProjectResult | null,
    project: null as VideoProjectResult['project'] | null,
    draft: null as EditRunDraft | null,
    view: 'live' as ProjectView,
    sessionId: '',
    projectPath: '',
    missingAssetIds: [] as string[],
    motionEnabled: false,
    motionSettingsBusy: false,
    motionWork: null as MotionWork | null,
    motionFollow: true,
    motionCue: null as {
      sceneId: string
      objectId: string
      seq: number
    } | null,
    auditionEnd: null as number | null,
    get selectedMotionSceneId(): string | null {
      return position().selectedMotionSceneId
    },
    get selectedMotionObjectId(): string | null {
      return position().selectedMotionObjectId
    },
    get selectedMotionMarkerFrame(): number | null {
      return position().selectedMotionMarkerFrame
    },
    metadataErrors: {} as Record<string, string>,
    get selectedClipId(): string | null {
      return position().selectedClipId
    },
    set selectedClipId(value: string | null) {
      position().selectedClipId = value
    },
    get selectedSubtitleId(): string | null {
      return position().selectedSubtitleId
    },
    set selectedSubtitleId(value: string | null) {
      position().selectedSubtitleId = value
    },
    get selectedTrackId(): string | null {
      return position().selectedTrackId
    },
    set selectedTrackId(value: string | null) {
      position().selectedTrackId = value
    },
    get selectedAssetId(): string | null {
      return position().selectedAssetId
    },
    set selectedAssetId(value: string | null) {
      position().selectedAssetId = value
    },
    get activeTab(): InspectorTab {
      return position().activeTab
    },
    set activeTab(value: InspectorTab) {
      position().activeTab = value
    },
    get playhead(): number {
      return position().playhead
    },
    set playhead(value: number) {
      position().playhead = value
    },
    referenceFocus: null as TimelineSnapshot | null,
    seekRevision: 0,
    playing: false,
    loading: false,
    saving: false,
    error: '',
    canUndo: false,
    canRedo: false,
    recentProjects: readRecentProjects(dependencies.storage),
  })
  let openGeneration = 0
  let leavingWorkspace: Promise<void> | null = null
  let mutationQueue: Promise<unknown> = Promise.resolve()
  let savingCount = 0
  let pendingFocus: { clipId?: string; time?: number } | null = null
  let draftRequest = 0
  let cueTimer: ReturnType<typeof setTimeout> | undefined
  let priorMotionPosition: ReturnType<typeof initialPosition> | null = null
  let motionSettingsRequest = 0
  const retiredMotionIds = new Set<string>()
  const departedMotionIds = new Map<string, string>()
  const preferredViews = new Map<string, ProjectView>()
  const supersededRuns = new Set<string>()

  const readOnly = computed(() => state.view === 'draft')
  const displayProject = computed(() =>
    readOnly.value ? (state.draft?.project ?? null) : state.project,
  )
  const displayMissingAssetIds = computed(() =>
    readOnly.value
      ? (state.draft?.missingAssetIds ?? [])
      : state.missingAssetIds,
  )
  const deliveredRevisionLoaded = computed(
    () =>
      state.draft?.state === 'delivered' &&
      state.draft.revision !== undefined &&
      (state.project?.revision ?? -1) >= state.draft.revision,
  )
  const draftAvailable = computed(() =>
    Boolean(
      state.draft &&
      (state.draft.generation ||
        (activeMotion.value?.target === 'draft' &&
          activeMotion.value.runId === state.draft.runId)) &&
      !deliveredRevisionLoaded.value,
    ),
  )
  const activeMotion = computed(() => {
    const work = state.motionWork
    if (!work || !['preparing', 'drawing'].includes(work.status)) return null
    if (
      work.target === 'draft' &&
      state.draft &&
      (work.runId !== state.draft.runId ||
        (work.generation !== undefined &&
          work.generation !== state.draft.generation) ||
        ['delivered', 'cancelled', 'blocked', 'paused'].includes(
          state.draft.state,
        ))
    )
      return null
    return work
  })
  const visibleMotionWork = computed(() => {
    const work = activeMotion.value
    if (!work || work.target !== state.view) return null
    if (work.target === 'draft' && work.runId !== state.draft?.runId)
      return null
    return work
  })
  function canEditMotionScene(id: string): boolean {
    const work = visibleMotionWork.value
    return !readOnly.value && (work?.sceneId ?? work?.scene?.id) !== id
  }
  const motionScenes = computed<MotionScene[]>(() => {
    const scenes = displayProject.value?.motionScenes ?? []
    const stage = visibleMotionWork.value?.scene
    if (!stage) return scenes
    return scenes.some((scene) => scene.id === stage.id)
      ? scenes.map((scene) => (scene.id === stage.id ? stage : scene))
      : [...scenes, stage]
  })
  const selectedMotionScene = computed(() =>
    motionScenes.value.find(
      (scene) => scene.id === state.selectedMotionSceneId,
    ),
  )
  const deleteTarget = computed<{
    command: VideoProjectCommand
    label: string
    confirmBody?: string
  } | null>(() => {
    if (!state.project || state.loading || readOnly.value) return null
    if (state.selectedMotionSceneId) {
      const scene = selectedMotionScene.value
      if (
        !scene ||
        !canEditMotionScene(scene.id) ||
        position().selectedMotionVersion !== scene.version ||
        state.selectedMotionMarkerFrame !== null
      )
        return null
      const sceneId = scene.id
      const expectedVersion = scene.version
      if (state.selectedMotionObjectId) {
        const object = scene.objects.find(
          (item) => item.id === state.selectedMotionObjectId,
        )
        if (!object) return null
        if (scene.objects.length > 1)
          return {
            command: {
              type: 'deleteMotionObject',
              sceneId,
              objectId: object.id,
              expectedVersion,
            },
            label: '删除对象',
          }
        return {
          command: { type: 'deleteMotionScene', sceneId, expectedVersion },
          label: '删除整幕',
          confirmBody: `「${object.name}」是「${scene.name}」的最后一个对象。删除整幕将一并移除这个对象及其动作。`,
        }
      }
      return {
        command: { type: 'deleteMotionScene', sceneId, expectedVersion },
        label: '删除整幕',
      }
    }
    const subtitleId = state.selectedSubtitleId
    if (
      subtitleId &&
      state.project.subtitles.some((cue) => cue.id === subtitleId)
    )
      return {
        command: { type: 'deleteSubtitle', subtitleId },
        label: '删除字幕',
      }
    const clipId = state.selectedClipId
    if (clipId && state.project.clips.some((clip) => clip.id === clipId))
      return { command: { type: 'deleteClip', clipId }, label: '删除片段' }
    return null
  })
  const canDelete = computed(() => Boolean(deleteTarget.value))
  const deleteLabel = computed(() => deleteTarget.value?.label ?? '删除')

  const layout = computed(() => {
    if (!displayProject.value)
      return { tracks: [], clips: [], subtitles: [], totalDuration: 0 }
    const layout = timelineLayout(displayProject.value)
    // Include working scenes before their individual objects have been committed.
    const stage = visibleMotionWork.value?.scene
    if (stage && stage.anchor?.status !== 'lost')
      layout.totalDuration = Math.max(
        layout.totalDuration,
        (stage.startFrame + stage.durationFrames) / MOTION_FPS,
      )
    return layout
  })
  const selectedRange = computed<TimeRange | null>(() => {
    const scene = selectedMotionScene.value
    if (
      scene &&
      (state.selectedMotionObjectId ||
        (!readOnly.value && !canEditMotionScene(scene.id)))
    )
      return null
    if (scene)
      return {
        start: scene.startFrame / MOTION_FPS,
        end: (scene.startFrame + scene.durationFrames) / MOTION_FPS,
      }
    const { selectedClipId, selectedSubtitleId } = state
    const range = selectedSubtitleId
      ? layout.value.subtitles.find((cue) => cue.id === selectedSubtitleId)
      : layout.value.clips.find((clip) => clip.clipId === selectedClipId)
    return range ? { start: range.start, end: range.end } : null
  })

  function switchView(view: ProjectView): void {
    if (state.view === view) return
    stopAudition()
    state.referenceFocus = null
    state.playing = false
    state.view = view
    state.seekRevision += 1
  }

  function selectView(view: ProjectView): void {
    if (!draftAvailable.value || !state.draft) return
    takeMotionControl()
    preferredViews.set(state.draft.runId, view)
    switchView(view)
  }

  function stopAudition(): void {
    if (state.auditionEnd !== null) state.playing = false
    state.auditionEnd = null
  }

  function takeMotionControl(): void {
    state.referenceFocus = null
    priorMotionPosition = null
    if (activeMotion.value) state.motionFollow = false
    clearCue()
    stopAudition()
  }

  function resetMotion(): void {
    state.referenceFocus = null
    priorMotionPosition = null
    motionSettingsRequest++
    clearCue()
    stopAudition()
    state.motionWork = null
    state.motionFollow = true
    state.motionEnabled = false
    state.motionSettingsBusy = false
    retiredMotionIds.clear()
    setMotionSelection(livePosition)
  }

  function interruptMotion(): void {
    const work = activeMotion.value
    if (!work) return
    retiredMotionIds.add(work.id)
    clearCue()
    stopAudition()
    state.motionWork = {
      ...work,
      scene: null,
      status: 'cancelled',
      message: '动效绘制已停止',
    }
    restoreCancelledPosition(work)
  }

  function applyMotionWork(work: MotionWork, follow = true): void {
    const recoveredCommit =
      work?.status === 'committed' &&
      state.motionWork?.id === work.id &&
      state.motionWork.status === 'cancelled'
    if (
      !work ||
      state.loading ||
      !state.project ||
      (retiredMotionIds.has(work.id) && !recoveredCommit) ||
      (departedMotionIds.get(state.sessionId) === work.id &&
        (work.status === 'preparing' || work.status === 'drawing')) ||
      (state.motionWork && work.seq <= state.motionWork.seq) ||
      (work.target === 'draft' && work.runId && supersededRuns.has(work.runId))
    )
      return
    const previous = state.motionWork
    if (previous?.id !== work.id) {
      if (previous) retiredMotionIds.add(previous.id)
      stopAudition()
      priorMotionPosition = null
      state.motionFollow = !state.playing
    }
    state.motionWork = work
    if (work.status !== 'drawing' && work.status !== 'preparing') {
      clearCue()
      stopAudition()
      retiredMotionIds.add(work.id)
      if (work.status !== 'committed') restoreCancelledPosition(work)
      else if (recoveredCommit) {
        // The service may have atomically saved just before the user pressed Stop.
        const refresh =
          work.target === 'draft' ? refreshDraft() : refreshFromDisk()
        void refresh.catch(() => undefined)
      }
      priorMotionPosition = null
      return
    }
    if (
      work.target === 'draft' &&
      work.runId &&
      work.runId === state.draft?.runId &&
      !preferredViews.has(work.runId) &&
      !state.playing
    )
      switchView('draft')
    if (follow && state.motionFollow) showLatestMotionStep(true)
  }

  function restoreCancelledPosition(work: MotionWork): void {
    if (work.target === 'draft' && state.draft?.runId !== work.runId) return
    const position = work.target === 'draft' ? draftPosition : livePosition
    const project =
      work.target === 'draft' ? state.draft?.project : state.project
    if (!project) return
    if (state.motionFollow && priorMotionPosition)
      Object.assign(position, priorMotionPosition)
    if (
      !project.motionScenes?.some(
        (scene) => scene.id === position.selectedMotionSceneId,
      )
    ) {
      setMotionSelection(position)
    }
    position.playhead = Math.min(
      position.playhead,
      timelineLayout(project).totalDuration,
    )
    if (state.view === work.target) state.seekRevision++
    priorMotionPosition = null
  }

  function clearCue(): void {
    if (cueTimer !== undefined) clearTimeout(cueTimer)
    cueTimer = undefined
    state.motionCue = null
  }

  function showLatestMotionStep(audition: boolean): void {
    const work = visibleMotionWork.value
    if (
      work?.status !== 'drawing' ||
      !work.scene ||
      work.frame === undefined ||
      (state.playing && state.auditionEnd === null)
    )
      return
    stopAudition()
    clearCue()
    priorMotionPosition ??= { ...position() }
    const scene = work.scene
    const frame = Math.max(
      scene.startFrame,
      Math.min(scene.startFrame + scene.durationFrames - 1, work.frame),
    )
    const end = Math.min(
      scene.startFrame + scene.durationFrames,
      work.endFrame ?? frame + 1,
      frame + MOTION_FPS * 2,
    )
    setMotionSelection(position(), scene)
    state.selectedClipId = null
    state.selectedSubtitleId = null
    seekPlayhead(frame / MOTION_FPS)
    const object = scene.objects.find((o) => o.id === work.objectId)
    if (object) {
      state.motionCue = {
        sceneId: scene.id,
        objectId: object.id,
        seq: work.seq,
      }
      cueTimer = setTimeout(clearCue, 1250)
    }
    if (audition && object?.draw.trim() && end > frame + 1) {
      state.auditionEnd = (end - 1) / MOTION_FPS
      state.playing = true
    }
  }

  function resumeMotionFollow(): void {
    const work = activeMotion.value
    if (
      !state.playing &&
      work?.target === 'draft' &&
      work.runId &&
      work.runId === state.draft?.runId
    ) {
      preferredViews.set(work.runId, 'draft')
      switchView('draft')
    }
    state.motionFollow = true
    showLatestMotionStep(false)
  }

  async function refreshMotion(): Promise<void> {
    const origin = captureProject()
    const request = ++motionSettingsRequest
    if (!isCurrent(origin)) return
    state.motionSettingsBusy = true
    const input = { sessionId: origin.sessionId }
    await Promise.all([
      dependencies
        .core('videoProject.motionSettings', input)
        .then((result) => {
          if (isCurrent(origin) && request === motionSettingsRequest)
            state.motionEnabled = result.enabled
        })
        .finally(() => {
          if (isCurrent(origin) && request === motionSettingsRequest)
            state.motionSettingsBusy = false
        }),
      dependencies.core('videoProject.motionWork', input).then((work) => {
        if (work && isCurrent(origin)) applyMotionWork(work, false)
      }),
    ])
  }

  async function setMotionEnabled(enabled: boolean): Promise<void> {
    const origin = captureProject()
    if (!isCurrent(origin) || state.motionSettingsBusy) return
    const request = ++motionSettingsRequest
    state.motionSettingsBusy = true
    try {
      const settings = await dependencies.core(
        'videoProject.setMotionEnabled',
        { sessionId: origin.sessionId, enabled },
      )
      if (isCurrent(origin) && request === motionSettingsRequest) {
        state.motionEnabled = settings.enabled
        if (!settings.enabled) interruptMotion()
      }
    } catch (cause) {
      if (isCurrent(origin)) state.error = message(cause)
    } finally {
      if (isCurrent(origin) && request === motionSettingsRequest)
        state.motionSettingsBusy = false
    }
  }

  function clearMotionSelection(): void {
    takeMotionControl()
    setMotionSelection(position())
  }

  function selectMotion(
    scene: MotionScene,
    objectId?: string,
    markerFrame?: number,
  ): void {
    takeMotionControl()
    const current = motionScenes.value.find((item) => item.id === scene.id)
    const object = current?.objects.find((item) => item.id === objectId)
    if (
      !current ||
      toRaw(current) !== toRaw(scene) ||
      (objectId !== undefined && !object) ||
      (markerFrame !== undefined &&
        !object?.markers.some((marker) => marker.frame === markerFrame))
    )
      return
    setMotionSelection(position(), current, objectId, markerFrame)
    state.selectedClipId = null
    state.selectedSubtitleId = null
    state.activeTab = 'canvas'
    const frame =
      markerFrame === undefined ? null : motionTimelineFrame(scene, markerFrame)
    const at = Math.floor(state.playhead * MOTION_FPS + 1e-7)
    if (
      frame !== null ||
      at < scene.startFrame ||
      at >= scene.startFrame + scene.durationFrames
    )
      seekPlayhead((frame ?? scene.startFrame) / MOTION_FPS)
  }

  function resetDraft(): void {
    draftRequest += 1
    switchView('live')
    state.draft = null
    supersededRuns.clear()
    Object.assign(draftPosition, initialPosition())
  }

  function settleDelivery(): void {
    if (!deliveredRevisionLoaded.value || !readOnly.value) return
    livePosition.playhead = Math.min(
      draftPosition.playhead,
      state.project ? timelineLayout(state.project).totalDuration : 0,
    )
    switchView('live')
  }

  function captureProject(): ProjectOrigin {
    return {
      sessionId: state.sessionId,
      projectId: state.project?.projectId ?? '',
      revision: state.project?.revision ?? -1,
      generation: openGeneration,
    }
  }

  function isCurrent(origin: ProjectOrigin): boolean {
    return Boolean(
      origin.projectId &&
      origin.sessionId &&
      origin.generation === openGeneration &&
      origin.sessionId === state.sessionId &&
      origin.projectId === state.project?.projectId &&
      !state.loading,
    )
  }

  function accepts(origin: ProjectOrigin, result: VideoProjectResult): boolean {
    return (
      isCurrent(origin) &&
      result.sessionId === origin.sessionId &&
      result.project.projectId === origin.projectId
    )
  }

  function recordRecent(result: VideoProjectResult): void {
    const entry: RecentVideoProject = {
      projectPath: result.projectPath,
      name: result.project.name,
      sessionId: result.sessionId,
      openedAt: new Date().toISOString(),
      assetCount: result.project.assets.length,
      clipCount: result.project.clips.length,
    }
    state.recentProjects = [
      entry,
      ...state.recentProjects.filter(
        (item) => item.projectPath !== entry.projectPath,
      ),
    ].slice(0, MAX_RECENT_PROJECTS)
    dependencies.storage?.setItem(
      RECENT_PROJECTS_KEY,
      JSON.stringify(state.recentProjects),
    )
  }

  function applyResult(result: VideoProjectResult, opening = false): void {
    if (opening) {
      resetMotion()
      state.metadataErrors = {}
    }
    state.missingAssetIds = result.missingAssetIds ?? []
    state.project = result.project
    state.sessionId = result.sessionId
    state.projectPath = result.projectPath
    state.canUndo = result.canUndo
    state.canRedo = result.canRedo
    if (result.selectedMotionSceneId !== undefined) {
      setMotionSelection(
        livePosition,
        result.project.motionScenes?.find(
          (scene) => scene.id === result.selectedMotionSceneId,
        ),
      )
    }
    if (
      !result.project.motionScenes?.some(
        (s) => s.id === livePosition.selectedMotionSceneId,
      ) &&
      activeMotion.value?.scene?.id !== livePosition.selectedMotionSceneId
    ) {
      setMotionSelection(livePosition)
    }
    if (result.selectedSubtitleId || result.selectedClipId) {
      setMotionSelection(livePosition)
    }
    if (result.selectedSubtitleId !== undefined) {
      livePosition.selectedSubtitleId = result.selectedSubtitleId
      if (result.selectedSubtitleId !== null) {
        livePosition.selectedClipId = null
        livePosition.activeTab = 'subtitle'
      } else if (livePosition.activeTab === 'subtitle') {
        livePosition.activeTab = result.project.clips.length ? 'clip' : 'canvas'
      }
    }
    if (result.selectedClipId !== undefined) {
      livePosition.selectedClipId = result.selectedClipId
      if (result.selectedClipId !== null) {
        livePosition.selectedSubtitleId = null
        if (livePosition.activeTab === 'subtitle')
          livePosition.activeTab = 'clip'
      }
    } else if (
      opening ||
      (result.selectedMotionSceneId === undefined &&
        !livePosition.selectedMotionSceneId &&
        !livePosition.selectedSubtitleId &&
        !result.project.clips.some(
          (clip) => clip.id === livePosition.selectedClipId,
        ))
    ) {
      livePosition.selectedClipId = result.project.clips[0]?.id ?? null
    }
    if (
      livePosition.selectedSubtitleId !== null &&
      !result.project.subtitles.some(
        (cue) => cue.id === livePosition.selectedSubtitleId,
      )
    ) {
      livePosition.selectedSubtitleId = null
      if (livePosition.activeTab === 'subtitle')
        livePosition.activeTab = 'canvas'
    }
    if (
      livePosition.selectedTrackId === null ||
      !result.project.tracks.some(
        (track) => track.id === livePosition.selectedTrackId,
      )
    )
      livePosition.selectedTrackId =
        result.project.tracks.find((track) => track.index === 0)?.id ??
        result.project.tracks[0]?.id ??
        null
    if (livePosition.selectedMotionSceneId) {
      livePosition.selectedClipId = null
      livePosition.selectedSubtitleId = null
    }
    if (opening) {
      pendingFocus = null
      livePosition.selectedSubtitleId = null
      livePosition.selectedAssetId = result.project.assets[0]?.id ?? null
      livePosition.activeTab = result.project.clips.length ? 'clip' : 'canvas'
      livePosition.playhead = 0
      state.seekRevision += 1
      state.playing = false
    }
    if (
      !result.project.assets.some(
        (asset) => asset.id === livePosition.selectedAssetId,
      )
    )
      livePosition.selectedAssetId = result.project.assets[0]?.id ?? null
    livePosition.playhead = Math.min(
      livePosition.playhead,
      timelineLayout(result.project).totalDuration,
    )
    settleDelivery()
  }

  function leaveMotionWorkspace(sessionId: string): Promise<void> {
    if (state.motionWork) departedMotionIds.set(sessionId, state.motionWork.id)
    interruptMotion()
    const leaving = Promise.resolve(
      dependencies.core('videoProject.leaveMotionWorkspace', { sessionId }),
    )
    leavingWorkspace = leaving
    void leaving
      .finally(() => {
        if (leavingWorkspace === leaving) leavingWorkspace = null
      })
      .catch(() => undefined)
    return leaving
  }

  async function openProject(input: VideoProjectOpenInput): Promise<boolean> {
    const generation = ++openGeneration
    state.loading = true
    state.error = ''
    try {
      if (leavingWorkspace) await leavingWorkspace
      if (generation !== openGeneration) return false
      const result = await dependencies.core('videoProject.open', input)
      if (
        generation === openGeneration &&
        state.sessionId &&
        state.sessionId !== result.sessionId
      )
        await leaveMotionWorkspace(state.sessionId)
      if (generation !== openGeneration) return false
      if (result.readOnlyReason) {
        closeProject()
        state.readOnlySnapshot = result
        state.loading = false
        return true
      }
      state.readOnlySnapshot = null
      resetDraft()
      applyResult(result, true)
      if (result.editRunRecovery) state.error = result.editRunRecovery
      recordRecent(result)
      await dependencies.refreshSessions?.().catch(() => undefined)
      return true
    } catch (cause) {
      if (generation === openGeneration) state.error = message(cause)
      throw cause
    } finally {
      if (generation === openGeneration) state.loading = false
    }
  }

  /** Initial page: create a project in a chosen folder, or open it if it exists. */
  async function createProject(): Promise<boolean> {
    const path = (
      await dependencies.selectDirectory({
        title: '选择新项目文件夹',
        createDirectory: true,
      })
    )?.trim()
    if (!path) return false
    try {
      return await openProject({ projectPath: path })
    } catch (cause) {
      if (code(cause) !== 'project_not_initialized') return false
    }
    const accepted = await dependencies.confirm({
      title: '在这个文件夹新建剪辑？',
      body: '将在此文件夹创建 timeline.json、素材目录和工程设置。',
      confirmLabel: '新建剪辑',
    })
    if (!accepted) return false
    try {
      return await openProject({ projectPath: path, initialize: true })
    } catch {
      return false
    }
  }

  /** Initial page: open only an existing project; never initialize by surprise. */
  async function openFolder(): Promise<boolean> {
    const path = (
      await dependencies.selectDirectory({ title: '打开剪辑文件夹' })
    )?.trim()
    if (!path) return false
    try {
      return await openProject({ projectPath: path })
    } catch (cause) {
      if (code(cause) === 'project_not_initialized') {
        state.error =
          '这个文件夹还没有剪辑工程。请选择包含 timeline.json 或 video-edit.json 的文件夹，也可以在这里新建项目。'
        return false
      }
      return false
    }
  }

  async function pickWorkspace(): Promise<boolean> {
    const path = (await dependencies.selectDirectory())?.trim()
    if (!path) return false
    try {
      return await openProject({ projectPath: path })
    } catch (cause) {
      if (code(cause) !== 'project_not_initialized') return false
    }
    const accepted = await dependencies.confirm({
      title: '在这个文件夹新建剪辑？',
      body: '将在此文件夹创建 timeline.json、素材目录和工程设置。',
      confirmLabel: '新建剪辑',
    })
    if (!accepted) return false
    try {
      return await openProject({ projectPath: path, initialize: true })
    } catch {
      return false
    }
  }

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run = mutationQueue.catch(() => undefined).then(action)
    mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    savingCount += 1
    state.saving = true
    void run
      .finally(() => {
        savingCount -= 1
        state.saving = savingCount > 0
      })
      .catch(() => undefined)
    return run
  }

  async function importAssets(): Promise<VideoAsset[]> {
    if (readOnly.value) return []
    if (!state.project && !(await pickWorkspace())) return []
    const origin = captureProject()
    const sourcePaths = await dependencies.selectMediaFiles()
    if (!sourcePaths.length || !isCurrent(origin)) return []
    return enqueue(async () => {
      if (!isCurrent(origin)) return []
      const before = new Set(state.project!.assets.map((asset) => asset.id))
      try {
        const result = await dependencies.core('videoProject.importAssets', {
          sessionId: origin.sessionId,
          sourcePaths,
        })
        if (!accepts(origin, result)) return []
        applyResult(result)
        const assets = result.project.assets.filter(
          (asset) => !before.has(asset.id),
        )
        livePosition.selectedAssetId =
          assets[0]?.id ?? livePosition.selectedAssetId
        state.error = ''
        return assets
      } catch (cause) {
        if (isCurrent(origin)) state.error = message(cause)
        throw cause
      }
    })
  }

  function write(
    origin: ProjectOrigin,
    action: (revision: number) => Promise<VideoProjectResult>,
    exact = false,
    stillValid?: () => boolean,
  ): Promise<void> {
    return enqueue(async () => {
      if (stillValid && !stillValid()) return
      if (
        exact &&
        (!isCurrent(origin) || state.project?.revision !== origin.revision)
      )
        throw new Error('项目已切换或时间线已更改，请重新执行此操作。')
      if (!isCurrent(origin)) return
      try {
        const result = await action(state.project!.revision)
        if (!accepts(origin, result)) return
        // A live result always updates the manifest. Do not replace a newer UI selection.
        applyResult(
          stillValid && !stillValid()
            ? {
                ...result,
                selectedClipId: undefined,
                selectedSubtitleId: undefined,
                selectedMotionSceneId: undefined,
              }
            : result,
        )
        const focus = pendingFocus
        pendingFocus = null
        if (focus) applyAgentFocus(focus)
        state.error = ''
      } catch (cause) {
        if (isCurrent(origin)) state.error = message(cause)
        throw cause
      }
    })
  }

  function updateAssetMetadata(
    assetId: string,
    metadata: Pick<VideoProjectMetadataInput, 'duration' | 'width' | 'height'>,
    origin = captureProject(),
  ): Promise<void> {
    return write(origin, (expectedRevision) =>
      dependencies.core('videoProject.updateAssetMetadata', {
        sessionId: origin.sessionId,
        expectedRevision,
        assetId,
        ...metadata,
      }),
    )
  }

  async function probeAssets(
    assets: VideoAsset[],
    origin: ProjectOrigin,
    autoTranscribe = false,
  ) {
    const readyVideos: VideoAsset[] = []
    for (const asset of assets) {
      if (!isCurrent(origin)) return
      try {
        const metadata = await readLocalMediaMetadata(origin.sessionId, asset)
        if (
          !isCurrent(origin) ||
          !state.project?.assets.some(
            (a) => a.id === asset.id && a.path === asset.path,
          )
        )
          continue
        await updateAssetMetadata(asset.id, metadata, origin)
        if (!isCurrent(origin)) return
        delete state.metadataErrors[asset.id]
        if (asset.kind !== 'image') readyVideos.push(asset)
      } catch (cause) {
        if (isCurrent(origin)) state.metadataErrors[asset.id] = message(cause)
      }
    }
    if (!autoTranscribe || !readyVideos.length || !isCurrent(origin)) return
    const status = await dependencies
      .core('videoProject.analysisStatus')
      .catch(() => null)
    if (!status?.ready || !status.autoTranscribe) return
    for (const asset of readyVideos) {
      if (!isCurrent(origin)) return
      try {
        await dependencies.core('videoProject.transcribe', {
          sessionId: origin.sessionId,
          assetId: asset.id,
          language: status.language,
        })
      } catch (cause) {
        if (isCurrent(origin))
          state.error = `${asset.displayName} 自动转写失败：${message(cause)}`
      }
    }
  }

  async function relinkAsset(assetId: string): Promise<void> {
    if (readOnly.value) return
    const origin = captureProject()
    const files = await dependencies.selectMediaFiles()
    if (!isCurrent(origin) || !files.length) return
    if (files.length !== 1) {
      state.error = '请选择一个替换文件。'
      return
    }
    await write(origin, (expectedRevision) =>
      dependencies.core('videoProject.relinkAsset', {
        sessionId: origin.sessionId,
        expectedRevision,
        assetId,
        sourcePath: files[0]!,
      }),
    )
    const asset = state.project?.assets.find((item) => item.id === assetId)
    if (
      asset &&
      isCurrent(origin) &&
      (asset.kind === 'image' || asset.duration === null)
    )
      await probeAssets([asset], origin)
  }

  async function removeMissingAsset(assetId: string): Promise<void> {
    if (readOnly.value) return
    const origin = captureProject()
    const count =
      state.project?.clips.filter((clip) => clip.assetId === assetId).length ??
      0
    if (
      !(await dependencies.confirm({
        title: '移除缺失素材？',
        body: `将移除素材记录及引用它的 ${count} 个片段，并清空本工程的撤销记录。`,
        confirmLabel: '移除',
        tone: 'danger',
      }))
    )
      return
    await write(origin, (expectedRevision) =>
      dependencies.core('videoProject.removeMissingAsset', {
        sessionId: origin.sessionId,
        expectedRevision,
        assetId,
      }),
    )
  }

  function mutate(
    command: VideoProjectCommand,
    origin = captureProject(),
  ): Promise<void> {
    if (readOnly.value) return Promise.resolve()
    return write(origin, (expectedRevision) =>
      dependencies.core('videoProject.mutate', {
        sessionId: origin.sessionId,
        expectedRevision,
        command,
      }),
    )
  }

  function mutateDerived(
    command: VideoProjectCommand,
    origin: ProjectOrigin,
    stillValid?: () => boolean,
  ): Promise<void> {
    if (readOnly.value) return Promise.resolve()
    return write(
      origin,
      (expectedRevision) =>
        dependencies.core('videoProject.mutate', {
          sessionId: origin.sessionId,
          expectedRevision,
          command,
        }),
      true,
      () =>
        !readOnly.value &&
        (!('sceneId' in command) || canEditMotionScene(command.sceneId)) &&
        (!stillValid || stillValid()),
    )
  }

  function restoreHistory(direction: 'undo' | 'redo'): Promise<void> {
    if (readOnly.value) return Promise.resolve()
    const origin = captureProject()
    return write(origin, (expectedRevision) =>
      dependencies.core(`videoProject.${direction}`, {
        sessionId: origin.sessionId,
        expectedRevision,
      }),
    )
  }

  function refreshFromDisk(sessionId = state.sessionId): Promise<void> {
    const origin = captureProject()
    if (origin.sessionId !== sessionId) return Promise.resolve()
    return write(origin, () =>
      dependencies.core('videoProject.open', { sessionId }),
    )
  }

  async function refreshDraft(
    sessionId = state.sessionId,
    hint?: { runId: string; generation: number },
  ): Promise<void> {
    const origin = captureProject()
    if (origin.sessionId !== sessionId || !isCurrent(origin)) return
    const request = ++draftRequest
    const next = await dependencies.core('videoProject.editRunDraft', {
      sessionId,
    })
    if (request !== draftRequest || !isCurrent(origin)) return
    const previous = state.draft
    if (!next) {
      resetDraft()
      return
    }
    if (
      next.project.projectId !== origin.projectId ||
      supersededRuns.has(next.runId)
    )
      return
    const previousGeneration =
      previous?.runId === next.runId ? previous.generation : -1
    if (next.generation < previousGeneration) return
    if (hint?.runId === next.runId && next.generation < hint.generation) return
    if (previousGeneration < 0) {
      if (previous) supersededRuns.add(previous.runId)
      Object.assign(draftPosition, livePosition)
    }
    state.draft = next
    if (previousGeneration !== next.generation) {
      const { assets, clips, subtitles, tracks } = next.project
      if (
        !next.project.motionScenes?.some(
          (s) => s.id === draftPosition.selectedMotionSceneId,
        ) &&
        activeMotion.value?.scene?.id !== draftPosition.selectedMotionSceneId
      ) {
        setMotionSelection(draftPosition)
      }
      if (
        !subtitles.some((cue) => cue.id === draftPosition.selectedSubtitleId)
      ) {
        draftPosition.selectedSubtitleId = null
        if (draftPosition.activeTab === 'subtitle')
          draftPosition.activeTab = 'canvas'
      }
      if (!clips.some((clip) => clip.id === draftPosition.selectedClipId)) {
        draftPosition.selectedClipId =
          draftPosition.selectedSubtitleId ||
          draftPosition.selectedMotionSceneId
            ? null
            : (clips[0]?.id ?? null)
      }
      if (!tracks.some((track) => track.id === draftPosition.selectedTrackId))
        draftPosition.selectedTrackId = tracks[0]?.id ?? null
      if (!assets.some((asset) => asset.id === draftPosition.selectedAssetId))
        draftPosition.selectedAssetId = assets[0]?.id ?? null
      const total = timelineLayout(next.project).totalDuration
      draftPosition.playhead = Math.min(draftPosition.playhead, total)
      if (readOnly.value) {
        if (draftPosition.playhead >= total) state.playing = false
        state.seekRevision += 1
      }
    }
    settleDelivery()
    if (!draftAvailable.value) switchView('live')
    else if (previousGeneration <= 0) {
      // The first visible stage starts from the current position in the live project.
      draftPosition.playhead = Math.min(
        livePosition.playhead,
        timelineLayout(next.project).totalDuration,
      )
      const prefer = preferredViews.get(next.runId)
      if (
        prefer ||
        !(
          activeMotion.value?.target === 'draft' &&
          state.playing &&
          state.view === 'live'
        )
      ) {
        const wasLive = state.view === 'live'
        switchView(prefer ?? 'draft')
        if (wasLive && state.motionFollow) showLatestMotionStep(false)
      }
    }
    if (next.state === 'delivered' && !deliveredRevisionLoaded.value)
      await refreshFromDisk(sessionId)
  }

  function seekDraftChange(): void {
    const change = state.draft?.change
    if (!change || !draftAvailable.value) return
    selectView('draft')
    setPlayhead(change.time)
    state.playing = false
  }

  /** A tool asked the editor to show a clip or time; no project write. */
  function applyAgentFocus(input: { clipId?: string; time?: number }): void {
    if (activeMotion.value && !state.motionFollow) return
    if (!state.project) {
      pendingFocus = input
      return
    }
    if (
      input.clipId !== undefined &&
      !state.project.clips.some((clip) => clip.id === input.clipId)
    ) {
      pendingFocus = input
      return
    }
    pendingFocus = null
    if (input.clipId !== undefined) {
      setMotionSelection(livePosition)
      livePosition.selectedClipId = input.clipId
      livePosition.selectedSubtitleId = null
      livePosition.activeTab = 'clip'
    }
    const liveLayout = timelineLayout(state.project)
    const time =
      input.time ??
      liveLayout.clips.find((clip) => clip.clipId === input.clipId)?.start
    if (time === undefined) return
    if (readOnly.value) {
      livePosition.playhead = Math.max(
        0,
        Math.min(time, liveLayout.totalDuration),
      )
    } else {
      seekPlayhead(time)
      if (input.time !== undefined) state.playing = false
    }
  }

  /** Discover local projects already known to Core (not only this profile's recents). */
  async function refreshRecentProjects(): Promise<void> {
    try {
      const projects = await dependencies.core('projects.list')
      const stored = new Map(
        state.recentProjects.map((entry) => [entry.projectPath, entry]),
      )
      const discovered = projects
        .filter(
          (project) =>
            typeof project.project_path === 'string' &&
            project.project_path.trim() !== '',
        )
        .map((project): RecentVideoProject => {
          const existing = stored.get(project.project_path)
          if (existing)
            return {
              ...existing,
              name: project.project_name || existing.name,
            }
          return {
            projectPath: project.project_path,
            name:
              project.project_name ||
              project.project_path.split('/').filter(Boolean).at(-1) ||
              '本地项目',
            sessionId: '',
            openedAt: project.updated_at || '',
          }
        })
      const discoveredPaths = new Set(
        discovered.map((project) => project.projectPath),
      )
      state.recentProjects = [
        ...discovered,
        ...state.recentProjects.filter(
          (project) => !discoveredPaths.has(project.projectPath),
        ),
      ].slice(0, MAX_RECENT_PROJECTS)
    } catch {
      // Keep the stored recents when Core cannot list projects.
    }
  }

  async function openRecent(entry: RecentVideoProject): Promise<boolean> {
    if (entry.sessionId) {
      try {
        return await openProject({ sessionId: entry.sessionId })
      } catch {
        // The session can be deleted; the folder metadata is still enough.
      }
    }
    try {
      return await openProject({ projectPath: entry.projectPath })
    } catch {
      return false
    }
  }

  function closeProject(): void {
    state.readOnlySnapshot = null
    ++openGeneration
    if (state.sessionId)
      void leaveMotionWorkspace(state.sessionId).catch((cause) => {
        if (!state.project) state.error = message(cause)
      })
    resetMotion()
    resetDraft()
    state.loading = false
    state.project = null
    state.sessionId = ''
    state.projectPath = ''
    state.selectedClipId = null
    state.selectedSubtitleId = null
    state.selectedTrackId = null
    state.selectedAssetId = null
    state.activeTab = 'canvas'
    state.playhead = 0
    state.seekRevision += 1
    state.playing = false
    state.canUndo = false
    state.canRedo = false
    state.error = ''
    pendingFocus = null
  }

  function selectClip(clipId: string, seek = true): void {
    if (!displayProject.value?.clips.some((clip) => clip.id === clipId)) return
    clearMotionSelection()
    state.selectedClipId = clipId
    state.selectedSubtitleId = null
    state.activeTab = 'clip'
    if (seek) {
      const item = layout.value.clips.find((clip) => clip.clipId === clipId)
      if (item) setPlayhead(item.start)
    }
  }

  function selectSubtitle(subtitleId: string, seek = false): void {
    const cue = displayProject.value?.subtitles.find(
      (item) => item.id === subtitleId,
    )
    if (!cue) return
    clearMotionSelection()
    state.selectedSubtitleId = subtitleId
    state.selectedClipId = null
    state.activeTab = 'subtitle'
    if (seek) setPlayhead(cue.start)
  }

  function selectTrack(trackId: string): void {
    if (!displayProject.value?.tracks.some((track) => track.id === trackId))
      return
    clearMotionSelection()
    state.selectedTrackId = trackId
  }

  function selectAsset(assetId: string): void {
    if (!displayProject.value?.assets.some((asset) => asset.id === assetId))
      return
    clearMotionSelection()
    state.selectedAssetId = assetId
  }

  function setPlayhead(value: number): void {
    takeMotionControl()
    seekPlayhead(value)
  }

  function seekPlayhead(value: number): void {
    const total = layout.value.totalDuration
    state.playhead = Math.max(0, Math.min(value, total))
    state.seekRevision += 1
  }

  function reportPlayhead(value: number): void {
    const total = layout.value.totalDuration
    state.playhead = Math.max(0, Math.min(value, total))
  }

  function splitTarget() {
    if (!displayProject.value || readOnly.value) return null
    const hits = timelineClipsAt(displayProject.value, state.playhead)
    return (
      hits.find((hit) => hit.clip.id === state.selectedClipId) ??
      hits.at(-1) ??
      null
    )
  }

  async function splitAtPlayhead(): Promise<void> {
    const scene = selectedMotionScene.value
    if (scene) {
      if (
        readOnly.value ||
        state.selectedMotionObjectId ||
        !canEditMotionScene(scene.id)
      )
        return
      const frame = Math.round(state.playhead * MOTION_FPS)
      if (
        frame > scene.startFrame &&
        frame < scene.startFrame + scene.durationFrames
      )
        await mutate({ type: 'splitMotionScene', sceneId: scene.id, frame })
      return
    }
    const current = splitTarget()
    if (
      !current ||
      current.localTime < minSplitTimelineOffset(current.clip.speed) ||
      clipTimelineDuration(current.clip) - current.localTime <
        minSplitTimelineOffset(current.clip.speed)
    )
      return
    await mutate({
      type: 'splitClip',
      clipId: current.clip.id,
      timelineOffset: current.localTime,
    })
  }

  let deleting = false
  async function deleteSelection(): Promise<void> {
    const target = deleteTarget.value
    if (!target || deleting) return
    const origin = captureProject()
    const stillSelected = () =>
      isCurrent(origin) &&
      state.project?.revision === origin.revision &&
      deleteTarget.value === target
    deleting = true
    try {
      if (
        target.confirmBody &&
        !(await dependencies.confirm({
          title: '删除整幕动效？',
          body: target.confirmBody,
          confirmLabel: '删除整幕',
          tone: 'danger',
        }))
      )
        return
      if (stillSelected())
        await mutateDerived(target.command, origin, stillSelected)
    } finally {
      deleting = false
    }
  }

  function rippleDeleteSelection(range = selectedRange.value): Promise<void> {
    if (!range || range.end <= range.start) return Promise.resolve()
    return mutate({ type: 'rippleDeleteRange', ...range })
  }

  function timelineReference(
    target: TimelineReferenceTarget,
  ): TimelineChip | null {
    const project = displayProject.value
    if (!project || !state.sessionId) return null
    const detail = timelineTargetDetail(project, motionScenes.value, target)
    if (!detail) return null
    const { name, ...fields } = detail
    const draft = readOnly.value ? state.draft : null
    return {
      kind: 'timeline',
      id: crypto.randomUUID(),
      label: timelineLabel(name, detail.start, detail.end),
      timeline: {
        sessionId: state.sessionId,
        projectId: project.projectId,
        projectName: project.name,
        revision: project.revision,
        ...(draft
          ? { draft: { runId: draft.runId, generation: draft.generation } }
          : {}),
        target: { ...target },
        ...fields,
      },
    }
  }

  function resolveTimelineReference(snapshot: TimelineSnapshot) {
    if (
      snapshot.sessionId !== state.sessionId ||
      snapshot.projectId !== state.project?.projectId
    )
      return { reason: '此引用属于其他工程' } as const
    const project = snapshot.draft ? state.draft?.project : state.project
    if (
      snapshot.draft &&
      (!draftAvailable.value ||
        snapshot.draft.runId !== state.draft?.runId ||
        snapshot.draft.generation !== state.draft?.generation)
    )
      return { reason: '引用的草稿版本已失效' } as const
    if (!project) return { reason: '工程未打开' } as const
    const { target } = snapshot
    if (
      (target.kind === 'point' || target.kind === 'range') &&
      project.revision !== snapshot.revision
    )
      return { reason: '引用的时间线版本已更新' } as const
    const sameView = Boolean(snapshot.draft) === readOnly.value
    const detail = timelineTargetDetail(
      project,
      sameView ? motionScenes.value : (project.motionScenes ?? []),
      target,
    )
    if (
      !detail ||
      detail.sceneVersion !== snapshot.sceneVersion ||
      (target.kind === 'clip' && detail.assetId !== snapshot.assetId)
    )
      return { reason: '引用对象已失效' } as const
    return { reason: '', detail } as const
  }

  function referenceUnavailable(snapshot: TimelineSnapshot): string {
    return resolveTimelineReference(snapshot).reason
  }

  function revealTimelineReference(snapshot: TimelineSnapshot): void {
    const resolved = resolveTimelineReference(snapshot)
    if (!resolved.detail) return
    selectView(snapshot.draft ? 'draft' : 'live')
    takeMotionControl()
    const target = snapshot.target
    setMotionSelection(position())
    state.selectedClipId = null
    state.selectedSubtitleId = null
    state.selectedTrackId = null
    if (target.kind === 'clip') selectClip(target.id, false)
    if (target.kind === 'subtitle') selectSubtitle(target.id)
    if (target.kind === 'track') selectTrack(target.id)
    if (target.kind === 'motion') {
      const scene = motionScenes.value.find((scene) => scene.id === target.id)!
      selectMotion(scene, target.objectId, target.markerFrame)
    }
    state.playing = false
    seekPlayhead(resolved.detail.start)
    state.referenceFocus = {
      ...snapshot,
      start: resolved.detail.start,
      end: resolved.detail.end,
    }
  }

  return {
    state,
    displayProject,
    motionScenes,
    selectedMotionScene,
    canEditMotionScene,
    activeMotion,
    visibleMotionWork,
    refreshMotion,
    setMotionEnabled,
    applyMotionWork,
    interruptMotion,
    selectMotion,
    takeMotionControl,
    resumeMotionFollow,
    stopAudition,
    displayMissingAssetIds,
    readOnly,
    draftAvailable,
    selectView,
    refreshDraft,
    seekDraftChange,
    selectedRange,
    canDelete,
    deleteLabel,
    deleteSelection,
    rippleDeleteSelection,
    openProject,
    layout,
    splitTarget,
    captureProject,
    isCurrent,
    mutateDerived,
    refreshRecentProjects,
    openRecent,
    closeProject,
    createProject,
    openFolder,
    pickWorkspace,
    refreshFromDisk,
    applyAgentFocus,
    importAssets,
    updateAssetMetadata,
    probeAssets,
    relinkAsset,
    removeMissingAsset,
    mutate,
    undo: () => restoreHistory('undo'),
    redo: () => restoreHistory('redo'),
    selectClip,
    selectSubtitle,
    selectTrack,
    selectAsset,
    setPlayhead,
    reportPlayhead,
    splitAtPlayhead,
    timelineReference,
    referenceUnavailable,
    revealTimelineReference,
  }
}

export type EditingWorkspace = ReturnType<typeof createEditingWorkspace>

let shared: EditingWorkspace | undefined
export function useEditingWorkspace(): EditingWorkspace {
  shared ??= createEditingWorkspace({
    core,
    selectDirectory,
    selectMediaFiles,
    confirm,
    storage: browserStorage(),
    refreshSessions: () => useSession().load(),
  })
  return shared
}
