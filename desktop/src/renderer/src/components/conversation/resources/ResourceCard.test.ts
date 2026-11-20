// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ResourceCard from './ResourceCard.vue'
import { displayResource } from './resourceModel'
import { LINK_STATUS_KEY } from '../parts/linkStatus'

const { openReference } = vi.hoisted(() => ({ openReference: vi.fn() }))
vi.mock('./openChatReference', () => ({
  useChatFileActions: () => ({ openReference, openFile: vi.fn() }),
}))

describe('ResourceCard', () => {
  it('uses authored text safely and keeps open separate from details', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const resource = displayResource(
      'https://github.com/a/b/pull/42',
      '<script>title</script>',
      'message-12',
    )!
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.mount(element)
    await nextTick()
    expect(element.querySelector('script')).toBeNull()
    expect(element.textContent).toContain('<script>title</script>')
    expect(openReference).not.toHaveBeenCalled()
    element.querySelector<HTMLButtonElement>('[data-resource-detail]')!.click()
    await nextTick()
    expect(element.querySelector('.resource-detail')?.textContent).toBe(
      resource.href,
    )
    expect(openReference).not.toHaveBeenCalled()
    element.querySelector<HTMLAnchorElement>('a')!.click()
    expect(openReference).toHaveBeenCalledWith(resource)
    app.unmount()
    element.remove()
  })

  it('makes a missing file inert without losing its path or icon', async () => {
    const element = document.createElement('div')
    const resource = {
      ...displayResource('docs/gone.md', '', 'm1')!,
      available: false,
    }
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.mount(element)
    await nextTick()
    expect(element.querySelector('a')?.getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(element.querySelector('[data-icon-id]')).not.toBeNull()
    expect(element.textContent).toContain('gone.md')
    app.unmount()
  })

  it('refreshes the actual file status and directory icon without loading web metadata', async () => {
    const element = document.createElement('div')
    const resource = displayResource('/project/docs', '文档目录', 'm2')!
    const version = ref(0)
    let state: 'directory' | 'missing' = 'directory'
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.provide(LINK_STATUS_KEY, {
      version,
      status: async () => ({ state, path: '/project/docs' }),
    })
    app.mount(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('[data-icon-id="folder"]')).not.toBeNull()
    state = 'missing'
    version.value++
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('a')?.getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(element.textContent).toContain('文件不存在')
    app.unmount()
  })
})
