// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownBlock from './MarkdownBlock.vue'

const { openReference } = vi.hoisted(() => ({ openReference: vi.fn() }))
vi.mock('../conversation/resources/openChatReference', () => ({
  useChatFileActions: () => ({ openReference }),
}))
let container: HTMLDivElement | null = null

afterEach(() => {
  openReference.mockClear()
  container?.remove()
  container = null
  vi.unstubAllGlobals()
  delete (window as { emperor?: unknown }).emperor
})

function mount(content: string, sourceMessageId = 'message-1') {
  container = document.createElement('div')
  document.body.appendChild(container)
  createApp(MarkdownBlock, { content, sourceMessageId }).mount(container)
  return container
}

async function clickChip(root: HTMLElement, selector = 'a.md-link-chip') {
  const anchor = root.querySelector<HTMLAnchorElement>(selector)
  expect(anchor).toBeTruthy()
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  anchor!.dispatchEvent(event)
  await nextTick()
  return { anchor: anchor!, event }
}

describe('MarkdownBlock link chips', () => {
  it('delegates web chips to the Core reference resolver', async () => {
    const root = mount('[docs](https://example.com/guide)')
    const { event } = await clickChip(root)
    expect(event.defaultPrevented).toBe(true)
    expect(openReference).toHaveBeenCalledOnce()
    expect(openReference.mock.calls[0]?.[0]).toEqual({
      href: 'https://example.com/guide',
      label: 'docs',
      sourceMessageId: 'message-1',
    })
  })

  it('delegates file chips without granting raw path access', async () => {
    const root = mount('[report](file:///Users/a%20b/report.pdf)')
    const { event } = await clickChip(root)
    expect(event.defaultPrevented).toBe(true)
    expect(openReference.mock.calls[0]?.[0].href).toBe(
      'file:///Users/a%20b/report.pdf',
    )
  })

  it('hands a mailto link to the system instead of navigating', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }))
    ;(window as { emperor?: unknown }).emperor = { openExternal }
    const root = mount('[mail](mailto:a@b.c)')
    const anchor = root.querySelector<HTMLAnchorElement>('a')
    expect(anchor).toBeTruthy()
    expect(anchor!.classList.contains('md-link-chip')).toBe(false)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor!.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(openReference).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('mailto:a@b.c')
  })
})
