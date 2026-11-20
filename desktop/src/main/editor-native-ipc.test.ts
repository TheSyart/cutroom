import { describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_OPEN_CHANNEL,
  LINK_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
} from '../shared/ipc-contract'
import { registerEditorNativeIpc } from './editor-native-ipc'

function editorHost() {
  const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => unknown
  >()
  const trusted = {}
  const revealPath = vi.fn(() => '/tmp/known-reference'),
    showItemInFolder = vi.fn()
  const folderPath = vi.fn(() => '/tmp/known-skill'),
    openPath = vi.fn(async () => '')
  const openExternal = vi.fn(async () => {}),
    selectFile = vi.fn(async () => '/tmp/picked')
  registerEditorNativeIpc({
    ipcMain: {
      handle: (channel, fn) => {
        handlers.set(channel, fn)
      },
    },
    authorize: (sender) => {
      if (sender !== trusted) throw Error('untrusted renderer')
    },
    references: { revealPath },
    showItemInFolder,
    skills: { folderPath },
    openPath,
    openExternal,
    openLink: async () => 'system',
    selectFile,
  })
  const invoke = async (channel: string, payload: unknown, event = trusted) =>
    handlers.get(channel)!(event, payload)
  return {
    invoke,
    openExternal,
    selectFile,
    revealPath,
    showItemInFolder,
    folderPath,
    openPath,
    handlers,
  }
}

describe('editor native IPC', () => {
  it('authorizes every retained channel before it performs a native action', async () => {
    const host = editorHost()
    expect([...host.handlers.keys()].sort()).toEqual(
      [
        EXTERNAL_OPEN_CHANNEL,
        LINK_OPEN_CHANNEL,
        REFERENCE_REVEAL_CHANNEL,
        SELECT_FILE_CHANNEL,
        SKILLS_OPEN_FOLDER_CHANNEL,
      ].sort(),
    )
    for (const channel of host.handlers.keys())
      await expect(host.invoke(channel, {}, {})).rejects.toThrow(
        'untrusted renderer',
      )
    expect(host.selectFile).not.toHaveBeenCalled()
    expect(host.openExternal).not.toHaveBeenCalled()
    expect(host.revealPath).not.toHaveBeenCalled()
  })
  it('uses Core-resolved references and skills and respects file selection filters', async () => {
    const host = editorHost()
    await host.invoke(REFERENCE_REVEAL_CHANNEL, {
      sessionId: 's',
      referenceId: 'r',
    })
    expect(host.revealPath).toHaveBeenCalledWith({
      sessionId: 's',
      referenceId: 'r',
    })
    expect(host.showItemInFolder).toHaveBeenCalledWith('/tmp/known-reference')
    await host.invoke(SKILLS_OPEN_FOLDER_CHANNEL, { scope: 'user' })
    expect(host.openPath).toHaveBeenCalledWith('/tmp/known-skill')
    const filters = [{ name: 'Video', extensions: ['mp4', 'mov'] }]
    expect(
      await host.invoke(SELECT_FILE_CHANNEL, { filters, multiple: true }),
    ).toBe('/tmp/picked')
    expect(host.selectFile).toHaveBeenCalledWith({ filters, multiple: true })
  })
})
