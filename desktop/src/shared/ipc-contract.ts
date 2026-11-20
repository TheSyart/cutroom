import type { CoreOperationKey } from '@emperor/core/api'

export const CORE_IPC_PREFIX = 'emperor:core:'

export const CORE_EVENT_CHANNEL = 'emperor:core:event'

/** Raw session-log events of watched sessions, batched per session (`SessionEventBatch`). */
export const SESSION_EVENT_CHANNEL = 'emperor:core:session-event'

export const REFERENCE_REVEAL_CHANNEL = 'emperor:reference:reveal'

/**
 * Renderer → main `{ url, action? }`: for a file of the Files pane (BUG-05,
 * BUG-10), `url` being the `app://workspace-media/<token>` address Core
 * granted. `action` 'open' (default): 「用默认应用打开」, refused for a program,
 * script or bundle; 'reveal': 「在访达中显示」. Main acts on the file the grant
 * names, never on a path the renderer names, and answers `{ ok, error? }`.
 */
export const WORKSPACE_MEDIA_OPEN_CHANNEL = 'emperor:workspace-media:open'

export const EXTERNAL_OPEN_CHANNEL = 'emperor:external:open'

/**
 * Renderer → main `url`: a web link the user clicked in the Cutroom window. Main
 * checks the address and opens an eligible link in the system browser.
 */
export const LINK_OPEN_CHANNEL = 'emperor:link:open'

/** Main-only: open the personal or project Skills folder (created when missing). */
export const SKILLS_OPEN_FOLDER_CHANNEL = 'emperor:skills:open-folder'

/** Main-only: native single-file picker with extension filters. */
export const SELECT_FILE_CHANNEL = 'emperor:select-file'

/** Extension filter of the native file picker (`SELECT_FILE_CHANNEL`). */
export interface FileDialogFilter {
  name: string
  extensions: string[]
}

const OPERATION_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export function channelForCoreOperation(
  operationKey: CoreOperationKey,
): string {
  const key = String(operationKey || '').trim()
  if (!OPERATION_KEY_RE.test(key))
    throw new Error(`invalid core IPC operation: ${operationKey}`)
  return CORE_IPC_PREFIX + key.replaceAll('.', ':')
}

/**
 * The context a Core call carries besides its arguments (KRN-01): the
 * session the renderer shows. The preload puts it first on every core
 * channel; main takes it off and hands it to the operation, which uses it
 * when the call names no session. Nothing in main or Core remembers it.
 */
export const CORE_CALL_CONTEXT_KEY = 'emperorCoreCall'

export interface CoreCallEnvelope {
  readonly [CORE_CALL_CONTEXT_KEY]: 1
  readonly view: { readonly sessionId: string | null }
}

export function coreCallEnvelope(sessionId: string | null): CoreCallEnvelope {
  return { [CORE_CALL_CONTEXT_KEY]: 1, view: { sessionId } }
}

/** Split a core channel's arguments into the call context and the operation's own. */
export function splitCoreCallEnvelope(args: readonly unknown[]): {
  view: { sessionId: string | null } | undefined
  args: unknown[]
} {
  const first = args[0]
  if (
    !first ||
    typeof first !== 'object' ||
    Array.isArray(first) ||
    !Object.hasOwn(first, CORE_CALL_CONTEXT_KEY)
  )
    return { view: undefined, args: [...args] }
  const envelope = first as Record<string, unknown>
  const view = envelope.view as Record<string, unknown> | undefined
  const sessionId = view?.sessionId
  if (
    envelope[CORE_CALL_CONTEXT_KEY] !== 1 ||
    !view ||
    typeof view !== 'object' ||
    Object.keys(envelope).length !== 2 ||
    Object.keys(view).length !== 1 ||
    !(
      sessionId === null ||
      (typeof sessionId === 'string' && sessionId.length <= 256)
    )
  )
    throw new Error('invalid core call context')
  return { view: { sessionId }, args: args.slice(1) }
}

/** One batch of raw session-log events sent on {@link SESSION_EVENT_CHANNEL}. */
export interface SessionEventBatch {
  sessionId: string
  /** Wire-sanitized `SessionEvent`s in seq order. */
  events: unknown[]
}

/**
 * Editor dictation (VO-01, macOS). The trusted main renderer reads the
 * dictation helper's state, and starts, stops or cancels one dictation at a
 * time. Main makes up the session id and pushes {@link DictationEvent}s of
 * that session only to the window that started it. Audio stays inside the
 * helper's memory and transcripts are not written anywhere.
 */
