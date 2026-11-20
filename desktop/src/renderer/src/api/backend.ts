import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core/api'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import {
  matchesVideoExport,
  type FileDialogFilter,
  type OpenPathTarget,
  type RemoteImageResult,
  type SelectDirectoryOptions,
  type VideoExportOwner,
  type VideoExportProgress,
  type VideoExportRequest,
  type VideoExportResponse,
} from '../../../shared/ipc-contract'

// The Chinese texts of Core's error codes (errors/messages.ts): a chunk of
// its own, fetched as soon as this module loads, so its messages stay out
// of the startup bundle and are in hand by the first failed call.
const errorTexts = import('../errors/messages').catch(() => null)

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE =
  '无法连接 Cutroom 核心：请在 Cutroom 桌面窗口中打开。'

interface CutroomBridge {
  selectDirectory?: (options?: SelectDirectoryOptions) => Promise<string | null>
  renderMotionFrame?: (
    scene: unknown,
    frame: number,
    width: number,
  ) => Promise<string>
  exportVideo?: (request: VideoExportRequest) => Promise<VideoExportResponse>
  cancelVideoExport?: (owner: VideoExportOwner) => Promise<void>
  onVideoExportProgress?: (
    listener: (progress: VideoExportProgress) => void,
  ) => () => void
  openPath?: (
    target: OpenPathTarget,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  revealReference?: (input: {
    sessionId: string
    referenceId: string
  }) => Promise<{ ok?: boolean; error?: string } | void>
  openWorkspaceMedia?: (
    url: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  revealWorkspaceMedia?: (
    url: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  openExternal?: (
    url: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  openLink?: (
    url: string,
  ) => Promise<{ ok?: boolean; opened?: 'system' | 'refused' }>
  loadRemoteImage?: (url: string) => Promise<RemoteImageResult>
  openSkillsFolder?: (input: {
    scope: SkillFolderScope
    sessionId?: string | null
  }) => Promise<{
    ok?: boolean
    error?: string
    code?: string
    path?: string
  } | void>
  selectFile?: (input?: {
    title?: string
    filters?: FileDialogFilter[]
    multiple?: boolean
  }) => Promise<string | string[] | null>
  invokeCore?: <Key extends CoreOperationKey>(
    operationKey: Key,
    ...args: CoreOperationArgs<Key>
  ) => Promise<CoreOperationResult<Key> | CoreIpcErrorEnvelope>
  /** The session on screen; every core call carries it (KRN-01). */
  setViewingSession?: (sessionId: string | null) => void
  onCoreEvent?: (listener: (event: unknown) => void) => () => void
  onSessionEvents?: (listener: (batch: SessionEventBatch) => void) => () => void
  /** App menu items that act in the window (偏好设置… → 设置). */
  onMenuCommand?: (listener: (command: 'open-settings') => void) => () => void
}

export type SkillFolderScope = 'user' | 'project'

/** One batch of raw session-log events of a watched session (`sessions.watch`). */
export interface SessionEventBatch {
  sessionId: string
  events: WireSessionEvent[]
}

function bridge(): CutroomBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: CutroomBridge } })
    .window?.emperor
}

export async function selectDirectory(
  options?: SelectDirectoryOptions,
): Promise<string | null> {
  const picker = bridge()?.selectDirectory
  return typeof picker === 'function' ? picker(options) : null
}

export async function desktopMotionFrame(
  scene: unknown,
  frame: number,
  width: number,
): Promise<string> {
  const invoke = bridge()?.renderMotionFrame
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke(scene, frame, width)
}

export async function exportVideo(
  request: VideoExportRequest,
  onProgress: (percent: number) => void,
): Promise<VideoExportResponse> {
  const desktop = bridge()
  if (!desktop?.exportVideo) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const unsubscribe = desktop.onVideoExportProgress?.((event) => {
    if (matchesVideoExport(request, event) && Number.isFinite(event.percent))
      onProgress(Math.min(100, Math.max(0, Math.round(event.percent))))
  })
  try {
    return await desktop.exportVideo(request)
  } finally {
    unsubscribe?.()
  }
}

export async function cancelVideoExport(
  owner: VideoExportOwner,
): Promise<void> {
  await bridge()?.cancelVideoExport?.(owner)
}

/** Open the active project, local logs or an installed Skill folder. */
export async function openPath(target: OpenPathTarget): Promise<void> {
  const opener = bridge()?.openPath
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(target)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Failed to open path',
    )
  }
}

export async function revealReference(input: {
  sessionId: string
  referenceId: string
}): Promise<void> {
  const reveal = bridge()?.revealReference
  if (typeof reveal !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await reveal(input)
  if (result && typeof result === 'object' && result.ok === false)
    throw new Error(result.error || 'Failed to reveal reference')
}

/**
 * 「用默认应用打开」 a file of the Files pane by the media address Core
 * granted it (BUG-05, BUG-10); main opens that granted file only, and never
 * a program or script.
 */
export async function openWorkspaceMedia(url: string): Promise<void> {
  const opener = bridge()?.openWorkspaceMedia
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(url)
  if (result && typeof result === 'object' && result.ok === false)
    throw new Error(result.error || '无法打开这个文件')
}

/** 「在访达中显示」 a file of the Files pane by its media address (BUG-10). */
export async function revealWorkspaceMedia(url: string): Promise<void> {
  const reveal = bridge()?.revealWorkspaceMedia
  if (typeof reveal !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await reveal(url)
  if (result && typeof result === 'object' && result.ok === false)
    throw new Error(result.error || '无法在访达中显示这个文件')
}

export async function openExternal(url: string): Promise<void> {
  const opener = bridge()?.openExternal
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(url)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Failed to open external url',
    )
  }
}

