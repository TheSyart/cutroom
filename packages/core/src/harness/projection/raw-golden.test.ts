import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { historyPage } from '../../session-log/history'
import type { SessionHeader, SessionEvent } from '../../session-log/types'

it('pages archived tool, subagent and compaction records without launching a turn', () => {
  const path = join(__dirname, '__golden__', 'kernel-turn.log.json')
  const original = readFileSync(path, 'utf8')
  type Log = { header: SessionHeader; events: SessionEvent[] }
  const archive = JSON.parse(original) as { root: Log; children: Log[] }
  const root = historyPage(archive.root.header, archive.root.events, {
    maxMessages: 1000,
  })
  expect(root.events).toEqual(archive.root.events)
  expect(root.events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      'tool/result',
      'question/answered',
      'subagent/settled',
      'compaction/summary',
    ]),
  )
  for (const child of archive.children) {
    expect(child.header.parentSession).toBe(root.header.id)
    expect(
      historyPage(child.header, child.events, { maxMessages: 1000 }).events,
    ).toEqual(child.events)
  }
  expect(readFileSync(path, 'utf8')).toBe(original)
})
