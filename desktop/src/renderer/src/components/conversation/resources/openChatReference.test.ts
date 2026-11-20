import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openChatReference, openGrantedFile } from './openChatReference'

const { invokeCore, openLink, revealReference, openWorkspaceMedia } =
  vi.hoisted(() => ({
    invokeCore: vi.fn(),
    openLink: vi.fn(),
    revealReference: vi.fn(),
    openWorkspaceMedia: vi.fn(),
  }))
vi.mock('../../../api/backend', () => ({
  invokeCore,
  openLink,
  revealReference,
  openWorkspaceMedia,
}))

beforeEach(() => vi.resetAllMocks())

const reference = {
  href: 'notes.txt',
  label: '素材笔记',
  sourceMessageId: 'message-3',
}
describe('opening a file or reference from project chat', () => {
  it('reveals only the reference Core resolved in the displayed session', async () => {
    invokeCore.mockResolvedValue({
      id: 'r1',
      kind: 'project_file',
      available: true,
      actions: ['reveal'],
    })
    await openChatReference('editing-session', reference)
    expect(invokeCore).toHaveBeenCalledWith('references.resolve', {
      sessionId: 'editing-session',
      ...reference,
    })
    expect(revealReference).toHaveBeenCalledWith({
      sessionId: 'editing-session',
      referenceId: 'r1',
    })
    expect(openWorkspaceMedia).not.toHaveBeenCalled()
  })

  it('opens the URL normalized by Core only with its external action', async () => {
    const url = 'https://example.com/guide'
    invokeCore.mockResolvedValue({
      id: 'r2',
      kind: 'web',
      available: true,
      tooltip: url,
      actions: ['open_external'],
    })
    await openChatReference('editing-session', { ...reference, href: url })
    expect(openLink).toHaveBeenCalledWith(url)
    expect(revealReference).not.toHaveBeenCalled()
  })

  it('keeps unavailable references inert', async () => {
    invokeCore.mockResolvedValue({
      id: 'r3',
      kind: 'project_file',
      available: false,
      actions: [],
    })
    await expect(
      openChatReference('editing-session', reference),
    ).rejects.toThrow('已不存在')
    expect(revealReference).not.toHaveBeenCalled()
    expect(openLink).not.toHaveBeenCalled()
  })

  it('opens an attachment using the resulting media grant', async () => {
    invokeCore.mockResolvedValue({ url: 'app://workspace-media/grant' })
    const input = {
      source: 'attachment',
      attachmentId: 'stored-attachment',
    } as const
    await openGrantedFile(input)
    expect(invokeCore).toHaveBeenCalledWith('files.mediaUrl', input)
    expect(openWorkspaceMedia).toHaveBeenCalledWith(
      'app://workspace-media/grant',
    )
  })
})
