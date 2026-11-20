import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  protocol,
  nativeTheme,
  net,
  screen,
  session,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderVideoProject, type CoreApi } from '@emperor/core/api'
import {
  applyPendingHomeRestore,
  bootstrapEmperorHome,
  legacyDefaultStateRoot,
  assertCutroomProfilePath,
  migrateCutroomProfile,
  loadBundledToolCatalog,
  createLocalKeySealer,
  runPendingDataMigrations,
  setCoreLogSink,
} from '@emperor/core/host-capabilities'
import { resolveLogLocation } from './logging/log-location'
import { createAppLog, logLevelOf, teeConsole } from './logging/app-log'
import { installProcessErrorHandlers } from './logging/process-errors'
import { startCrashReporting } from './logging/crash-reporting'
import {
  cutroomDiagnosticPaths,
  DiagnosticsBundles,
} from './diagnostics-bundle'
import {
  exportDiagnosticsBundle,
  registerDiagnosticsBundleIpc,
} from './diagnostics-bundle-ipc'
import { electronFrameworkBinary, readFuseStates } from './fuse-state'

import { offerMoveToApplications } from './app-location'
import { resolveConfig } from './config'
import {
  acquireStateDirectoryLock,
  StateDirectoryLockError,
  writeLockOwner,
  type StateDirectoryLock,
} from './state-directory-lock'
import { createLoadFailurePolicy } from './load-failure'
import { windowBackground } from './window-background'
import { createQuitCoordinator } from './quit-coordinator'
import { claimSingleInstance } from './single-instance'
import { trackedIpcMain } from './tracked-ipc'
import { resolveAppIconPath } from './icon'
import { preparePackagedRuntime, runtimeDefaultsRoot } from './runtime-root'
import {
  fitBoundsToDisplays,
  pickBounds,
  readBounds,
  type Bounds,
} from './window-bounds'
import {
  appAssetRequestAccess,
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
  withContentSecurityPolicy,
} from './protocol'
import { rendererContentSecurityPolicy } from '../shared/content-security-policy'
import { applicationMenuTemplate } from './app-menu'
import { defaultSessionPermission } from './renderer-permissions'
import { hardenSession } from './session-hardening'
import { registerOpenPathIpc } from './open-path-ipc'
import { registerAppVersionIpc } from './app-version-ipc'
import { registerRemoteImageIpc } from './remote-image-ipc'

