/**
 * The composer's rich document (RF-02, contract
 * private-docs/specs/2026-09-30-references/00-契约.md §1–2): paragraphs of
 * text and atomic reference chips. Pure: the schema, serialization to what
 * the model receives plus `references`, rebuilding a document from text
 * (known names become chips, legacy `@skill(name)` markers too), and the
 * slash-command trigger at the caret.
 */
import { Schema, type Node as PMNode } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import type { TimelineChip } from '@emperor/core/editing'
import type { MessageReference } from '../../../types'
import {
  EMPTY_CATALOG,
  chipLabel,
  gestureOf,
  referencesFit,
  spansFromReferences,
  spansFromText,
  validId,
  type ComposerCatalog,
  type ReferenceSpan,
} from './referenceText'

export {
  EMPTY_CATALOG,
  gestureOf,
  referencesFit,
  validId,
  type ComposerCatalog,
} from './referenceText'

export type ComposerReferenceKind = 'skill'

/** A chip with UTF-16 offsets into the visible message. */
export type ComposerReference = MessageReference

export interface ComposerOutput {
  /** Visible message, with paragraphs joined by a newline. */
  content: string
  references: ComposerReference[]
}

/** Stands in for a chip when reading the text around the caret. */
const CHIP_CHAR = '￼'

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    timelineChip: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: false,
      attrs: { reference: {} },
      toDOM: (node) => [
        'span',
        { contenteditable: 'false' },
        node.attrs.reference.label,
      ],
    },
    chip: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: false,
      attrs: { kind: {}, id: {}, label: {} },
      toDOM: (node) => [
        'span',
        {
          class: 'composer-chip',
          'data-kind': node.attrs.kind,
          'data-id': node.attrs.id,
          role: 'img',
          'aria-label': `技能 ${node.attrs.label}`,
          contenteditable: 'false',
        },
        node.attrs.label,
      ],
      parseDOM: [
        {
          tag: 'span.composer-chip',
          getAttrs: (dom) => {
            const element = dom as HTMLElement
            const kind = element.getAttribute('data-kind')
            const id = element.getAttribute('data-id') ?? ''
            if (kind !== 'skill' || !validId(kind, id)) return false
            return {
              kind,
              id,
              label: chipLabel(element.textContent ?? id, id),
            }
          },
        },
      ],
    },
  },
})

export function chipNode(
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): PMNode {
  return composerSchema.nodes.chip!.create({
    kind,
    id,
    label: chipLabel(label, id),
  })
}

/** The text for the model and where each chip sits in it. */
export function serializeComposer(doc: PMNode): ComposerOutput {
  let content = ''
  const references: ComposerReference[] = []
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) content += '\n'
    paragraph.forEach((node) => {
      if (node.type.name === 'timelineChip') {
        const chip = node.attrs.reference as TimelineChip
        const token = `【${chip.label}】`
        references.push({
          ...chip,
          start: content.length,
          end: content.length + token.length,
        })
        content += token
      } else if (node.type.name === 'chip') {
        const kind = node.attrs.kind as ComposerReferenceKind
        const id = node.attrs.id as string
        const text = gestureOf(kind, id)
        references.push({
          kind,
          id,
          label: node.attrs.label as string,
          start: content.length,
          end: content.length + text.length,
        })
        content += text
      } else content += node.text ?? ''
    })
  })
  return { content, references }
}

function paragraphFrom(
  line: string,
  spans: readonly ReferenceSpan[],
  offset: number,
): PMNode {
  const nodes: PMNode[] = []
  let last = 0
  const pushText = (text: string): void => {
    if (text) nodes.push(composerSchema.text(text))
  }
  for (const span of spans) {
    const start = span.start - offset
    const end = span.end - offset
    pushText(line.slice(last, start))
    if (span.chip?.kind === 'timeline')
      nodes.push(
        composerSchema.nodes.timelineChip!.create({ reference: span.chip }),
      )
    else if (span.chip)
      nodes.push(chipNode(span.chip.kind, span.chip.id, span.chip.label))
    else pushText(span.text ?? '')
    last = end
  }
  pushText(line.slice(last))
  return composerSchema.nodes.paragraph!.create(null, nodes)
}

/**
 * A document from text. With `references` that fit the text, chips sit
 * exactly there, including timeline metadata. Otherwise only known skills become chips.
 */
export function composerDocFromText(
  text: string,
  catalog: ComposerCatalog = EMPTY_CATALOG,
  references?: readonly ComposerReference[],
): PMNode {
  const lines = text.split('\n')
  const exact =
    references !== undefined &&
    references.length > 0 &&
    referencesFit(text, references)
  const paragraphs: PMNode[] = []
  let offset = 0
  for (const line of lines) {
    const lineEnd = offset + line.length
    const spans: ReferenceSpan[] = exact
      ? spansFromReferences(
          references!.filter(
            (reference) =>
              reference.start >= offset && reference.end <= lineEnd,
          ),
        ).map((span) => ({
          ...span,
          start: span.start - offset,
          end: span.end - offset,
        }))
      : spansFromText(line, catalog)
    paragraphs.push(paragraphFrom(line, spans, 0))
    offset = lineEnd + 1
  }
  return composerSchema.nodes.doc!.create(null, paragraphs)
}

/** Plain text with known tokens turned into chips (for paste). */
export function composerInlineFromText(
  text: string,
  catalog: ComposerCatalog,
): PMNode[][] {
  return text.split('\n').map((line) => {
    const paragraph = paragraphFrom(line, spansFromText(line, catalog), 0)
    const inline: PMNode[] = []
    paragraph.forEach((node) => inline.push(node))
    return inline
  })
}

/** A `/` being typed at the caret (start of message or after whitespace). */
export interface ComposerTrigger {
  sigil: '/'
  query: string
  /** Document positions of the typed `/query`. */
  from: number
  to: number
  /** At the very start of the message (the command palette's place). */
  atStart: boolean
}

const TRIGGER = /(^|\s)\/([^\s/@￼]*)$/

export function triggerAt(state: EditorState): ComposerTrigger | null {
  const { selection } = state
  if (!selection.empty) return null
  const $from = selection.$from
  if ($from.parent.type.name !== 'paragraph') return null
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    CHIP_CHAR,
  )
  const match = TRIGGER.exec(before)
  if (!match) return null
  const query = match[2]!
  const to = selection.from
  const from = to - query.length - 1
  const atStart =
    $from.index(0) === 0 && $from.parentOffset === query.length + 1
  return {
    sigil: '/',
    query,
    from,
    to,
    atStart,
  }
}

/** Typing a space after a known skill name converts it to a chip. */
export function typedGestureAt(
  state: EditorState,
  catalog: ComposerCatalog,
): {
  from: number
  to: number
  kind: ComposerReferenceKind
  id: string
  label: string
} | null {
  const { selection } = state
  if (!selection.empty) return null
  const $from = selection.$from
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    CHIP_CHAR,
  )
  const match = /(^|\s)\/([a-z0-9][a-z0-9._-]*)$/.exec(before)
  if (!match) return null
  const kind = 'skill'
  const id = match[2]!
  const label = catalog.skill(id)
  if (label === undefined || !validId(kind, id)) return null
  return {
    from: selection.from - id.length - 1,
    to: selection.from,
    kind,
    id,
    label,
  }
}
