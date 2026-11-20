import { expect, expectBaseline, test } from './baseline'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

// Full pages that left the settings modal: 定时任务 (/scheduler: tabs, rows,
// row menu, edit and create dialog).

const screenshotDir = resolve(process.cwd(), 'screenshots', 'pages')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
  // Record 主页 links instead of leaving the app.
  await page.addInitScript(() => {
    const target = window as unknown as {
      emperor?: Record<string, unknown>
      __visualExternal?: string[]
    }
    if (target.emperor)
      target.emperor.openExternal = async (url: string) => {
        ;(target.__visualExternal ??= []).push(url)
        return { ok: true }
      }
  })
})

type Theme = 'dark' | 'light'

async function open(
  page: Page,
  path: string,
  options: { theme?: Theme; width?: number; height?: number } = {},
): Promise<Locator> {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 860,
  })
  const separator = path.includes('?') ? '&' : '?'
  await page.goto(`${path}${separator}visualTheme=${options.theme ?? 'dark'}`)
  const shell = page.locator('.page-shell')
  await expect(shell).toBeVisible()
  return shell
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

async function expectPageFits(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  const clipped = await page
    .locator('.page-scroll')
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(clipped).toBeLessThanOrEqual(0)
}

// ── 定时任务 ────────────────────────────────────────────────────────────

function jobRows(shell: Locator) {
  return shell.locator('.job-row')
}

function jobRow(shell: Locator, id: string) {
  return shell.locator(`.job-row[data-job-id="${id}"]`)
}

