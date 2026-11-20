import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect } from '@playwright/test'
import { startFakeModel } from '../fullstack/fake-model.ts'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const input = process.argv[2]
assert.ok(input, 'Pass a Cutroom project folder to copy for the acceptance run')
const temp = await mkdtemp(join(tmpdir(), 'cutroom-interactions-'))
const state = join(temp, 'data')
const project = join(temp, basename(input))
const evidence = join(desktop, 'out-e2e/workbench-interactions')
await mkdir(state)
await mkdir(evidence, { recursive: true })
if (process.platform === 'darwin')
  execFileSync('cp', ['-cR', resolve(input), project])
else await cp(resolve(input), project, { recursive: true })
const fixture = await startFakeModel({ agentTool: 'video_project_read' })
await writeFile(
  join(state, 'model_config.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeModelId: 'local',
    models: [
      {
        entryId: 'local',
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'deepseek-chat',
        displayName: '验收模型',
        apiBase: fixture.apiBase,
        apiKey: 'local-fixture',
        contextWindowTokens: 128000,
        maxTokens: 4096,
      },
    ],
  }),
)
const env = {
  ...process.env,
  VIDEO_EDIT_AGENT_DATA_DIR: state,
  EMPEROR_CONFIG_DIR: state,
  VIDEO_EDIT_AGENT_LEGACY_MODEL_HOME: '',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  cwd: desktop,
  args: ['.', '--user-data-dir=' + join(temp, 'profile')],
  env,
})
let page,
  recording = false
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(9000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('open-folder').waitFor()
  await page.screencast.start({
    path: join(evidence, 'workbench.webm'),
    size: page.viewportSize(),
  })
  recording = true
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, project)
  await page.getByTestId('open-folder').click()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-preview-active="true"] video')
        ?.readyState >= 2,
  )
  const monitor = page.locator('.monitor-canvas')
  // Seek using the monitor's own range input before capturing, including active captions and motion.
  const scrub = page.getByRole('slider', { name: '播放位置' })
  await scrub.evaluate((el) => {
    el.value = String(Math.min(1.75, Number(el.max) / 2))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-preview-active="true"] video')
    return (
      video?.readyState >= 2 &&
      !video.seeking &&
      !document.querySelector('[data-preview-active="true"] .layer-status')
    )
  })
  const motion = monitor.locator('.motion-image').first()
  if (await motion.count()) await expect(motion.locator('img')).toBeVisible()
  await monitor.screenshot({ path: join(evidence, 'monitor.png') })
  const plus = page.getByRole('button', { name: '添加附件与能力' })
  await plus.click()
  await expect(page.getByText('目标模式', { exact: true })).toHaveCount(0)
  await page.getByText('截取当前帧', { exact: true }).click()
  const thumb = page.locator('.attach-thumb').first()
  await expect(thumb).toBeVisible()
  const name = await thumb.getAttribute('alt')
  assert.match(name, /预览帧-\d+ms\.png/)
  const files = await readdir(state, { recursive: true })
  const stored = files.find(
    (p) => p.includes('attachments/') && p.endsWith('.png'),
  )
  assert.ok(stored, 'captured PNG exists in Core attachment storage')
  await cp(join(state, stored), join(evidence, 'attached-frame.png'))
  await page.getByRole('button', { name: '移除附件' }).click()
  console.log('PASS composited preview attached via +', name)
  await page
    .locator(
      '.composer-editor [contenteditable=true], .composer-editor.ProseMirror, .ProseMirror[contenteditable=true]',
    )
    .first()
    .fill('请检查 ')
  const clip = page.locator('[data-clip-id]').first()
  const clipId = await clip.getAttribute('data-clip-id')
  await clip.click({ button: 'right' })
  await page.getByTestId('timeline-add-reference').click()
  await expect(
    page.locator('.composer-editor [data-kind=timeline]'),
  ).toHaveCount(1)
  await expect(page.locator('.composer-editor')).toContainText('请检查')
  await page.screenshot({
    path: join(evidence, 'reference.png'),
    animations: 'disabled',
  })
  console.log('PASS clip reference preserves existing draft')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const modal = page.getByTestId('settings-modal')
  await modal.getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(modal.locator('.nav-cell[aria-current=page]')).toHaveText(
    'Skills',
  )
  await modal.getByRole('button', { name: '新增', exact: true }).click()
  await page.getByRole('menuitem', { name: /粘贴 SKILL.md/ }).click()
  const paste = page.getByRole('dialog', { name: '粘贴 SKILL.md' })
  await paste
    .locator('textarea')
    .first()
    .fill(
      '---\nname: frame-review\ndescription: 检查所选片段的画面。\n---\n\n# 帧检查\n先读取指定片段的画面，再记录字幕和动作的位置。',
    )
  await paste.getByRole('button', { name: '保存到' }).click()
  await page.getByRole('menuitem', { name: /当前项目/ }).click()
  await paste.getByTestId('skill-paste-submit').click()
  await expect(paste).toHaveCount(0)
  await expect(modal.locator('textarea')).toHaveValue(/先读取指定片段的画面/)
  await page.screenshot({
    path: join(evidence, 'skill.png'),
    animations: 'disabled',
  })
  const created = await readFile(
    join(project, '.cutroom/skills/frame-review/SKILL.md'),
    'utf8',
  )
  assert.ok(created.includes('帧检查'))
  console.log('PASS project Skill added and previewed')
  await modal.getByRole('button', { name: '语音输入' }).click()
  const native = await page.evaluate(() => window.emperor.dictationStatus())
  assert.ok(native.supported && native.available, native.reason)
  await expect(modal.getByText('识别语言', { exact: true })).toBeVisible()
  await page.screenshot({
    path: join(evidence, 'voice.png'),
    animations: 'disabled',
  })
  await writeFile(
    join(evidence, 'voice-status.json'),
    JSON.stringify(
      {
        available: native.available,
        engine: native.engine,
        permissions: native.permissions,
        deviceCount: native.devices.length,
        hasChinese: native.locales.some((l) => l.id.startsWith('zh')),
      },
      null,
      2,
    ),
  )
  console.log('PASS native dictation status', native.engine, native.permissions)
  await modal.getByRole('button', { name: '关闭设置' }).click()
  await plus.click()
  await page.getByText('插入 Skill', { exact: true }).click()
  await page
    .locator('.capability-picker-item')
    .filter({ hasText: 'Frame Review' })
    .click()
  await expect(page.locator('.composer-editor [data-kind=skill]')).toHaveCount(
    1,
  )
  console.log('PASS project Skill enters actual editor composer')
  await plus.click()
  await page.getByText('计划模式', { exact: true }).click()
  await expect(page.getByRole('button', { name: '退出计划' })).toBeVisible()
  await page.getByRole('button', { name: '退出计划' }).click()
  await expect(page.getByRole('button', { name: '退出计划' })).toHaveCount(0)
  console.log('PASS actual plan toggle and exit')
  const editor = page.locator('.ProseMirror[contenteditable=true]').first()
  const draft = '答完问题后继续检查下一句'
  const gate = Promise.withResolvers()
  let modelContext = ''
  fixture.enqueue(
    async (request) => {
      modelContext = JSON.stringify(request.messages)
      await gate.promise
      return {
        tools: [
          {
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  id: 'placement',
                  header: '动效位置',
                  question: '节点放在哪一侧？',
                  options: [{ label: '右侧' }, { label: '左侧' }],
                },
              ],
            },
          },
        ],
      }
    },
    () => ({ text: '已记下右侧位置。' }),
  )
  await page.getByRole('button', { name: '发送', exact: true }).click()
  try {
    await expect.poll(() => Boolean(modelContext)).toBe(true)
    await editor.fill(draft)
  } finally {
    gate.resolve()
  }
  const card = page.locator('[data-takeover="question"]')
  await expect(card).toBeVisible()
  const cardBox = await card.boundingBox()
  const dockBox = await page.locator('.agent-dock').boundingBox()
  assert.ok(
    cardBox &&
      dockBox &&
      Math.abs(dockBox.y + dockBox.height - cardBox.y - cardBox.height) < 40,
    'question sits at the bottom of the dock',
  )
  await page.screenshot({
    path: join(evidence, 'question.png'),
    animations: 'disabled',
  })
  await card.getByRole('radio', { name: /右侧/ }).click()
  await card.getByRole('button', { name: '提交' }).click()
  await expect(card).toHaveCount(0)
  await expect(editor).toHaveText(draft)
  assert.ok(
    modelContext.includes('先读取指定片段的画面') &&
      clipId &&
      modelContext.includes(clipId),
    'request contains the project Skill body and the clip context',
  )
  console.log(
    'PASS submitted Skill and timeline reference, bottom question, draft restored',
  )
} catch (error) {
  if (page) {
    console.log(
      'current view:',
      (await page.locator('body').innerText()).slice(-1700),
    )
    await page
      .screenshot({ path: join(evidence, 'failure.png') })
      .catch(() => {})
  }
  throw error
} finally {
  if (recording) await page.screencast.stop()
  await app.close()
  await fixture.close()
  await rm(temp, { recursive: true, force: true })
}
