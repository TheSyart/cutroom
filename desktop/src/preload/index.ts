import { contextBridge, ipcRenderer } from 'electron'
import { createCoreBridge } from './core-ipc'
import { createCoreEventBridge } from './core-events'

import { createEditorCapabilityBridge } from './editor-capabilities'
import { createDictationBridge } from './dictation'
import {
  APP_VERSION_CHANNEL,
  OPEN_PATH_CHANNEL,
  SELECT_DIRECTORY_CHANNEL,
  MOTION_FRAME_CHANNEL,
  VIDEO_EXPORT_CANCEL_CHANNEL,
  VIDEO_EXPORT_CHANNEL,
  VIDEO_EXPORT_PROGRESS_CHANNEL,
  type OpenPathTarget,
  type SelectDirectoryOptions,
  type VideoExportOwner,
  type VideoExportProgress,
  type VideoExportRequest,
} from '../shared/ipc-contract'

// Expose a minimal, read-only desktop surface to the renderer.
contextBridge.exposeInMainWorld('emperor', {
  /** The running app's version, as main's app.getVersion() reports it. */
  appVersion: () => ipcRenderer.invoke(APP_VERSION_CHANNEL),
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  selectDirectory: (options?: SelectDirectoryOptions) =>
    ipcRenderer.invoke(SELECT_DIRECTORY_CHANNEL, options),
  renderMotionFrame: (scene: unknown, frame: number, width: number) =>
    ipcRenderer.invoke(MOTION_FRAME_CHANNEL, { scene, frame, width }),
  exportVideo: (request: VideoExportRequest) =>
    ipcRenderer.invoke(VIDEO_EXPORT_CHANNEL, request),
  cancelVideoExport: (owner: VideoExportOwner) =>
    ipcRenderer.invoke(VIDEO_EXPORT_CANCEL_CHANNEL, owner),
  onVideoExportProgress: (
    listener: (progress: VideoExportProgress) => void,
  ) => {
    const wrapped = (_event: unknown, progress: VideoExportProgress) =>
      listener(progress)
    ipcRenderer.on(VIDEO_EXPORT_PROGRESS_CHANNEL, wrapped)
    return () =>
      ipcRenderer.removeListener(VIDEO_EXPORT_PROGRESS_CHANNEL, wrapped)
  },
  /** A folder Core vouches for (never a path of the renderer's choosing). */
  openPath: (target: OpenPathTarget) =>
    ipcRenderer.invoke(OPEN_PATH_CHANNEL, target),
  ...createEditorCapabilityBridge(ipcRenderer),
  ...createDictationBridge(ipcRenderer),
  ...createCoreBridge(ipcRenderer),
  ...createCoreEventBridge(ipcRenderer),
})