export const LINK_REFUSED_MESSAGE = '无法打开这个链接'

/** Open an eligible conversation link in the system browser. */
export async function openLink(url: string): Promise<'system'> {
  const opener = bridge()?.openLink
  if (typeof opener !== 'function') {
    // A bridge without link routing (tests, the visual harness).
    await openExternal(url)
    return 'system'
  }
  const result = await opener(url)
  if (result?.opened === 'system') return result.opened
  throw new Error(LINK_REFUSED_MESSAGE)
}

/**
 * A remote image in rendered markdown, on the user's request (UI-38): main
 * fetches it through the public HTTP client (no cookies, no local or
 * private addresses) and returns it as a data: URL; the renderer itself
 * never requests a remote address (CSP img-src has no http(s)).
 */
export async function loadRemoteImage(url: string): Promise<RemoteImageResult> {
  const load = bridge()?.loadRemoteImage
  if (typeof load !== 'function')
    return { ok: false, error: CORE_BRIDGE_UNAVAILABLE_MESSAGE }
  const result = await load(url)
  if (result?.ok === true && typeof result.dataUrl === 'string') return result
  return {
    ok: false,
    error:
      result && result.ok === false && typeof result.error === 'string'
        ? result.error
        : '图片加载失败',
  }
}

/** A failed `openSkillsFolder`, carrying the Core error code when there is one. */
export class SkillsFolderError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'SkillsFolderError'
  }
}

/**
 * Open the personal (`user`) or project Skills folder in the OS file manager;
 * resolves the folder path. The user folder is created when missing, a project
 * folder only exists once a project Skill was saved there.
 */
export async function openSkillsFolder(input: {
  scope: SkillFolderScope
  sessionId?: string | null
}): Promise<string> {
  const opener = bridge()?.openSkillsFolder
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(input)
  if (result && typeof result === 'object' && result.ok === false)
    throw new SkillsFolderError(
      result.error || 'Failed to open the Skills folder',
      result.code ?? null,
    )
  return result && typeof result === 'object' ? String(result.path ?? '') : ''
}

/** Native single-file picker (e.g. `{ filters: [{ name: 'Zip', extensions: ['zip'] }] }`). */
export async function selectFile(
  input: { title?: string; filters?: FileDialogFilter[] } = {},
): Promise<string | null> {
  const picker = bridge()?.selectFile
  if (typeof picker !== 'function') return null
  const selected = await picker(input)
  return Array.isArray(selected) ? (selected[0] ?? null) : selected
}

/** Native multi-select picker for user-owned local video and image assets. */
export async function selectMediaFiles(): Promise<string[]> {
  const picker = bridge()?.selectFile
  if (typeof picker !== 'function') return []
  const selected = await picker({
    title: '导入视频、音频或图片',
    multiple: true,
    filters: [
      {
        name: '视频、音频与图片',
        extensions: [
          'mp4',
          'mov',
          'm4v',
          'mp3',
          'wav',
          'm4a',
          'aac',
          'flac',
          'ogg',
          'webm',
          'png',
          'jpg',
          'jpeg',
          'webp',
          'gif',
        ],
      },
    ],
  })
  return Array.isArray(selected) ? selected : selected ? [selected] : []
}

export async function invokeCore<Key extends CoreOperationKey>(
  operationKey: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  const invoke = bridge()?.invokeCore
  if (typeof invoke !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await invoke(operationKey, ...args)
  if (isCoreIpcErrorEnvelope(result)) {
    const safeError = safeCoreIpcError(result)
    // The message is what the UI shows; the code and Core's own message
    // stay on the error for logic and for copying.
    const texts = await errorTexts
    const error = new Error(
      texts ? texts.coreErrorText(safeError) : safeError.message,
    ) as Error & {
      errorId?: string
      code?: string
      action?: string
      detail?: string
    }
    if (texts) error.detail = texts.coreErrorDetail(safeError)
    if (safeError.errorId) error.errorId = safeError.errorId
    if (safeError.code) error.code = safeError.code
    if (safeError.action) error.action = safeError.action
    throw error
  }
  return result
}

/**
 * Tell the bridge which session the window shows (null: none, such as a
 * draft). Core reads it from each call instead of keeping a focus of its
 * own (KRN-01).
 */
export function setViewingSession(sessionId: string | null): void {
  bridge()?.setViewingSession?.(sessionId)
}

export function hasCoreBridge(): boolean {
  return typeof bridge()?.invokeCore === 'function'
}

export function onCoreEvent(listener: (event: unknown) => void): () => void {
  const subscribe = bridge()?.onCoreEvent
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener)
}

/** Subscribe to raw session-log event batches; a no-op without the bridge. */
export function onSessionEvents(
  listener: (batch: SessionEventBatch) => void,
): () => void {
  const subscribe = bridge()?.onSessionEvents
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener)
}

/** The app menu asked the window to act (偏好设置… ⌘, opens 设置). */
export function onMenuCommand(
  listener: (command: 'open-settings') => void,
): () => void {
  return bridge()?.onMenuCommand?.(listener) ?? (() => {})
}

function isCoreIpcErrorEnvelope(value: unknown): value is CoreIpcErrorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    payload.ok === false &&
    Boolean(
      payload.error &&
      typeof payload.error === 'object' &&
      !Array.isArray(payload.error),
    )
  )
}

function safeCoreIpcError(value: CoreIpcErrorEnvelope): {
  message: string
  errorId?: string
  code?: string
  action?: string
} {
  const error = value.error
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'Internal error'
  return {
    message,
    errorId: typeof error.errorId === 'string' ? error.errorId : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    action: typeof error.action === 'string' ? error.action : undefined,
  }
}
