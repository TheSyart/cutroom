// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import type { DelegationResultChatData } from '../../../conversation/types'

import { createExpansionStore, provideChatContext } from '../chatContext'
import DelegationResultCard from './DelegationResultCard.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

const files: DelegationResultChatData['files'] = [
  { path: 'src/login/form.ts', status: 'modified', additions: 4, deletions: 1 },
  {
    path: 'src/login/form.test.ts',
    status: 'added',
    additions: 3,
    deletions: 0,
  },
  { path: 'docs/old.md', status: 'deleted', additions: 0, deletions: 0 },
  {
    path: 'logo.png',
    status: 'added',
    additions: null,
    deletions: null,
    binary: true,
  },
]

function data(
  patch: Partial<DelegationResultChatData> = {},
): DelegationResultChatData {
  return {
    delegationId: 'dlg-one',
    runId: 'dgr-one',
    backend: 'codex',
    title: '重构登录页',
    state: 'ready',
    files,
    totals: { files: 4, additions: 7, deletions: 1 },
    truncated: false,
    conflicts: [],
    at: Date.now() - 60_000,
    undoable: false,
    verifyFirst: false,
    ...patch,
  }
}

function mount(value: DelegationResultChatData): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  const Host = defineComponent({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => 'child',
        rootSessionId: () => 'root',
      })
      return () =>
        h(DelegationResultCard, {
          node: {
            key: 'delegationResult:dlg-one',
            kind: 'delegationResult',
            id: 'dlg-one',
            target: 'chat',
            anchorSeq: 12,
            visibility: 'visible',
            turn: null,
            step: null,
            data: value,
          },
        })
    },
  })
  createApp(Host).mount(container)
  return container
}

describe('archived delegation result', () => {
  it.each(['ready', 'conflicted', 'applied', 'reverted', 'discarded'] as const)(
    'shows saved %s data with no project actions',
    (state) => {
      const root = mount(data({ state }))
      expect(root.querySelector('summary')?.textContent).toContain('重构登录页')
      expect(root.querySelector('summary')?.textContent).toContain('4 个文件')
      expect(
        root
          .querySelector('[data-delegation-result]')
          ?.getAttribute('data-state'),
      ).toBe(state)
      expect(root.querySelector('[data-action], a')).toBeNull()
    },
  )
})