export const DICTATION_STATUS_CHANNEL = 'emperor:dictation:status'

/** {@link DictationStartRequest} → {@link DictationStartResult}. */
export const DICTATION_START_CHANNEL = 'emperor:dictation:start'

/** `{ session }`: end the audio and let the final result arrive. */
export const DICTATION_STOP_CHANNEL = 'emperor:dictation:stop'

/** `{ session }`: drop the dictation without a final result. */
export const DICTATION_CANCEL_CHANNEL = 'emperor:dictation:cancel'

/** Main → renderer {@link DictationEvent}. */
export const DICTATION_EVENT_CHANNEL = 'emperor:dictation:event'

/**
 * `{ pane }`: open System Settings at the microphone or speech recognition
 * privacy list (main owns the URLs). Answers `{ opened }`.
 */
export const DICTATION_PRIVACY_CHANNEL = 'emperor:dictation:open-privacy'

export type DictationPrivacyPane = 'microphone' | 'speech'

/** `unknown`: the helper could not be asked. */
export type DictationPermission =
  'granted' | 'denied' | 'undetermined' | 'restricted' | 'unknown'

export interface DictationDevice {
  /** CoreAudio device UID, stable across restarts. */
  id: string
  name: string
  default: boolean
}

export interface DictationLocale {
  /** BCP 47, e.g. `zh-CN`. */
  id: string
  /** In the system language. */
  name: string
}

export interface DictationStatus {
  /** This platform has dictation at all (macOS only for now). */
  supported: boolean
  /** The helper answered. */
  available: boolean
  /** Why it is not available, for the user. */
  reason?: string
  engine: string | null
  permissions: { microphone: DictationPermission; speech: DictationPermission }
  devices: DictationDevice[]
  /** Languages this Mac recognizes on device right now; nothing else is offered. */
  locales: DictationLocale[]
  systemLocale: string | null
  /** A dictation is running. */
  active: boolean
}

export type DictationErrorCode =
  | 'invalid_request'
  | 'busy'
  | 'not_found'
  | 'permission_denied'
  | 'no_device'
  | 'unsupported_locale'
  | 'recognizer_unavailable'
  | 'failed'
  /** No helper on this platform or in this build, or it would not start. */
  | 'unavailable'
  /** The helper quit, or sent something unreadable, during the dictation. */
  | 'helper_exited'
  /** The helper did not start or end the dictation in time. */
  | 'timeout'

export type DictationEndReason =
  'stopped' | 'cancelled' | 'max_duration' | 'error'

/**
 * One dictation's events, in `seq` order: `started`, `partial`s, at most one
 * `final`, then exactly one `ended` (after an `error` when it failed).
 * `partial` carries the whole transcript so far, not a delta.
 */
export type DictationEvent =
  | { type: 'started'; session: string; seq: number; locale: string }
  | { type: 'partial'; session: string; seq: number; text: string }
  /**
   * RV-06: the microphone's loudness while listening (RMS on a decibel
   * scale, 0–1), about 15 a second, for the composer's waveform. Only
   * between `started` and `final`; never the audio itself.
   */
  | { type: 'level'; session: string; seq: number; value: number }
  | { type: 'final'; session: string; seq: number; text: string }
  | {
      type: 'error'
      session: string
      seq: number
      code: DictationErrorCode
      message: string
    }
  | {
      type: 'ended'
      session: string
      seq: number
      reason: DictationEndReason
    }

/** null or absent: follow the system language, or use the default microphone. */
export interface DictationStartRequest {
  locale?: string | null
  device?: string | null
}

export type DictationStartResult =
  | { ok: true; session: string }
  | { ok: false; code: DictationErrorCode; message: string }

/**
 * Renderer → main: the running app's version, `app.getVersion()` (REL-05);
 * the preload carries no version of its own.
 */
export const APP_VERSION_CHANNEL = 'emperor:app-version'

/** Renderer → main: the native folder picker; answers the path or null. */
export const SELECT_DIRECTORY_CHANNEL = 'emperor:select-directory'

export const MOTION_FRAME_CHANNEL = 'video-edit-agent:motion-frame'

export const VIDEO_EXPORT_CHANNEL = 'video-edit-agent:export'

