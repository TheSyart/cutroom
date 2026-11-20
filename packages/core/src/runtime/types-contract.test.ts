import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from './types'

const thought = {
  event: 'agent_thought',
  thought_id: 's:1:0:0',
  stage: 'reasoning',
  status: 'running',
} satisfies RuntimeEvent

describe('runtime event union', () => {
  it('carries the projected thought event', () => {
    expect(thought.event).toBe('agent_thought')
  })
})
