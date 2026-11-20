import {
  APP_MENU_COMMAND_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  WORKSPACE_MEDIA_OPEN_CHANNEL,
  MARKDOWN_REMOTE_IMAGE_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  LINK_OPEN_CHANNEL,
  type AppMenuCommand,
  type FileDialogFilter,
} from '../shared/ipc-contract'
interface IpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  send(channel: string, payload?: unknown): void
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

export function createEditorCapabilityBridge(ipcRenderer: IpcRendererLike) {
  return {
    revealReference: (input: { sessionId: string; referenceId: string }) =>
      ipcRenderer.invoke(REFERENCE_REVEAL_CHANNEL, input),
    /** 「用默认应用打开」: the file behind a granted media address (BUG-05, BUG-10). */
    openWorkspaceMedia: (url: string) =>
      ipcRenderer.invoke(WORKSPACE_MEDIA_OPEN_CHANNEL, { url }),
    /** 「在访达中显示」: the file behind a granted media address (BUG-10). */
    revealWorkspaceMedia: (url: string) =>
      ipcRenderer.invoke(WORKSPACE_MEDIA_OPEN_CHANNEL, {
        url,
        action: 'reveal',
      }),
    openExternal: (url: string) =>
      ipcRenderer.invoke(EXTERNAL_OPEN_CHANNEL, url),
    /** Open an eligible web link in the system browser. */
    openLink: (url: string) => ipcRenderer.invoke(LINK_OPEN_CHANNEL, url),
    /** A remote markdown image the user asked to see: main fetches it. */
    loadRemoteImage: (url: string) =>
      ipcRenderer.invoke(MARKDOWN_REMOTE_IMAGE_CHANNEL, { url }),
    /** App menu items that act in the window (偏好设置… opens 设置). */
    onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
      const wrapped = (_event: unknown, command: unknown) => {
        if (command === 'open-settings') listener(command)
      }
      ipcRenderer.on(APP_MENU_COMMAND_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(APP_MENU_COMMAND_CHANNEL, wrapped)
    },
    openSkillsFolder: (input: {
      scope: 'user' | 'project'
      sessionId?: string | null
    }) => ipcRenderer.invoke(SKILLS_OPEN_FOLDER_CHANNEL, input),
    selectFile: (
      input: {
        title?: string
        filters?: FileDialogFilter[]
        multiple?: boolean
      } = {},
    ) => ipcRenderer.invoke(SELECT_FILE_CHANNEL, input),
  }
}
