import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('editor shell usage', () => {
  it('no longer mounts the application sidebar', () => {
    const app = read('App.vue')
    expect(app).not.toContain('SidebarRoot')
    expect(app).not.toContain('#sidebar')
    expect(app).not.toContain('LegacyTopBar')
    expect(app).toContain('AppFrame')
  })

  it('builds the editor from topbar, asset library, fixed Agent and timeline', () => {
    const page = read('components/editing/EditorPage.vue')
    for (const part of [
      'EditorTopBar',
      'ProjectHome',
      'AssetLibraryPanel',
      'EditorAgentDock',
      'EditorTimeline',
    ])
      expect(page).toContain(part)
    for (const removed of ['EditorToolRail', 'ProjectPanel', 'sidebar'])
      expect(page).not.toContain(removed)
    expect(page).toContain('editor-upper')
    expect(page).toContain('timeline-column')
    expect(
      existsSync(resolve(root, 'components/editing/EditorToolRail.vue')),
    ).toBe(false)
    expect(
      existsSync(resolve(root, 'components/editing/ProjectPanel.vue')),
    ).toBe(false)
  })

  it('keeps only implemented inspector tabs', () => {
    const inspector = read('components/editing/EditorInspector.vue')
    for (const tab of ['clip', 'canvas', 'speed', 'audio'])
      expect(inspector).toContain(`id: '${tab}'`)
    expect(inspector).not.toContain("id: 'assets'")
    for (const unsupported of ['动画', 'AI 效果', '抠像', '蒙版', '美颜'])
      expect(inspector).not.toContain(unsupported)
  })
})
