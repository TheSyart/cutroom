import { afterEach, describe, expect, it } from 'vitest'
import {
  clearEditorAgentFocus,
  editorAgentFocus,
  requestEditorAgentFocus,
} from './editorAgentFocus'

afterEach(() => {
  if (editorAgentFocus.value) clearEditorAgentFocus(editorAgentFocus.value.id)
})

describe('editor agent focus', () => {
  it('keeps the latest request and clears only that request', () => {
    const first = requestEditorAgentFocus('setup')
    const second = requestEditorAgentFocus('composer')
    expect(editorAgentFocus.value).toEqual({ id: second, target: 'composer' })
    clearEditorAgentFocus(first)
    expect(editorAgentFocus.value?.id).toBe(second)
    clearEditorAgentFocus(second)
    expect(editorAgentFocus.value).toBeNull()
  })
})
