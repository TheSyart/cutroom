/** A one-shot request from navigation or the inspector to the editor Agent. */
import { readonly, ref } from 'vue'

export type EditorAgentFocusTarget = 'composer' | 'setup'

export interface EditorAgentFocusRequest {
  id: number
  target: EditorAgentFocusTarget
}

const request = ref<EditorAgentFocusRequest | null>(null)
let nextId = 0

export const editorAgentFocus = readonly(request)

export function requestEditorAgentFocus(
  target: EditorAgentFocusTarget,
): number {
  nextId += 1
  request.value = { id: nextId, target }
  return nextId
}

export function clearEditorAgentFocus(id: number): void {
  if (request.value?.id === id) request.value = null
}