import {
  WORKSPACE_MEDIA_HOST,
  registerWorkspaceMediaIpc,
  workspaceMediaResponse,
} from './workspace-media'
import { createCoreHost } from './core-host'
import { CoreEventBridge, SessionEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import {
  PACKAGED_SMOKE_REFUSED_EXIT,
  packagedSmokeLaunch,
} from './packaged-smoke'
import { developmentRendererUrl, mainRendererUrl } from './renderer-url'
import { DEBUG_SWITCH_REFUSED_EXIT, refusedDebugSwitch } from './debug-switches'

import {
  createTrustedRendererPolicy,
  type TrustedRendererPolicy,
} from './trusted-renderer'

import { mainWindowWebPreferences } from './window-security'

import { registerEditorNativeIpc } from './editor-native-ipc'
import { verifyCutroomWindow } from './cutroom-window-smoke'

import {
  createDesktopWebFetchClient,
  type ElectronRequestLike,
} from './public-http-client'
import { DictationService } from './dictation/dictation-service'
import { registerDictationIpc } from './dictation/dictation-ipc'
import {
  dictationHelperAppPath,
  dictationHelperExecutable,
  verifyDictationHelper,
} from './dictation/helper-location'
import {
  RECOVERY_ACTION_CHANNEL,
  createRecoveryActionHandler,
  createRecoveryHtml,
  recoveryPayload,
  recoveryWindowWebPreferences,
} from './recovery'
import {
  APP_MENU_COMMAND_CHANNEL,
  SELECT_DIRECTORY_CHANNEL,
  VIDEO_EXPORT_CANCEL_CHANNEL,
  MOTION_FRAME_CHANNEL,
  VIDEO_EXPORT_CHANNEL,
  VIDEO_EXPORT_PROGRESS_CHANNEL,
  matchesVideoExport,
  type VideoExportOwner,
  type VideoExportResponse,
  type AppMenuCommand,
} from '../shared/ipc-contract'

import { APP_ID, APP_NAME } from '../shared/app-brand'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
app.setName(APP_NAME)
// SEC-04: a packaged app opens no DevTools endpoint (no fuse covers these).
const debugSwitch = refusedDebugSwitch({
  isPackaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
})
if (debugSwitch) {
  console.error(`refusing --${debugSwitch} in a packaged build`)
  app.exit(DEBUG_SWITCH_REFUSED_EXIT)
  process.exit(DEBUG_SWITCH_REFUSED_EXIT)
}
// Emperor keeps no secret in the macOS Keychain (local-secret-store.ts).
// Should Chromium itself reach for it, a mock keychain answers instead of a
// "Safe Storage" prompt. Extra insurance only; keychain-free.test.ts and the
// bundle audit hold the code to it.
app.commandLine.appendSwitch('use-mock-keychain')
let config: ReturnType<typeof resolveConfig>
try {
  config = resolveConfig({
    argv: mainArgv,
    env: process.env,
    inspectSettings: false,
    ...(app.isPackaged
      ? { forcedRuntimeRoot: runtimeDefaultsRoot(process.resourcesPath) }
      : {}),
  })
} catch (error) {
  const detail = errMessage(error)
  console.error(detail)
  dialog.showErrorBox('Cutroom 无法打开数据目录', detail)
  process.exit(1)
}
// MAIN-28: the smoke runs only on a disposable state root under the system
// temp directory; otherwise exit before anything reads or writes state.
const smokeLaunch = packagedSmokeLaunch(process.argv, {
  stateRoot: config.stateRoot,
})
if (smokeLaunch.kind === 'refuse') {
  console.error(`packaged smoke refused: ${smokeLaunch.reason}`)
  app.exit(PACKAGED_SMOKE_REFUSED_EXIT)
  process.exit(PACKAGED_SMOKE_REFUSED_EXIT)
}
const packagedSmoke =
  smokeLaunch.kind === 'run'
    ? { receiptPath: smokeLaunch.receiptPath, scenario: smokeLaunch.scenario }
    : null
const previousProfile =
  config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null
const chromiumProfile = path.join(config.stateRoot, 'electron-user-data')
let stateDirectoryLock: StateDirectoryLock
try {
  if (previousProfile) assertCutroomProfilePath(previousProfile)
  stateDirectoryLock = acquireStateDirectoryLock(
    config.stateRoot,
    null,
    config.stateRootSource === 'env',
  )
  migrateCutroomProfile(config.stateRoot, previousProfile)
  fs.mkdirSync(chromiumProfile, { recursive: true, mode: 0o700 })
  app.setPath('userData', chromiumProfile)
  app.setPath('sessionData', chromiumProfile)
  writeLockOwner(stateDirectoryLock, {
    pid: process.pid,
    version: app.getVersion(),
    startedAt: Date.now(),
    packaged: app.isPackaged,
    appPath: app.isPackaged
      ? path.resolve(process.execPath, '..', '..', '..')
      : null,
  })
  process.once('exit', () => {
    void stateDirectoryLock.root
  })
} catch (error) {
  // A running formal instance has already published its profile. Hand this launch to it.
  if (
    error instanceof StateDirectoryLockError &&
    error.code === 'state_root_in_use' &&
    config.stateRootSource === 'default' &&
    fs.existsSync(chromiumProfile) &&
    error.root === fs.realpathSync(config.stateRoot)
  ) {
    app.setPath('userData', chromiumProfile)
    if (!app.requestSingleInstanceLock()) process.exit(0)
    app.releaseSingleInstanceLock()
  }
  const detail =
    error instanceof StateDirectoryLockError
      ? `无法独占数据目录，请退出其他使用该目录的 Cutroom 后重新打开。\n${error.root}`
      : errMessage(error)
  console.error(detail)
  if (!packagedSmoke) dialog.showErrorBox('Cutroom 无法打开数据目录', detail)
  process.exit(1)
}
// A second launch on the same data directory hands over and quits.
const primaryInstance = claimSingleInstance(
  app,
  {
    stateRootSource: config.stateRootSource,
    packagedSmoke: Boolean(packagedSmoke),
  },
  () => showMainWindow(),
)
if (!primaryInstance) process.exit(0)
const logLocation = resolveLogLocation({
  stateRoot: config.stateRoot,
  stateRootSource: config.stateRootSource,
  homeDir: os.homedir(),
  platform: process.platform,
  // Only asked off macOS: getPath('logs') creates its default folder.
  ...(process.platform === 'darwin' ? {} : { systemLogs: app.getPath('logs') }),
})
app.setAppLogsPath(logLocation.dir)
const logLevel = logLevelOf(
  process.env.CUTROOM_LOG_LEVEL || process.env.EMPEROR_LOG_LEVEL,
)
const mainLog = createAppLog({ file: logLocation.mainLog, level: logLevel })
const coreLog = createAppLog({ file: logLocation.coreLog, level: logLevel })
teeConsole(console, mainLog)
setCoreLogSink((line) => coreLog.write(line.level, line.msg, line.fields))
installProcessErrorHandlers({ process, log: mainLog })
const crashReporting = startCrashReporting({
  dir: logLocation.crashDumps,
  app,
  crashReporter,
})
mainLog.info(`${APP_NAME} ${app.getVersion()} starting`, {
  packaged: app.isPackaged,
  electron: process.versions.electron,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  stateRootSource: config.stateRootSource,
  logs: logLocation.source,
})
if (!crashReporting.ok)
  mainLog.warn('crash reporting unavailable', { error: crashReporting.error })
app.on('render-process-gone', (_event, contents, details) => {
  mainLog.warn('renderer process gone', {
    kind: contents === mainWindow?.webContents ? 'main' : contents.getType(),
    reason: details.reason,
    exitCode: details.exitCode,
  })
})
app.on('child-process-gone', (_event, details) => {
  mainLog.warn('child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name ?? details.serviceName ?? null,
  })
})
let legacyRuntimeRoot = config.runtimeRoot
let packagedRuntimeRevision = ''
const rendererRoot = path.join(mainDir, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: mainDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

let coreApi: CoreApi | null = null
let startupTask: Promise<void> = Promise.resolve()
let runtimeStarting = false
let shutdownRequested = false
let closeCoreTask: Promise<void> | null = null
// Keep ownership through every quit/exit hook; only actual OS process exit
// releases the connection, including a hard crash.
const coreEventBridge = new CoreEventBridge()
const sessionEventBridge = new SessionEventBridge()
/** IPC handlers the current startup attempt registered (removed before a retry). */
let startupIpc: ReturnType<typeof trackedIpcMain> | null = null
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let recoveryWindow: BrowserWindow | null = null
let dictation: DictationService | null = null
const mainLoadFailures = createLoadFailurePolicy()
const trustedRendererPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://bundle/index.html',
  developmentUrl: developmentRendererUrl({
    isPackaged: app.isPackaged,
    env: process.env,
  }),
  mainWebContents: () => mainWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  openLink: (url) => openUserLink(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})
