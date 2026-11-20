import { inject } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import {
  invokeCore,
  openLink,
  openWorkspaceMedia,
  revealReference,
} from '../../../api/backend'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { useChatContext } from '../chatContext'

export interface ChatReference {
  href: string
  label: string
  sourceMessageId: string
}

export async function openGrantedFile(target: FilePreviewInput): Promise<void> {
  const { url } = await invokeCore('files.mediaUrl', target)
  await openWorkspaceMedia(url)
}

export async function openChatReference(
  sessionId: string,
  reference: ChatReference,
): Promise<void> {
  const { href, label, sourceMessageId } = reference
  const target = await invokeCore('references.resolve', {
    sessionId,
    href,
    label,
    sourceMessageId,
  })
  if (!target.available) throw new Error('这个引用的文件已不存在。')
  if (target.kind === 'web' && target.actions.includes('open_external')) {
    await openLink(target.tooltip)
  } else if (target.actions.includes('reveal')) {
    await revealReference({ sessionId, referenceId: target.id })
  } else {
    throw new Error('无法打开这个引用。')
  }
}

export function useChatFileActions() {
  const chat = useChatContext()
  const app = inject(APP_CONTEXT_KEY, null)
  const report = (error: unknown) => app?.showError(error, '打开文件或引用失败')
  return {
    openReference: (ref: ChatReference) =>
      openChatReference(
        chat.sessionId() || app?.sessionId.value || '',
        ref,
      ).catch(report),
    openFile: (target: FilePreviewInput) =>
      openGrantedFile(target).catch(report),
  }
}
