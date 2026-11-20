import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SessionEvent } from '../../session-log/types'
import { SessionProjector } from './projector'

it('projects old tool and delegated turns for the conversation history', () => {
  const { root } = JSON.parse(
    readFileSync(join(__dirname, '__golden__', 'kernel-turn.log.json'), 'utf8'),
  ) as {
    root: { header: { id: string }; events: SessionEvent[] }
  }
  const projector = new SessionProjector({ sessionId: root.header.id })
  const events = root.events.flatMap((event) => projector.apply(event))
  expect(events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      'user_message',
      'assistant_done',
      'tool_call',
      'tool_result',
      'subagent_start',
    ]),
  )
  expect(events.every((event) => event.session_id === root.header.id)).toBe(
    true,
  )
})
