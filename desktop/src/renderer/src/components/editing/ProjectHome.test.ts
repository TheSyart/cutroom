// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectHome from './ProjectHome.vue'

let app: App | undefined
let root: HTMLDivElement

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  app?.unmount()
  root.remove()
  vi.clearAllMocks()
})

const projects = [
  {
    projectPath: '/tmp/launch',
    name: 'Launch film',
    sessionId: 'session-1',
    openedAt: '2026-06-26T12:00:00.000Z',
    assetCount: 4,
    clipCount: 2,
  },
  {
    projectPath: '/tmp/travel',
    name: 'Travel cut',
    sessionId: 'session-2',
    openedAt: '2026-06-25T12:00:00.000Z',
    assetCount: 9,
    clipCount: 5,
  },
]

async function mount(props: Record<string, unknown> = {}) {
  const emitted = {
    create: vi.fn(),
    open: vi.fn(),
    recent: vi.fn(),
  }
  app = createApp(ProjectHome, {
    projects,
    ...props,
    onCreate: emitted.create,
    onOpen: emitted.open,
    onOpenRecent: emitted.recent,
  })
  app.mount(root)
  await nextTick()
  return emitted
}

describe('project home', () => {
  it('shows each local project and its known metadata', async () => {
    await mount()
    expect(root.querySelector('h1')?.textContent).toBe('剪辑工作台')
    expect(root.textContent).toContain('2 个项目 · 13 个素材')
    expect(root.querySelectorAll('.project-card')).toHaveLength(2)
    expect(root.textContent).toContain('Launch film')
    expect(root.textContent).toContain('/tmp/travel')
    expect(root.textContent).toContain('9 个素材 · 5 个片段')
    for (const unsupported of ['开始创作', '云空间', '视频翻译'])
      expect(root.textContent).not.toContain(unsupported)
  })

  it('continues the most recently opened project even when discovery order differs', async () => {
    const emitted = await mount({
      projects: [
        {
          ...projects[0],
          projectPath: '/tmp/discovered',
          sessionId: '',
          openedAt: '2026-07-01T00:00:00Z',
        },
        projects[1],
        projects[0],
      ],
    })
    root
      .querySelector<HTMLButtonElement>('[data-testid="continue-project"]')!
      .click()
    expect(emitted.recent).toHaveBeenLastCalledWith(projects[0])
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="recent-project-session-2"]',
      )!
      .click()
    expect(emitted.recent).toHaveBeenLastCalledWith(projects[1])
    root
      .querySelector<HTMLButtonElement>('[data-testid="new-project"]')!
      .click()
    root
      .querySelector<HTMLButtonElement>('[data-testid="open-folder"]')!
      .click()
    expect(emitted.create).toHaveBeenCalledOnce()
    expect(emitted.open).toHaveBeenCalledOnce()
  })

  it('starts a first project without displaying a fictitious resume action', async () => {
    await mount({ projects: [] })
    expect(root.textContent).toContain('还没有本地项目')
    expect(root.querySelector('[data-testid="new-project"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="open-folder"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="continue-project"]')).toBeNull()
    expect(root.querySelectorAll('.project-card')).toHaveLength(0)
    expect(root.textContent).not.toContain('个素材')
  })

  it('preserves available counts and distinguishes discovery dates from opened dates', async () => {
    const discovered = {
      projectPath: '/Users/me/Movies/vlog',
      name: 'vlog',
      sessionId: '',
      openedAt: '2026-11-15T00:00:00.000Z',
      clipCount: 0,
    }
    await mount({ projects: [discovered] })
    const row = root.querySelector(
      '[data-testid="recent-project-/Users/me/Movies/vlog"]',
    )!
    expect(row.textContent).toContain('0 个片段')
    expect(row.textContent).toContain('更新于')
    expect(root.textContent).not.toContain('个素材')
    expect(root.querySelector('[data-testid="continue-project"]')).toBeNull()
  })

  it('waits for an open operation and announces errors', async () => {
    await mount({ loading: true, error: '无法打开文件夹' })
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '无法打开文件夹',
    )
    expect(root.querySelectorAll('button:enabled')).toHaveLength(0)
  })
})