export const VIDEO_EXPORT_CANCEL_CHANNEL = 'video-edit-agent:export-cancel'

export const VIDEO_EXPORT_PROGRESS_CHANNEL = 'video-edit-agent:export-progress'

export interface VideoExportOwner {
  sessionId: string
  projectId: string
  runId: string
}

export function matchesVideoExport(
  owner: VideoExportOwner,
  candidate: unknown,
): boolean {
  if (!candidate || typeof candidate !== 'object') return false
  const other = candidate as Partial<VideoExportOwner>
  return (
    owner.sessionId === other.sessionId &&
    owner.projectId === other.projectId &&
    owner.runId === other.runId
  )
}

export interface VideoExportProgress extends VideoExportOwner {
  percent: number
}

export interface VideoExportRequest extends VideoExportOwner {
  expectedRevision: number
}

export type VideoExportResponse =
  | { kind: 'done'; path: string; duration: number; revision: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

export interface SelectDirectoryOptions {
  title?: string
  /** Let the user create a folder inside the picker (new project). */
  createDirectory?: boolean
}

/**
 * Renderer → main {@link OpenPathTarget}: open a folder Core vouches for in
 * Finder. Never a path of the renderer's choosing (SEC-05); answers
 * `{ ok: true } | { ok: false, error }`.
 */
export const OPEN_PATH_CHANNEL = 'emperor:open-path'

/**
 * Diagnostic bundle for desktop recovery (trusted main window only).
 * `prepare` (no argument) stages the bundle and answers
 * {@link DiagnosticsBundlePrepareResult}: what the zip will hold, for the
 * user to confirm. `export` `{ id }` asks where to save it and writes the
 * zip ({@link DiagnosticsBundleExportResult}); `reveal` `{ id }` shows an
 * exported zip in Finder; `discard` `{ id }` drops a staged bundle. Ids
 * only: no path crosses IPC.
 */
export const DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL =
  'emperor:diagnostics:bundle-prepare'

export const DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL =
  'emperor:diagnostics:bundle-export'

export const DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL =
  'emperor:diagnostics:bundle-reveal'

export const DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL =
  'emperor:diagnostics:bundle-discard'

/** One file of a staged diagnostics bundle. */
export interface DiagnosticsBundleEntryView {
  /** Inside the zip's folder, e.g. `logs/main.log`. */
  path: string
  /** What it is, in the UI's words. */
  title: string
  bytes: number
}

export interface DiagnosticsBundleView {
  /** `b_` + 12 hex. */
  id: string
  /** The zip's folder and default file name (without `.zip`). */
  name: string
  entries: DiagnosticsBundleEntryView[]
  /** What the bundle never holds. */
  excluded: string[]
}

export type DiagnosticsBundlePrepareResult =
  { ok: true; bundle: DiagnosticsBundleView } | { ok: false; error: string }

export type DiagnosticsBundleExportResult =
  | { ok: true; name: string; location: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

/**
 * What `emperor:open-path` may open — names Core resolves, never a path the
 * renderer picked:
 * - diagnostic: the active project, application data or log directory;
 * - skill: an installed Skill's folder (by name, in a session's scope);
 * - invalid-skill: a rejected Skill folder Core lists for that scope.
 */
export type OpenPathTarget =
  | {
      kind: 'diagnostic'
      /** `logs-path`: the folder of main.log and core.log (REL-01). */
      rowId: 'global-state-root' | 'active-project-path' | 'logs-path'
      /** The session the Diagnostics page was opened from (its project row). */
      sessionId?: string | null
    }
  | { kind: 'skill'; name: string; sessionId?: string | null }
  | { kind: 'invalid-skill'; path: string; sessionId?: string | null }

/**
 * Renderer → main `{ url }`: a remote image in rendered markdown the user
 * asked to see (UI-38). Main fetches it through the public HTTP client (no
 * cookies, no local or private addresses) and answers
 * {@link RemoteImageResult}; the renderer never requests remote images.
 */
export const MARKDOWN_REMOTE_IMAGE_CHANNEL = 'emperor:markdown:remote-image'

export type RemoteImageResult =
  { ok: true; dataUrl: string } | { ok: false; error: string }

/** Main → renderer {@link AppMenuCommand}: an app menu item was chosen. */
export const APP_MENU_COMMAND_CHANNEL = 'emperor:menu:command'

export type AppMenuCommand = 'open-settings'
