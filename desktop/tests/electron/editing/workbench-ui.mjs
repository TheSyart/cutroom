import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const [phase, input] = process.argv.slice(2)
assert.ok(
  ['before', 'after'].includes(phase) && input,
  'Supply before|after and a spoken-word Cutroom project',
)
const output = join(desktop, 'out-e2e/agent-workbench', phase)
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'cutroom-workbench-check-'))
const data = join(temp, 'state')
const fixture = join(temp, '口播剪辑')
const measurements = []
await mkdir(data)
await cp(resolve(input), fixture, { recursive: true })
const timelineFile = join(fixture, 'timeline.json')
const project = JSON.parse(await readFile(timelineFile, 'utf8'))
project.name = '从零实现 Agent · 工具调用与原声同步｜第七期课程剪辑工程'
await writeFile(timelineFile, JSON.stringify(project))
await writeFile(
  join(data, 'model_config.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeModelId: 'ui-test',
    models: [
      {
        entryId: 'ui-test',
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'deepseek-chat',
        displayName: '验收模型',
        apiBase: 'http://127.0.0.1:1/v1',
        apiKey: 'local-fixture',
        contextWindowTokens: 128000,
        maxTokens: 4096,
        reasoningEffort: null,
      },
    ],
  }),
)
const env = {
  ...process.env,
  VIDEO_EDIT_AGENT_DATA_DIR: data,
  EMPEROR_CONFIG_DIR: data,
  VIDEO_EDIT_AGENT_LEGACY_MODEL_HOME: '',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  cwd: desktop,
  args: ['.', '--user-data-dir=' + join(temp, 'profile')],
  env,
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const frame = () =>
    page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    )
  const snap = async (name) => {
    await frame()
    await page.screenshot({ path: join(output, name + '.png') })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('open-folder').waitFor()
  await snap('home-dark')
  await page.getByTestId('editor-theme-toggle').click()
  await snap('home-light')
  await page.getByTestId('editor-theme-toggle').click()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, fixture)
  await page.getByTestId('open-folder').click()
  await page.locator('.editor-workspace').waitFor()
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-preview-active="true"] video')
        ?.videoWidth,
  )
  await page.locator('.playback-scrubber').evaluate((el) => {
    el.value = '4.90'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.monitor-canvas [data-motion-frame]')?.complete,
  )
  for (const [w, h, name] of [
    [1440, 900, 'wide'],
    [1100, 700, 'compact'],
    [820, 640, 'narrow'],
  ]) {
    await page.setViewportSize({ width: w, height: h })
    await frame()
    if (w < 900 && !(await page.locator('.editor-side').isVisible())) {
      await page.getByTestId('editor-agent-toggle').click()
      await frame()
    }
    for (const theme of ['dark', 'light']) {
      if (theme === 'light')
        await page.getByTestId('editor-theme-toggle').click()
      await snap(name + '-' + theme)
      const box = async (selector) => await page.locator(selector).boundingBox()
      const side = await box('.editor-side'),
        timeline = await box('[data-testid="editor-timeline-region"]'),
        monitor = await box('.monitor-panel')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
      measurements.push({ w, h, theme, side, timeline, monitor, overflow })
      if (phase === 'after') {
        assert.equal(overflow, false, 'horizontal page overflow')
        assert.ok(side && timeline && monitor)
        if (w >= 900) {
          assert.ok(
            Math.abs(side.y + side.height - timeline.y - timeline.height) < 4,
            'dock should extend to bottom',
          )
          assert.ok(
            timeline.x + timeline.width <= side.x + 1,
            'timeline overlaps dock',
          )
        }
      }
      if (theme === 'light')
        await page.getByTestId('editor-theme-toggle').click()
    }
  }
  if (phase === 'after') {
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.editor-side').isVisible(), false)
    await page.setViewportSize({ width: 1440, height: 900 })
    await frame()
    const toggle = page.getByTestId('editor-agent-toggle')
    if (!(await page.locator('.editor-side').isVisible())) await toggle.click()
    await toggle.click()
    assert.equal(await page.locator('.editor-side').isVisible(), false)
    await toggle.click()
    await page.getByRole('button', { name: '添加附件与能力' }).click()
    const sw = page.getByTestId('motion-enabled')
    await sw.focus()
    const before = await sw.getAttribute('aria-checked')
    await page.keyboard.press('Space')
    await page.waitForFunction(
      (old) =>
        document
          .querySelector('[data-testid="motion-enabled"]')
          .getAttribute('aria-checked') !== old,
      before,
    )
    assert.equal(
      await page.getByRole('button', { name: '暂停', exact: true }).count(),
      0,
    )
    await sw.press('Escape')
    const sep = page.locator('.left-resizer')
    await sep.focus()
    await page.keyboard.press('ArrowRight')
    await frame()
    const width = async () =>
      Math.round((await page.locator('.left-panel').boundingBox()).width)
    const chosen = await width()
    await page.setViewportSize({ width: 1441, height: 900 })
    await frame()
    assert.equal(await width(), chosen)
  }
  await writeFile(
    join(output, 'layout.json'),
    JSON.stringify(measurements, null, 2),
  )
  console.log(phase, measurements.length, 'states')
} finally {
  await app.close()
  await rm(temp, { recursive: true, force: true })
}
