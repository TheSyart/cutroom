import type { TimelineChip } from '../../editing/timeline-reference'

export type MessageReference = (
  | TimelineChip
  | { kind: 'skill'; id: string; label: string; timeline?: undefined }
  | { kind: 'plugin'; id: string; label: string; timeline?: undefined }
) & { start: number; end: number }

export type SubmittedReference = Exclude<MessageReference, { kind: 'plugin' }>

/** Identifiers accepted on newly submitted messages. */
export const SKILL_REFERENCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TIMELINE_REFERENCE_ID =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/

export const MAX_MESSAGE_REFERENCES = 32

export function referenceGesture(
  reference: Pick<SubmittedReference, 'kind' | 'id' | 'label'>,
): string {
  if (reference.kind === 'timeline') return `【${reference.label}】`
  return `/${reference.id}`
}

/**
 * Whether `references` sit in `content` as the contract says: valid ids,
 * in order, not overlapping, each slice exactly its gesture.
 */
export function referencesFit(
  content: string,
  references: readonly MessageReference[],
): boolean {
  if (references.length > MAX_MESSAGE_REFERENCES) return false
  let last = 0
  for (const reference of references) {
    if (reference.kind !== 'skill' && reference.kind !== 'timeline')
      return false
    const pattern =
      reference.kind === 'skill' ? SKILL_REFERENCE_ID : TIMELINE_REFERENCE_ID
    if (
      (reference.kind === 'timeline' &&
        (!reference.timeline || /[\r\n]/.test(reference.label))) ||
      !pattern.test(reference.id) ||
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < last ||
      reference.end > content.length ||
      content.slice(reference.start, reference.end) !==
        referenceGesture(reference)
    )
      return false
    last = reference.end
  }
  return true
}

/** Whether `content` already carries the `/name` gesture of a skill. */
export function hasSkillGesture(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`).test(content)
}