// SEC-05: the app://bundle header; index.html carries the same meta.
const RENDERER_CSP = rendererContentSecurityPolicy()
// Core's web_fetch and the remote markdown images (UI-38) share one public
// HTTP client: no cookies, no local or private addresses.
const webFetchClient = createDesktopWebFetchClient({
  resolveProxy: async (url) => await app.resolveProxy(url),
  request: (options) => net.request(options) as unknown as ElectronRequestLike,
})
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Range requests for the Files pane's videos (BUG-05: workspace-media).
      stream: true,
    },
  },
])

ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async (event, input: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  const request =
    input !== null && typeof input === 'object'
      ? (input as { title?: unknown; createDirectory?: unknown })
      : {}
  const title =
    typeof request.title === 'string' && request.title.trim()
      ? request.title.trim().slice(0, 200)
      : undefined
  const options: OpenDialogOptions = {
    properties: [
      'openDirectory',
      ...(request.createDirectory === true
        ? (['createDirectory'] as const)
        : []),
    ],
    ...(title === undefined ? {} : { title }),
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

type MotionPainter = typeof import('./motion-painter')
let painter: MotionPainter | undefined
async function motionPainter(): Promise<MotionPainter> {
  return (painter ??= await import('./motion-painter'))
}
const exportMotionFrame: MotionPainter['exportMotionFrame'] = async (...args) =>
  (await motionPainter()).exportMotionFrame(...args)

ipcMain.handle(MOTION_FRAME_CHANNEL, async (event, input) => {
  trustedRendererPolicy.authorizeIpc(event)
  const png = await (
    await motionPainter()
  ).previewMotionFrame(input?.scene, input?.frame, input?.width)
  return 'data:image/png;base64,' + png.toString('base64')
})

const videoExports = new Map<
  number,
  { owner: VideoExportOwner; controller: AbortController }
>()

ipcMain.handle(
  VIDEO_EXPORT_CHANNEL,
  async (event, input: unknown): Promise<VideoExportResponse> => {
    trustedRendererPolicy.authorizeIpc(event)
    const api = coreApi
    if (!api || !input || typeof input !== 'object')
      return { kind: 'failed', message: '剪辑工作区尚未就绪。' }
    const { sessionId, projectId, runId, expectedRevision } = input as Record<
      string,
      unknown
    >
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      sessionId.length > 256 ||
      typeof projectId !== 'string' ||
      !projectId ||
      projectId.length > 128 ||
      typeof runId !== 'string' ||
      !runId ||
      runId.length > 128 ||
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      return { kind: 'failed', message: '导出请求无效，请重新打开工程。' }
    const owner = event.sender
    if (videoExports.has(owner.id))
      return { kind: 'failed', message: '此窗口正在导出另一个视频。' }
    const job = new AbortController()
    const abort = () => job.abort()
    const identity = { sessionId, projectId, runId }
    videoExports.set(owner.id, { owner: identity, controller: job })
    owner.once('destroyed', abort)
    const matches = (project: { projectId: string; revision: number }) =>
      project.projectId === projectId && project.revision === expectedRevision
    try {
      const current = await api.videoProject.inspect(sessionId)
      if (!matches(current.project))
        return { kind: 'failed', message: '工程已发生变化，请重新导出。' }
      const { ffmpegPath } = await api.videoProject.analysisStatus()
      if (!ffmpegPath)
        return { kind: 'failed', message: '请先在媒体分析设置中配置 FFmpeg。' }
      const filename = current.project.name
        .replace(/[\\/:\0]/g, '_')
        .slice(0, 100)
      const options: SaveDialogOptions = {
        title: '导出 MP4',
        defaultPath: path.join(current.projectPath, `${filename}.mp4`),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      }
      const window = BrowserWindow.fromWebContents(owner)
      const target = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (target.canceled || !target.filePath || job.signal.aborted)
        return { kind: 'cancelled' }
      const snapshot = await api.videoProject.inspect(sessionId)
      if (!matches(snapshot.project))
        return { kind: 'failed', message: '工程已发生变化，请重新导出。' }
      const result = await renderVideoProject(snapshot, {
        ffmpegPath,
        destination: target.filePath,
        recordWorkspaceOutput: true,
        renderMotionFrame: exportMotionFrame,
        signal: job.signal,
        onProgress: (percent) => {
          if (!owner.isDestroyed())
            owner.send(VIDEO_EXPORT_PROGRESS_CHANNEL, { ...identity, percent })
        },
      })
      return { kind: 'done', ...result }
    } catch (error) {
      return job.signal.aborted
        ? { kind: 'cancelled' }
        : { kind: 'failed', message: errMessage(error) }
    } finally {
      owner.removeListener('destroyed', abort)
      videoExports.delete(owner.id)
    }
  },
)

ipcMain.handle(VIDEO_EXPORT_CANCEL_CHANNEL, (event, owner: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  const job = videoExports.get(event.sender.id)
  if (job && matchesVideoExport(job.owner, owner)) job.controller.abort()
})

// REL-05: the renderer's app version is app.getVersion(), never the preload's.
registerAppVersionIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  version: () => app.getVersion(),
})

