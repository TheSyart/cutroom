import { readonly, shallowReactive } from 'vue'
import type { TimelineChip } from '@emperor/core/editing'

// A context-menu selection may precede the lazy dock mounting.
const pending = shallowReactive(new Map<string, TimelineChip[]>())
export const editorTimelineHandoff = readonly(pending)

export function handTimelineReferenceTo(
  sessionId: string,
  reference: TimelineChip,
): void {
  if (!sessionId || reference.timeline.sessionId !== sessionId) return
  pending.set(sessionId, [...(pending.get(sessionId) ?? []), reference])
}

export function takeTimelineReferences(sessionId: string): TimelineChip[] {
  const references = pending.get(sessionId) ?? []
  pending.delete(sessionId)
  return references
}
