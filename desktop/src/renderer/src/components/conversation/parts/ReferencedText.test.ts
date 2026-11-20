// @vitest-environment jsdom
import { computed, createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { MessageReference } from '../../../types'
import ReferencedText from './ReferencedText.vue'

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

function mount(text: string, references?: MessageReference[]) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ReferencedText, { text, references }) })
  app.provide(APP_CONTEXT_KEY, {
    commands: computed(() => []),
    boot: ref({}),
  } as never)
  app.mount(container)
  return container
}

describe('ReferencedText', () => {
  it('keeps a saved subtitle excerpt readable when the cited project is closed', async () => {
    const timeline = {
      sessionId: 'other',
      projectId: 'film',
      projectName: 'Movie',
      revision: 4,
      target: { kind: 'subtitle' as const, id: 'cue' },
      start: 2,
      end: 3,
      excerpt: '一句台词',
    }
    const root = mount('改【对白】。', [
      { kind: 'timeline', id: 'r1', label: '对白', start: 1, end: 5, timeline },
    ])
    await nextTick()
    const chip = root.querySelector('button[data-target=subtitle]')!
    expect(chip.getAttribute('aria-disabled')).toBe('true')
    expect(chip.getAttribute('title')).toContain('一句台词')
    expect(root.textContent).toContain('此引用属于其他工程')
  })
  it('keeps a URL inside a fence plain even when a plugin splits its text segment', async () => {
    const root = mount(
      'https://visible.test\n```txt\n@github\nhttps://hidden.test\n```',
    )
    await nextTick()
    expect(
      [...root.querySelectorAll('a')].map((link) => link.getAttribute('href')),
    ).toEqual(['https://visible.test'])
  })
  it('adds URL identity alongside plugins without rewriting user text or code', async () => {
    const root = mount(
      '用 @github 看 https://github.com/a/b 和 `https://hidden.test`',
    )
    await nextTick()
    expect(root.textContent).toContain('@github')
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/a/b',
    )
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.textContent).toContain('https://hidden.test')
  })
  it('leaves archived plugin references readable as their original text', async () => {
    const root = mount('用 @github 看看', [
      { kind: 'plugin', id: 'github', label: 'GitHub', start: 2, end: 9 },
    ])
    await nextTick()
    expect(root.textContent).toBe('用 @github 看看')
    expect(root.querySelector('[data-kind=plugin]')).toBeNull()
  })
})
