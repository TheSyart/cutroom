import { createUserMessage, createMessage } from '../llm'
/**
 * Derived-message cache contract against a scratch oracle: project new nodes
 * once, rebuild on surface replacements, return fresh arrays over shared
 * frozen messages, and remain value-equal to replay at every step.
 */

import { describe, expect, it } from 'vitest'
import { testSession } from './test-helpers'
import { Session } from './index'

function userText(session: Session, text: string): void {
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
}

/** From-scratch oracle: replay the log into a fresh session and derive. */
function scratch(session: Session): unknown {
  return testSession(`${session.id}-scratch-${session.seq}`, [
    ...session.events,
  ]).deriveMessages()
}

describe('derived-message cache', () => {
  it('keeps retired instructions in the historical log and omits them from new model requests', () => {
    const session = testSession('retired-context')
    userText(session, '用户原文里的 @github 和 /goal')
    const producers = [
      'goal',
      'goal-round',
      'tool-goal',
      'plugin-invocation',
      'skill-invocation',
    ]
    for (const producer of producers) {
      session.append(
        'user/message',
        createUserMessage({
          source: { kind: 'context', producer },
          content: [{ type: 'text', text: producer }],
        }),
        { surfaceOp: 'append' },
      )
    }
    const reopened = new Session(session.header, session.events, 'restore')
    expect(reopened.events).toEqual(session.events)
    expect(reopened.deriveMessages().map((item) => item.content)).toEqual([
      [{ type: 'text', text: '用户原文里的 @github 和 /goal' }],
      [{ type: 'text', text: 'skill-invocation' }],
    ])
  })

  it('stays deep-equal to a from-scratch replay derivation as the log grows', () => {
    const session = testSession('cache-grow')
    session.append('turn/start', { turn: 1 })
    userText(session, 'one')
    expect(session.deriveMessages()).toEqual(scratch(session))
    userText(session, 'two')
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: 'append' },
    )
    expect(session.deriveMessages()).toEqual(scratch(session))
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 2,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
        usage: { inputTokens: 1, outputTokens: 0 },
      },
      { surfaceOp: 'append' },
    )
    expect(session.deriveMessages()).toEqual(scratch(session))
  })

  it('rebuilds on a surface replace and still matches scratch', () => {
    const session = testSession('cache-replace')
    session.append('turn/start', { turn: 1 })
    userText(session, 'one')
    userText(session, 'two')
    const beforeReplace = session.deriveMessages()
    expect(beforeReplace).toHaveLength(2)

    const nodes = session.surface.nodes
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'context', producer: 'compact' },
      }),
      {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! },
        sourceEventSeqs: [nodes[0]!, nodes[1]!],
      },
    )

    expect(session.deriveMessages()).toHaveLength(1)
    expect(session.deriveMessages()).toEqual(scratch(session))
    expect(beforeReplace).toHaveLength(2)
  })

  it('returns a fresh array per call: later appends never grow a held snapshot', () => {
    const session = testSession('cache-snapshot')
    session.append('turn/start', { turn: 1 })
    userText(session, 'one')
    const first = session.deriveMessages()
    userText(session, 'two')
    const second = session.deriveMessages()
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
    // Array snapshots share their frozen message projections.
    expect(second[0]).toBe(first[0])
    expect(Object.isFrozen(first[0])).toBe(true)
  })
})

describe('Session.deriveEventMessage — the per-event projection', () => {
  it('projects one appended event exactly as the full derivation projects its node', () => {
    const session = testSession('per-event')
    session.append('turn/start', { turn: 1 })
    const event = session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    // Full and per-event derivation share one projection.
    expect(session.deriveEventMessage(event)).toEqual(
      session.deriveMessages().at(-1),
    )
  })

  it("reuses the logged event's already frozen content", () => {
    const session = testSession('per-event-clone')
    session.append('turn/start', { turn: 1 })
    const event = session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'orig' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const message = session.deriveEventMessage(event)!
    expect(message.content).toBe(event.data.content)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(() => {
      ;(message.content[0] as { text: string }).text = 'mutated'
    }).toThrow()
    expect(session.deriveMessages().at(-1)!.content).toEqual([
      { type: 'text', text: 'orig' },
    ])
  })

  it('projects null for events that produce no message (boundaries, empty assistant)', () => {
    const session = testSession('per-event-null')
    session.append('turn/start', { turn: 1 })
    const boundary = session.append('step/start', { turn: 1, step: 1 })
    expect(session.deriveEventMessage(boundary)).toBeNull()
    const empty = session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: 'append' },
    )
    expect(session.deriveEventMessage(empty)).toBeNull()
  })
})