async function openJobMenu(page: Page, shell: Locator, id: string) {
  await jobRow(shell, id).locator('[data-action="job-menu"]').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

for (const theme of ['dark', 'light'] as const) {
  test(`scheduler page tabs and rows (${theme}) @baseline`, async ({
    page,
  }) => {
    const shell = await open(page, '/scheduler', { theme })
    await expect(
      shell.getByRole('heading', { name: '定时任务', level: 1 }),
    ).toBeVisible()
    await expect(shell.getByText('让 Emperor 按计划执行任务')).toBeVisible()
    await expect(shell.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      '搜索已安排任务',
    )
    await expect(jobRows(shell)).toHaveCount(5)
    await expect(jobRow(shell, 'job_daily_digest')).toContainText(
      /工作日（时间：09:00.*） · 下次运行 \d+小时后/,
    )
    await expect(jobRow(shell, 'job_weekly_report')).toContainText(
      '每周 · 已暂停',
    )
    await expect(jobRow(shell, 'job_release_reminder')).toContainText(
      /一次 · 下次运行 2天后/,
    )
    await expect(jobRow(shell, 'job_migration_check')).toHaveAttribute(
      'data-state',
      'completed',
    )
    // Header: one refresh and the 「创建 ▾」 menu in the title row.
    const header = shell.locator('.page-header')
    await expect(header.getByRole('button', { name: /刷新/ })).toHaveCount(1)
    await expect(header.locator('[data-action="create"]')).toContainText('创建')
    await expect(shell.getByTestId('scheduler-summary')).toContainText(
      '5 个任务',
    )
    await expectPageFits(page)
    await shot(page, `scheduler-all-${theme}`)
    await expectBaseline(page, 'pages', `scheduler-${theme}`)

    const tabs: Array<[string, string, string[]]> = [
      [
        '已开启',
        'enabled',
        ['job_daily_digest', 'job_release_reminder', 'memory-maintenance'],
      ],
      ['已暂停', 'paused', ['job_weekly_report']],
      ['已完成', 'completed', ['job_migration_check']],
    ]
    for (const [label, id, ids] of tabs) {
      await shell.getByRole('tab', { name: new RegExp(`^${label}`) }).click()
      await expect(jobRows(shell)).toHaveCount(ids.length)
      for (const jobId of ids) await expect(jobRow(shell, jobId)).toBeVisible()
      await expectPageFits(page)
      await shot(page, `scheduler-${id}-${theme}`)
    }

    await shell.getByRole('tab', { name: /^全部/ }).click()
    await shell.getByRole('searchbox').fill('周报')
    await expect(jobRows(shell)).toHaveCount(1)
    await shell.getByRole('searchbox').fill('没有这个任务')
    await expect(shell.getByText('没有匹配的任务')).toBeVisible()
  })

  test(`scheduler edit and create dialogs (${theme}) @baseline`, async ({
    page,
  }) => {
    const shell = await open(page, '/scheduler', { theme })
    await jobRow(shell, 'job_daily_digest').locator('.main').click()
    const dialog = page.getByTestId('scheduler-job-dialog')
    await expect(dialog).toHaveAttribute('data-mode', 'edit')
    await expect(dialog.getByLabel('任务名称')).toHaveValue('每日站会摘要')
    await expect(dialog.getByText('运行历史')).toBeVisible()
    await expect(page.locator('[data-action="save-job"]')).toBeVisible()
    await shot(page, `scheduler-edit-${theme}`)
    await expectBaseline(page, 'pages', `scheduler-edit-${theme}`)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await shell.locator('[data-action="create"]').click()
    const menu = page.getByRole('menu', { name: '创建' })
    await expect(menu.locator('[data-menu-item]')).toHaveCount(3)
    await shot(page, `scheduler-create-menu-${theme}`)
    await menu.locator('[data-menu-item="weekly-review"]').click()
    await expect(dialog).toHaveAttribute('data-mode', 'create')
    await expect(dialog.getByLabel('任务名称')).toHaveValue('每周回顾')
    await expect(
      dialog.getByRole('radio', { name: 'Cron 表达式' }),
    ).toBeChecked()
    await shot(page, `scheduler-create-${theme}`)
  })
}

test('scheduler notices and the 指定时间 check (KRN-10)', async ({ page }) => {
  await page.addInitScript(() => {
    ;(
      window as unknown as { __visualSchedulerStatus?: unknown }
    ).__visualSchedulerStatus = {
      running: false,
      startError:
        '另一个 Emperor 进程（pid 4242）正在运行定时任务，本进程不启动定时任务',
      rejectedJobs: 1,
    }
  })
  const shell = await open(page, '/scheduler', { theme: 'light' })
  await expect(shell.locator('[data-scheduler-notice="start"]')).toContainText(
    'pid 4242',
  )
  await expect(
    shell.locator('[data-scheduler-notice="rejected"]'),
  ).toContainText('1 个定时任务无法读取')
  await expect(jobRow(shell, 'job_daily_digest')).toBeVisible()
  await shot(page, 'scheduler-notices-light')

  await shell.locator('[data-action="create"]').click()
  await page
    .getByRole('menu', { name: '创建' })
    .locator('[data-menu-item="blank"]')
    .click()
  const dialog = page.getByTestId('scheduler-job-dialog')
  await dialog.getByRole('radio', { name: '指定时间' }).click()
  await expect(dialog.getByText('请选择日期和时间')).toBeVisible()
  await expect(page.locator('[data-action="create-job"]')).toBeDisabled()
  await shot(page, 'scheduler-at-required-light')
})

test('scheduler row menu runs, pauses, resumes, creates and deletes', async ({
  page,
}) => {
  const shell = await open(page, '/scheduler', { theme: 'light' })
  const digest = jobRow(shell, 'job_daily_digest')

  let menu = await openJobMenu(page, shell, 'job_daily_digest')
  await expect(menu.locator('[data-menu-item="delete"]')).toBeEnabled()
  await shot(page, 'scheduler-row-menu-light')
  await menu.locator('[data-menu-item="pause"]').click()
  await expect(digest).toHaveAttribute('data-state', 'paused')
  await expect(digest).toContainText('已暂停')

  menu = await openJobMenu(page, shell, 'job_daily_digest')
  await menu.locator('[data-menu-item="resume"]').click()
  await expect(digest).toHaveAttribute('data-state', 'enabled')

  menu = await openJobMenu(page, shell, 'job_daily_digest')
  await menu.locator('[data-menu-item="run"]').click()
  await expect(
    page.getByRole('status').filter({ hasText: '已手动运行任务' }),
  ).toBeVisible()

  // Protected system jobs: run / pause only.
  menu = await openJobMenu(page, shell, 'memory-maintenance')
  await expect(menu.locator('[data-menu-item="delete"]')).toBeDisabled()
  await page.keyboard.press('Escape')
  await jobRow(shell, 'memory-maintenance').locator('.main').click()
  const dialog = page.getByTestId('scheduler-job-dialog')
  await expect(dialog.getByText('受保护的系统任务')).toBeVisible()
  await expect(page.locator('[data-action="delete-job"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await shell.locator('[data-action="create"]').click()
  await page.locator('[data-menu-item="blank"]').click()
  await expect(page.locator('[data-action="create-job"]')).toBeDisabled()
  await dialog.getByLabel('任务名称').fill('视觉巡检')
  await dialog.getByLabel(/任务内容/).fill('截图并检查定时任务页')
  await page.locator('[data-action="create-job"]').click()
  await expect(dialog).toBeHidden()
  const created = shell.locator('.job-row', { hasText: '视觉巡检' })
  await expect(created).toBeVisible()
  await expect(shell.getByTestId('scheduler-summary')).toContainText('6 个任务')

  await created.locator('[data-action="job-menu"]').click()
  await page.locator('[data-menu-item="delete"]').click()
  const confirm = page.getByRole('dialog', { name: '删除「视觉巡检」？' })
  await expect(confirm).toBeVisible()
  await shot(page, 'scheduler-delete-confirm-light')
  await confirm.locator('[data-action="confirm-delete"]').click()
  await expect(created).toHaveCount(0)
})

// ── Page frame (UI-S08) ──────────────────────────────────────────────────

test('every page body is 880 wide and the title is 20/600', async ({
  page,
}) => {
  for (const path of ['/scheduler']) {
    await open(page, path, { theme: 'light', width: 1440, height: 900 })
    const body = page.locator('.page-shell .page-body').first()
    const width = await body.evaluate((el) =>
      Math.round(el.getBoundingClientRect().width),
    )
    expect(width, path).toBe(880)
    const title = page.locator('.page-shell .page-title').first()
    await expect(title).toHaveCSS('font-size', '20px')
    await expect(title).toHaveCSS('font-weight', '600')
  }
})

test('定时任务 keeps the service note behind ⓘ (UI-S08 5)', async ({
  page,
}) => {
  await open(page, '/scheduler', { theme: 'light', width: 1280, height: 860 })
  await expect(page.getByTestId('scheduler-summary')).toBeVisible()
  await expect(page.getByText('最多补跑一次')).toHaveCount(0)
  await page.getByRole('button', { name: '关于定时任务服务' }).click()
  await expect(page.getByText(/最多补跑一次/)).toBeVisible()
  await shot(page, 'scheduler-note-light')
})

// ── Settings modal without the page sections ───────────────────────────

for (const theme of ['dark', 'light'] as const) {
  test(`settings modal lists only its own sections (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(`/chat/build-ui?settings=general&visualTheme=${theme}`)
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()
    const nav = dialog.getByRole('navigation', { name: '设置分区' })
    // Four groups, nine sections (UI-S07).
    await expect(nav.getByRole('button')).toHaveCount(11)
    for (const label of [
      '电脑操作',
      '浏览器',
      '语音',
      '记忆',
      'Skills',
      '高级',
    ])
      await expect(
        nav.getByRole('button', { name: label, exact: true }),
      ).toBeVisible()
    for (const label of [
      'Hooks',
      '诊断',
      '桌宠',
      '插件',
      'MCP',
      '工具',
      '配置',
      'Scheduler',
      '定时任务',
    ])
      await expect(
        nav.getByRole('button', { name: label, exact: true }),
      ).toHaveCount(0)
    await shot(page, `settings-modal-sections-${theme}`)
  })
}

test('moved settings links open their pages', async ({ page }) => {
  for (const [section, path, heading] of [
    ['scheduler', '/scheduler', '定时任务'],
    ['mcp', '/capabilities/mcp', '能力'],
    ['tools', '/capabilities/tools', '能力'],
  ] as const) {
    await page.goto(`/chat/build-ui?settings=${section}&visualTheme=light`)
    await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`))
    await expect(
      page.getByRole('heading', { name: heading, level: 1 }),
    ).toBeVisible()
    await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0)
  }
})

test('pages fit a narrow window', async ({ page }) => {
  await open(page, '/scheduler', { theme: 'light', width: 700, height: 820 })
  await shot(page, 'scheduler-narrow-light')
})