// MAIN-27: only folders Core vouches for, never a renderer-chosen path.
registerOpenPathIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  sources: {
    emperorHome: () => config.stateRoot,
    // KRN-01: the renderer names the session; main keeps no focus.
    sessionProject: (sessionId) =>
      coreApi?.host.projectRootForSession(sessionId) ?? null,
    skillFolder: (name, sessionId) => {
      try {
        return coreApi?.skills.get(name, { sessionId }).root ?? null
      } catch {
        return null
      }
    },
    invalidSkillPaths: (sessionId) =>
      coreApi?.skills.list({ sessionId }).invalid.map((item) => item.path) ??
      [],
    logsFolder: () => logLocation.dir,
  },
  isDirectory: (target) => {
    try {
      return fs.statSync(target).isDirectory()
    } catch {
      return false
    }
  },
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
})

// 「用默认应用打开」 / 「在访达中显示」 for a file Core granted the Files pane,
// by address (BUG-05, BUG-10).
registerWorkspaceMediaIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  lookup: (token) => coreApi?.files.mediaGrant(token) ?? null,
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
})

// REL-01 导出诊断包: staged in a private temp folder, listed for the user,
// then zipped where they choose (设置 › 诊断 and the recovery page).
const diagnosticsBundles = new DiagnosticsBundles({
  sources: {
    logDir: logLocation.dir,
    crashDumps: logLocation.crashDumps,
    stateRoot: config.stateRoot,
    homeDir: os.homedir(),
    app: () => diagnosticsAppFacts(),
    core: () =>
      coreApi ? cutroomDiagnosticPaths(coreApi.paths, logLocation.dir) : null,
    system: () => diagnosticsSystemFacts(),
  },
  tempDir: app.getPath('temp'),
})
registerDiagnosticsBundleIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  bundles: diagnosticsBundles,
  chooseTarget: (name) => chooseBundleTarget(name, mainWindow),
  reveal: (target) => shell.showItemInFolder(target),
  homeDir: os.homedir(),
})

// UI-38: a remote markdown image the user clicked, fetched here.
registerRemoteImageIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  client: webFetchClient,
})

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function mainBoundsPath(): string {
  return path.join(config.stateRoot, 'memory', 'desktop', 'window.json')
}

function prepareMainRuntime(): void {
  if (app.isPackaged) {
    const signedRoot = runtimeDefaultsRoot(process.resourcesPath)
    config = resolveConfig({
      argv: mainArgv,
      env: process.env,
      forcedRuntimeRoot: signedRoot,
    })
    const prepared = preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      stateRoot: config.stateRoot,
      appVersion: app.getVersion(),
      stateRootSource:
        config.stateRootSource === 'default'
          ? 'default'
          : config.stateRootSource === 'env'
            ? 'env'
            : 'explicit',
      legacyStateRoot: null,
    })
    legacyRuntimeRoot = prepared.legacyRuntimeRoot
    packagedRuntimeRevision = prepared.manifest.runtimeRevision
    return
  }
  config = resolveConfig({ argv: mainArgv, env: process.env })
  legacyRuntimeRoot = config.runtimeRoot
  loadBundledToolCatalog()
  bootstrapEmperorHome({
    emperorHome: config.stateRoot,
    source:
      config.stateRootSource === 'default'
        ? 'default'
        : config.stateRootSource === 'env'
          ? 'env'
          : 'explicit',
    legacyHome: null,
    appVersion: app.getVersion(),
    runtimeRevision: 'development',
  })
}

