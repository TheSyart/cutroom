import { expect, expectBaseline, test } from './baseline'
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// The editor is the product shell: full-width top bar, no application
// sidebar, CapCut-style landing. Workspace layouts are covered by the real
// Electron editing E2E; these baselines guard the shell and start screen.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'editor-shell')
const projectDir = '/projects/visual-build-project'

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page, { projectDir })
})

async function open(
  page: Page,
  path: string,
  options: { theme?: 'dark' | 'light'; width?: number; height?: number } = {},
) {
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 900,
  })
  await page.goto(`${path}?visualTheme=${options.theme ?? 'dark'}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(10, 10)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`editor start shell (${theme}) @baseline`, async ({ page }) => {
    await open(page, '/editor', { theme })
    const topbar = page.locator('.editor-topbar')
    await expect(topbar).toBeVisible()
    await expect(page.getByTestId('app-brand')).toHaveCount(0)
    await expect(page.getByTestId('editor-project-menu')).toBeVisible()
    await expect(page.getByTestId('editor-theme-toggle')).toBeVisible()
    await expect(page.getByTestId('home-start')).toBeVisible()
    await expect(page.getByTestId('new-project')).toBeVisible()
    await expect(page.getByTestId('open-folder')).toBeVisible()
    await expect(page.locator('.project-home')).toContainText('本地项目')
    await expect(page.locator('.sidebar-root')).toHaveCount(0)
    await expect(page.locator('.sidebar-rail')).toHaveCount(0)
    await expect(page.locator('.agent-dock')).toHaveCount(0)
    await shot(page, `start-${theme}`)
    await expectBaseline(page, 'shell', `editor-start-${theme}`)

    const other = theme === 'dark' ? 'light' : 'dark'
    await page.getByTestId('editor-theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', other)
    await page.getByTestId('editor-theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  })

  test(`editor start shell narrow (${theme}) @baseline`, async ({ page }) => {
    await open(page, '/editor', { theme, width: 1100, height: 700 })
    await expect(page.getByTestId('app-brand')).toHaveCount(0)
    await expect(page.getByTestId('editor-project-menu')).toBeVisible()
    await expect(page.getByTestId('home-start')).toBeVisible()
    await expect(page.getByTestId('new-project')).toBeVisible()
    await expect(page.locator('.sidebar-root')).toHaveCount(0)
    await expect(page.locator('.agent-dock')).toHaveCount(0)
    await expect(page.getByText(projectDir, { exact: true })).toBeVisible()
    await shot(page, `start-narrow-${theme}`)
    await expectBaseline(page, 'shell', `editor-start-narrow-${theme}`)
  })

  test(`legacy pages keep the minimal top bar (${theme})`, async ({ page }) => {
    for (const path of ['/scheduler', '/capabilities', '/pulls']) {
      await open(page, path, { theme })
      await expect(page.getByTestId('app-brand')).toHaveCount(0)
      await expect(page.locator('.legacy-topbar')).toBeVisible()
      await expect(page.locator('.legacy-topbar .page-title')).toBeVisible()
      await expect(page.locator('.sidebar-root')).toHaveCount(0)
      await expect(page.getByTestId('legacy-theme-toggle')).toBeVisible()
    }
  })
}
