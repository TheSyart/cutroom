/**
 * Static system-prompt section on linking local files (E-track contract §4).
 * Replies render `[name](path)` as a typed document link the user can click
 * open; paths in code formatting are not clickable. Static on purpose: it
 * sits right after the persona and never changes, so the prefix cache holds.
 */

import type { SystemPromptAssembler } from '../prompt/assembler'

export const LINK_GUIDANCE_PROMPT =
  'Link a verified cut on the editing timeline with [label](#ve-cut-SECONDS), using numeric timeline seconds. ' +
  'When citing source media, distinguish its own timecode from the position on the edited timeline.'

export function installLinkGuidancePromptSection(
  prompt: SystemPromptAssembler,
): () => void {
  return prompt.section({
    name: 'links',
    order: 10,
    text: LINK_GUIDANCE_PROMPT,
  })
}