async function resetFailedStartup(): Promise<void> {
  await closeCoreHost().catch((error) =>
    console.error(`failed to close the previous startup: ${errMessage(error)}`),
  )
  closeCoreTask = null
  startupIpc?.removeAll()
  startupIpc = null
}

function closeCoreHost(): Promise<void> {
  closeCoreTask ??= closeCoreResources()
  return closeCoreTask
}

async function closeCoreResources(): Promise<void> {
  sessionEventBridge.dispose()
  const current = coreApi
  coreApi = null
  await current?.close()
}

/** Bring a running packaged Emperor forward ('' on success). */
function activateApp(appPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [appPath], { timeout: 10_000 }, (error) =>
      resolve(error ? errMessage(error) : ''),
    )
  })
}

function fail(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  app.quit()
}

async function showBootstrapRecovery(error: unknown): Promise<void> {
  runtimeReady = false
  // The recovery page shows only a code; main.log keeps the whole cause
  // (stack and every `cause`), and the page offers 打开日志 (REL-01).
  mainLog.error(`${APP_NAME} startup failed`, { error })
  if (coreApi) await coreApi.close().catch(() => {})
  coreApi = null
  if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.close()
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  const legacyHome =
    config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null
  const payload = recoveryPayload(error, {
    emperorHome: config.stateRoot,
    legacyHome,
    logFile: logLocation.mainLog,
  })
  const ownerApp =
    payload.canSwitch && error instanceof StateDirectoryLockError
      ? (error.owner?.appPath ?? null)
      : null
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 560,
    minHeight: 480,
    title: `${APP_NAME} · Recovery`,
    icon: appIconPath,
    backgroundColor: '#0c0c0e',
    show: false,
    webPreferences: recoveryWindowWebPreferences(mainDir),
  })
  recoveryWindow = win
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const handle = createRecoveryActionHandler({
    senderId: win.webContents.id,
    emperorHome: payload.emperorHome,
    legacyHome: payload.legacyHome,
    retry: async () => {
      ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
      await resetFailedStartup()
      const restarting = startRuntime()
      if (!win.isDestroyed()) win.close()
      recoveryWindow = null
      await restarting
    },
    openPath: (target) => shell.openPath(target),
    exit: () => app.quit(),
    ...(ownerApp ? { switchToOwner: () => activateApp(ownerApp) } : {}),
    openLogs: () =>
      shell.openPath(
        fs.existsSync(logLocation.mainLog)
          ? logLocation.mainLog
          : logLocation.dir,
      ),
    diagnostics: {
      prepare: async () => {
        const bundle = await diagnosticsBundles.prepare()
        bundleNames.set(bundle.id, bundle.name)
        return bundle
      },
      export: (id) =>
        exportDiagnosticsBundle({
          bundles: diagnosticsBundles,
          id,
          chooseTarget: (name) => chooseBundleTarget(name, win),
          homeDir: os.homedir(),
          name: bundleNames.get(id),
        }),
      discard: (id) => diagnosticsBundles.discard(id),
    },
  })
  const bundleNames = new Map<string, string>()
  ipcMain.handle(
    RECOVERY_ACTION_CHANNEL,
    async (event, action: unknown, bundle: unknown) =>
      handle(event.sender.id, action, bundle),
  )
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (recoveryWindow !== win) return
    recoveryWindow = null
    ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  })
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createRecoveryHtml(payload))}`,
  )
}

/** The save dialog for a diagnostics bundle (Desktop by default). */
async function chooseBundleTarget(
  name: string,
  owner: BrowserWindow | null,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: '导出诊断包',
    buttonLabel: '导出',
    defaultPath: path.join(app.getPath('desktop'), name),
    filters: [{ name: 'Zip', extensions: ['zip'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** Main's own save / open dialog for a `.emperor-backup.zip` (REL-03). */
/** At most `ms` for one status probe of the bundle; its error otherwise. */
async function boundedProbe<T>(
  task: Promise<T> | undefined,
  ms = 3_000,
): Promise<T | { error: string } | null> {
  if (!task) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.catch((error: unknown) => ({ error: errMessage(error) })),
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ error: 'timed out' }), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** app.json of the diagnostics bundle: versions, fuses, helpers, extension. */
async function diagnosticsAppFacts(): Promise<Record<string, unknown>> {
  const [fuses, dictationStatus] = await Promise.all([
    readFuseStates(electronFrameworkBinary(process.execPath)),
    boundedProbe(dictation?.status()),
  ])
  const voice =
    dictationStatus && !('error' in dictationStatus)
      ? {
          available: dictationStatus.available,
          reason: dictationStatus.reason ?? null,
          engine: dictationStatus.engine,
          permissions: dictationStatus.permissions,
        }
      : dictationStatus
  return {
    app: {
      name: APP_NAME,
      version: app.getVersion(),
      packaged: app.isPackaged,
      runtimeRevision: packagedRuntimeRevision || 'development',
      runtimeReady,
      stateRootSource: config.stateRootSource,
      uptimeSeconds: Math.round(process.uptime()),
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    logs: {
      location: logLocation.source,
      level: logLevel,
      crashReporting: crashReporting.ok ? 'local' : crashReporting.error,
    },
    fuses: fuses ?? 'unavailable',
    dictation: voice,
  }
}

/** system.json of the diagnostics bundle. */
function diagnosticsSystemFacts(): Record<string, unknown> {
  const cpus = os.cpus()
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    kernel: os.release(),
    translated: app.runningUnderARM64Translation,
    cpu: { model: cpus[0]?.model ?? '', count: cpus.length },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    locale: app.getLocale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    uptimeSeconds: Math.round(os.uptime()),
  }
}

function registerAppProtocol(): void {
  const devUrl = developmentRendererUrl({
    isPackaged: app.isPackaged,
    env: process.env,
  })
  const devOrigin = devUrl ? new URL(devUrl).origin : null
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const access = appAssetRequestAccess(
      url.host,
      request.headers.get('Origin'),
      devOrigin,
    )
    if (!access.allowed)
      return new Response('asset origin forbidden', { status: 403 })
    if (url.host === 'attachments') {
      const attachmentPath = resolveAttachmentRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
      if (!attachmentPath)
        return new Response('attachment not found', { status: 404 })
      return net.fetch(pathToFileURL(attachmentPath).toString())
    }
    if (url.host === WORKSPACE_MEDIA_HOST)
      return workspaceMediaResponse(
        request,
        (token) => coreApi?.files.mediaGrant(token) ?? null,
        access.allowOrigin,
      )
    if (url.host === 'media') {
      const mediaPath = resolveMediaRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
      if (!mediaPath) return new Response('media not found', { status: 404 })
      return net.fetch(pathToFileURL(mediaPath).toString())
    }
    if (url.host === 'bundle')
      return withContentSecurityPolicy(
        await net.fetch(
          pathToFileURL(
            resolveAssetPath(url.pathname, rendererRoot),
          ).toString(),
        ),
        RENDERER_CSP,
      )
    return new Response('asset not found', { status: 404 })
  })
}

function loadRenderer(): void {
  if (!mainWindow) return
  // The Vite dev server only when not packaged (MAIN-10, renderer-url.ts).
  mainWindow.loadURL(
    mainRendererUrl({ isPackaged: app.isPackaged, env: process.env }),
  )
}

/**
 * No link moves a window off its document (UI-4): will-navigate passes only
 * a reload of the current page, subframes never navigate, popups are denied
 * (http(s) opens as a user link), and untrusted redirects stop.
 */
function secureWindowNavigation(
  win: BrowserWindow,
  policy: TrustedRendererPolicy,
): void {
  const contents = win.webContents
  contents.on('will-navigate', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl, contents.getURL()),
  )
  contents.on('will-frame-navigate', (details) =>
    policy.handleFrameNavigation(details),
  )
  contents.on('will-redirect', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  contents.setWindowOpenHandler((details) => policy.handleWindowOpen(details))
}

/**
 * MAIN-3: the default session (editing and recovery windows)
 * grants nothing — no microphone, camera, screen, notifications or devices,
 * no downloads — except clipboard writes from the main window's own page.
 */
function secureDefaultSession(): void {
  hardenSession(session.defaultSession, {
    allowPermission: defaultSessionPermission({
      isTrustedMainRenderer: (contents) => {
        const main = mainWindow
        return (
          main !== null &&
          !main.isDestroyed() &&
          contents === main.webContents &&
          trustedRendererPolicy.isTrustedUrl(main.webContents.getURL())
        )
      },
    }),
  })
}

/** MAIN-20: Emperor's own menu; packaged builds: no reload, no DevTools. */
function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        appName: APP_NAME,
        packaged: app.isPackaged,
        platform: process.platform,
        openSettings: () => sendMenuCommand('open-settings'),
        openHelp: () => {
          void shell.openPath(path.join(config.runtimeRoot, 'README.md'))
        },
      }),
    ),
  )
}

function sendMenuCommand(command: AppMenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!runtimeReady) return
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () =>
      mainWindow?.webContents.send(APP_MENU_COMMAND_CHANNEL, command),
    )
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.webContents.send(APP_MENU_COMMAND_CHANNEL, command)
}

/** Restored bounds that land on a display connected now (MAIN-19). */
function onScreen(
  bounds: Bounds,
  min?: { width: number; height: number },
): Bounds {
  return fitBoundsToDisplays(
    bounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
    min,
  )
}

/** The packaged smoke's hidden window with the main window's preferences. */
function smokeWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: mainWindowWebPreferences(mainDir, {
      packaged: app.isPackaged,
    }),
  })
  mainWindow = win
  secureWindowNavigation(win, trustedRendererPolicy)
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

function createWindow(): void {
  const boundsPath = mainBoundsPath()
  mainWindow = new BrowserWindow({
    ...onScreen(readBounds(boundsPath)),
    title: APP_NAME,
    icon: appIconPath,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    show: false,
    webPreferences: mainWindowWebPreferences(mainDir, {
      packaged: app.isPackaged,
    }),
  })
  const mainContents = mainWindow.webContents
  coreEventBridge.attach(mainContents)
  sessionEventBridge.attach(mainContents)
  secureWindowNavigation(mainWindow, trustedRendererPolicy)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      const action = mainLoadFailures.onFail(errorCode, isMainFrame)
      if (action === 'ignore') return
      console.error(`did-fail-load: ${errorCode} ${errorDescription}`)
      if (action === 'retry') loadRenderer()
      else fail('页面加载失败', `无法加载前端（${errorDescription}）。`)
    },
  )
  mainWindow.webContents.on('did-finish-load', () =>
    mainLoadFailures.onLoaded(),
  )

  mainWindow.on('close', () => {
    if (!mainWindow) return
    try {
      fs.mkdirSync(path.dirname(boundsPath), { recursive: true })
      const payload = pickBounds(mainWindow.getBounds())
      fs.writeFileSync(
        boundsPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // Best-effort persistence; never block window close on disk errors.
    }
  })
  mainWindow.on('closed', () => {
    painter?.closeMotionPainters()
    coreEventBridge.detach(mainContents)
    sessionEventBridge.detach(mainContents)
    mainWindow = null
  })

  loadRenderer()
}

async function startup(): Promise<void> {
  if (shutdownRequested) return
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
  })
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

  // Opened from its download location, the app runs from a random path
  // and computer use permissions would reset each launch: offer the move.
  if (
    !packagedSmoke &&
    (await offerMoveToApplications({
      platform: process.platform,
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
      ask: async (options) =>
        (
          await dialog.showMessageBox({
            type: 'info',
            message: options.message,
            detail: options.detail,
            buttons: [...options.buttons],
            defaultId: 0,
            cancelId: 1,
          })
        ).response,
      moveToApplications: () => app.moveToApplicationsFolder(),
    }))
  )
    return

  try {
    if (packagedSmoke && !app.isPackaged)
      throw new Error('packaged smoke mode requires a packaged application')
    // REL-03: a restore 设置 › 存储 scheduled is applied before anything
    // opens the home; then the data migrations the home is behind on.
    const restored = await applyPendingHomeRestore(config.stateRoot).catch(
      (error: unknown) => {
        console.warn(`Restore from backup failed: ${String(error)}`)
        return null
      },
    )
    if (restored) console.info(`Restore from backup ${restored.status}`)
    prepareMainRuntime()
    await runPendingDataMigrations(config.stateRoot, {
      appVersion: app.getVersion(),
    })
    startupIpc = trackedIpcMain(ipcMain)
    coreApi = await createCoreHost({
      root: config.runtimeRoot,
      ipcMain: startupIpc,
      eventBridge: coreEventBridge,
      sessionEventBridge,
      authorizeIpc: (event) => trustedRendererPolicy.authorizeIpc(event),
      coreOptions: {
        // Development builds check every model request against its session
        // log (KRN-13); production leaves it to EMPEROR_ASSERT_INVARIANT=1.
        assertRequestInvariant:
          !app.isPackaged || process.env.EMPEROR_ASSERT_INVARIANT === '1',
        renderMotionFrame: exportMotionFrame,
        validateMotionFrame: async (scene, frame) => {
          await (
            await motionPainter()
          ).previewMotionFrame(scene, frame, 640, true)
        },
        appVersion: app.getVersion(),
        ...(packagedRuntimeRevision
          ? { runtimeRevision: packagedRuntimeRevision }
          : {}),
        stateRoot: config.stateRoot,
        emperorHomePrepared: true,
        stateRootSource:
          config.stateRootSource === 'default'
            ? 'default'
            : config.stateRootSource === 'env'
              ? 'env'
              : 'explicit',
        legacyRuntimeRoot: app.isPackaged ? legacyRuntimeRoot : null,
        legacyRuntimeSkillsHandled: app.isPackaged,
        logDirectory: logLocation.dir,
        secretSealer: createLocalKeySealer(config.stateRoot),
      },
    })
    const core = coreApi
    registerEditorNativeIpc({
      ipcMain: startupIpc,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      references: {
        revealPath: (input) => {
          if (!coreApi) throw new Error('core not ready')
          return coreApi.references.revealPath(input)
        },
      },
      showItemInFolder: (target) => shell.showItemInFolder(target),
      openExternal: (url) => shell.openExternal(url),
      openLink: (url) => openUserLink(url),
      skills: {
        folderPath: (input) => {
          if (!coreApi) throw new Error('core not ready')
          return coreApi.skills.folderPath(input)
        },
      },
      openPath: (target) => shell.openPath(target),
      selectFile: async ({ title, filters, multiple }) => {
        const options: OpenDialogOptions = {
          properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          ...(title ? { title } : {}),
          ...(filters.length ? { filters } : {}),
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || !result.filePaths.length)
          return multiple ? [] : null
        return multiple ? result.filePaths : (result.filePaths[0] ?? null)
      },
    })
    dictation = createDictationService()
    registerDictationIpc({
      ipcMain,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      service: dictation,
      ...(process.platform === 'darwin'
        ? { openExternal: (url: string) => shell.openExternal(url) }
        : {}),
    })
    registerAppProtocol()
    if (packagedSmoke) {
      const win = smokeWindow()
      try {
        await win.loadURL(
          mainRendererUrl({ isPackaged: true, env: process.env }),
        )
        await verifyCutroomWindow(
          win,
          core,
          config.stateRoot,
          packagedSmoke.receiptPath,
        )
      } finally {
        win.destroy()
      }
      mainLog.info('packaged smoke finished; quitting')
      app.quit()
      return
    }
  } catch (err) {
    if (packagedSmoke) {
      console.error(`packaged smoke failed: ${errMessage(err)}`)
      if (coreApi) await coreApi.close().catch(() => {})
      coreApi = null
      app.exit(1)
      return
    }
    await showBootstrapRecovery(err)
    return
  }
  runtimeReady = true
  mainLog.info('Core ready; opening the main window')

  createWindow()
}

function startRuntime(): Promise<void> {
  runtimeStarting = true
  startupTask = startup().finally(() => {
    runtimeStarting = false
  })
  return startupTask
}

app.whenReady().then(() => {
  if (!primaryInstance) return
  secureDefaultSession()
  installApplicationMenu()
  return startRuntime()
})

app.on('activate', () => {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show()
    return
  }
  showMainWindow()
})

/** Bring the main window back, creating it when it was closed. */
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (runtimeReady) createWindow()
}

app.on('window-all-closed', () => {
  if (packagedSmoke || runtimeStarting) return
  app.quit()
})

/** Core as it was when quitting began (closeCoreResources clears coreApi). */
let quittingCore: CoreApi | null = null

const coordinateQuit = createQuitCoordinator({
  flush: () => {
    quittingCore = coreApi
    coreApi?.flushAll()
  },
  // Shutdown overran 10s: kill child process trees and terminals now (FIX-07, AGT-06).
  onTimeout: () => quittingCore?.forceStop(),
  close: async () => {
    await startupTask
    await closeCoreHost()
  },
  onError: (error) =>
    console.error(`failed to close CoreApi: ${errMessage(error)}`),
  quit: () => app.quit(),
})

app.on('before-quit', (event) => {
  shutdownRequested = true
  painter?.closeMotionPainters()
  for (const job of videoExports.values()) job.controller.abort()
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  coordinateQuit(event)
})

process.once('SIGTERM', () => app.quit())
process.once('SIGINT', () => app.quit())

app.on('will-quit', () => {
  dictation?.dispose()
  diagnosticsBundles.disposeAll()
  mainLog.info('quit')
})

/**
 * Editor dictation (VO-01): the macOS helper runs as Emperor's own child,
 * from inside the app when packaged (its signature checked first).
 */
function createDictationService(): DictationService {
  const helperApp =
    process.platform === 'darwin'
      ? dictationHelperAppPath({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          desktopRoot: path.resolve(mainDir, '..', '..'),
        })
      : null
  return new DictationService({
    executable: () => {
      if (!helperApp) return null
      const executable = dictationHelperExecutable(helperApp)
      return fs.existsSync(executable) ? executable : null
    },
    ...(app.isPackaged && helperApp
      ? {
          verify: async () =>
            await verifyDictationHelper(
              helperApp,
              path.resolve(fs.realpathSync(process.execPath), '..', '..', '..'),
            ),
        }
      : {}),
  })
}

async function openUserLink(url: string): Promise<'system' | 'refused'> {
  try {
    const target = new URL(url)
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password
    )
      return 'refused'
    await shell.openExternal(target.href)
    return 'system'
  } catch {
    return 'refused'
  }
}
