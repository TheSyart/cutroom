// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import type { TurnFilesChatData } from '../../../conversation/types'

import { createExpansionStore, provideChatContext } from '../chatContext'
import TurnFilesCard from './TurnFilesCard.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

const files: TurnFilesChatData['files'] = [
  { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
  { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
  { path: 'docs/old.md', status: 'deleted', additions: 0, deletions: 4 },
  {
    path: 'logo.png',
    status: 'added',
    additions: null,
    deletions: null,
    binary: true,
  },
  {
    path: 'c.ts',
    oldPath: 'b0.ts',
    status: 'renamed',
    additions: 0,
    deletions: 0,
  },
  {
    path: 'big.log',
    status: 'added',
    additions: null,
    deletions: null,
    tooLarge: true,
  },
  { path: 'z.ts', status: 'modified', additions: 1, deletions: 1 },
]

function data(patch: Partial<TurnFilesChatData> = {}): TurnFilesChatData {
  return {
    turn: 3,
    mode: 'git',
    status: 'recorded',
    files,
    totals: { files: 7, additions: 9, deletions: 6 },
    truncated: false,
    concurrent: false,
    reviewable: true,
    ...patch,
  }
}

function mount(value: TurnFilesChatData): HTMLDivElement {
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
        sessionId: () => 's1',
      })
      return () =>
        h(TurnFilesCard, {
          node: {
            key: 'turnFiles:3',
            kind: 'turnFiles',
            id: '3',
            target: 'chat',
            anchorSeq: 10.5,
            visibility: 'visible',
            turn: 3,
            step: null,
            data: value,
          },
        })
    },
  })
  createApp(Host).mount(container)
  return container
}

const rowNames = (root: HTMLElement) =>
  [...root.querySelectorAll('.file .name')].map((el) => el.textContent)

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('TurnFilesCard', () => {
  it('sums up the turn and lists the first files', async () => {
    const root = mount(data())
    expect(root.querySelector('.headline')?.textContent).toBe('已编辑 7 个文件')
    expect(root.querySelector('.head .add')?.textContent).toBe('+9')
    expect(root.querySelector('.head .del')?.textContent).toBe('−6')
    expect(rowNames(root)).toEqual(['a.ts', 'b.ts', 'old.md'])
    expect(root.querySelector('.file .dir')?.textContent).toBe('src/')
    const text = root.textContent ?? ''
    expect(text).toContain('新建')
    expect(text).toContain('删除')
    expect(root.querySelector('.scope-info')?.getAttribute('aria-label')).toBe(
      '按本轮开始与结束时的项目对比',
    )
    expect(root.querySelector('.more')?.textContent).toContain(
      '再显示 4 个文件',
    )
    root.querySelector<HTMLButtonElement>('.more')!.click()
    await flush()
    expect(rowNames(root)).toHaveLength(7)
    expect(root.textContent).toContain('二进制')
    expect(root.textContent).toContain('由 b0.ts 重命名')
    expect(root.textContent).toContain('过大，未记录内容')
  })

  it('shows an undone turn with what was skipped', () => {
    const root = mount(
      data({
        reverted: {
          reverted: ['src/a.ts', 'src/b.ts'],
          skipped: [{ path: 'docs/old.md', reason: 'changed-since' }],
        },
      }),
    )
    expect(root.querySelector('[data-state="reverted"]')).not.toBeNull()
    expect(root.querySelector('.reverted')?.textContent?.trim()).toBe(
      '已撤销，跳过 1 个',
    )
    expect(root.querySelector('[data-action="undo"]')).toBeNull()
    expect(root.textContent).toContain('已恢复')
    expect(root.textContent).toContain('之后又改过，已跳过')
  })

  it('keeps a single-file summary compact without an empty footer', () => {
    const root = mount(
      data({
        mode: 'tools',
        reviewable: false,
        files: [files[0]!],
        totals: { files: 1, additions: 3, deletions: 1 },
      }),
    )
    expect(root.querySelector('.headline')?.textContent).toBe('已编辑 1 个文件')
    expect(root.querySelector('.totals')?.getAttribute('aria-label')).toBe(
      '新增 3 行，删除 1 行',
    )
    expect(root.querySelector('.foot')).toBeNull()
    expect(root.querySelector('.file .document-icon')).not.toBeNull()
    expect(root.textContent).not.toContain('只统计')
  })

  it('says a task went unrecorded in the task’s words, and keeps older cards unlabeled', () => {
    const skipped = mount(
      data({
        task: { firstTurn: 2, lastTurn: 4 },
        status: 'skipped',
        skipReason: 'git-error',
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        reviewable: false,
      }),
    )
    expect(skipped.textContent?.trim()).toBe('这次任务的改动未记录：Git 出错')
    container?.remove()
    const older = mount(data())
    expect(older.querySelector('.scope')).toBeNull()
    expect(older.querySelector('.turn-files')?.getAttribute('aria-label')).toBe(
      '本轮改动',
    )
  })

  it('keeps a saved snapshot read-only even when the old log marked it reviewable', () => {
    const root = mount(data({ task: { firstTurn: 1, lastTurn: 3 } }))
    expect(root.textContent).toContain('这次任务')
    expect(
      root.querySelector('[data-action], .file button, button.file'),
    ).toBeNull()
  })
})
