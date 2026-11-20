import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const profile = join(homedir(), 'Library/Application Support/Cutroom 试剪')
const temp = await realpath(
  await mkdtemp(join(tmpdir(), 'cutroom-spoken-e2e-')),
)
const output = resolve(process.env.CUTROOM_ACCEPTANCE_OUTPUT)
const state = join(temp, 'state')
await mkdir(output, { recursive: true })
await mkdir(state, { mode: 0o700 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const digest = (buf) => createHash('sha256').update(buf).digest('hex')
const exe = process.env.CUTROOM_ACCEPTANCE_EXECUTABLE
let app,
  page,
  recording = false
async function selectFile(path, save = false) {
  await app.evaluate(
    ({ dialog }, { path, save }) => {
      if (save)
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: path,
        })
      else
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
    },
    { path, save },
  )
}
async function launch() {
  const env = {
    ...process.env,
    CUTROOM_DATA_DIR: state,
    CUTROOM_CACHE_DIR: join(temp, 'cache'),
    VIDEO_EDIT_AGENT_DATA_DIR: state,
    EMPEROR_CONFIG_DIR: state,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VIDEO_EDIT_AGENT_LEGACY_MODEL_HOME
  app = await _electron.launch({
    cwd: desktop,
    env,
    ...(exe && { executablePath: exe }),
    args: [...(exe ? [] : ['.']), '--user-data-dir=' + join(temp, 'chromium')],
  })
  page = await app.firstWindow()
  await page.getByTestId('open-folder').waitFor({ timeout: 45_000 })
}
async function runRecord(project) {
  const precision = join(project, '.cutroom', 'precision')
  const id = await json(join(precision, 'latest.json'))
  const signed = await json(join(precision, id, 'run.json'))
  const key = Buffer.from(
    await readFile(join(state, 'precision-run.key'), 'utf8'),
    'hex',
  )
  assert.equal(
    createHmac('sha256', key).update(signed.body).digest('hex'),
    signed.signature,
  )
  return JSON.parse(signed.body)
}
async function currentState(project) {
  if (!existsSync(join(project, '.cutroom/precision/latest.json'))) return null
  return (await runRecord(project)).state
}
async function exportMovie(path) {
  await selectFile(path, true)
  await page.getByTestId('editor-export').click()
  for (let i = 0; i < 150 && !existsSync(path); i++) await sleep(1000)
  assert.ok(existsSync(path), 'manual export must produce the requested file')
  execFileSync(
    'ffmpeg',
    ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'],
    { timeout: 180_000 },
  )
  return JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  )
}
async function openProject(project) {
  await selectFile(project)
  await page.getByTestId('open-folder').click()
  await page.locator('.editor-workspace').waitFor({ timeout: 90_000 })
}
async function legacy() {
  const original = await realpath(process.env.CUTROOM_LEGACY_PROJECT)
  const signingProfile = await realpath(
    process.env.CUTROOM_LEGACY_SIGNING_PROFILE,
  )
  const sourceBinding = await json(
    join(original, '.video-edit-agent/workspace.json'),
  )
  const sessionId = sourceBinding.chatSessionId
  const project = join(temp, basename(original))
  execFileSync('cp', ['-cR', original, project])
  const manifest = sourceBinding.manifest || 'video-edit.json'
  const before = await readFile(join(original, manifest))
  const session = join(signingProfile, 'sessions', sessionId)
  assert.ok(existsSync(session))
  const clonedSession = join(state, 'sessions', sessionId)
  await mkdir(dirname(clonedSession), { recursive: true })
  execFileSync('cp', ['-cR', session, clonedSession])
  await copyFile(
    join(signingProfile, 'sessions/.harness-kernel-v1'),
    join(state, 'sessions/.harness-kernel-v1'),
  )
  // The original session belongs to this exact project, now located inside the disposable copy.
  const meta = join(clonedSession, 'meta.jsonl')
  const lines = (await readFile(meta, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => {
      const record = JSON.parse(line)
      for (const item of [record, record.session, record.patch]) {
        if (item?.project_path === original) item.project_path = project
      }
      return JSON.stringify(record)
    })
  await writeFile(meta, lines.join('\n') + '\n')
  await copyFile(
    join(signingProfile, 'precision-run.key'),
    join(state, 'precision-run.key'),
  )
  await launch()
  await openProject(project)
  const migrated = await json(join(project, '.cutroom/workspace.json'))
  const run = await runRecord(project)
  assert.equal(sessionId, migrated.chatSessionId)
  assert.equal(run.sessionId, sessionId)
  assert.equal(run.approved, true)
  assert.equal(run.state, 'delivered')
  const originalFile = join(
    original,
    '.video-edit-agent/precision',
    run.runId,
    'run.json',
  )
  assert.deepEqual(
    await readFile(join(project, '.cutroom/precision', run.runId, 'run.json')),
    await readFile(originalFile),
  )
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.monitor-canvas video')].some(
        (el) => el.readyState >= 2,
      ),
    { timeout: 60_000 },
  )
  await page.screenshot({ path: join(output, 'legacy-reopened.png') })
  await app.close()
  await launch()
  await openProject(project)
  const stream = await exportMovie(join(output, 'legacy-reopened.mp4'))
  assert.deepEqual(await readFile(join(project, manifest)), before)
  assert.deepEqual(await readFile(join(original, manifest)), before)
  const timeline = JSON.parse(before)
  return {
    projectName: basename(original),
    projectId: migrated.projectId,
    sessionId,
    runId: run.runId,
    approved: run.approved,
    state: run.state,
    timelineRevision: timeline.revision,
    clips: timeline.clips.length,
    subtitles: timeline.subtitles.length,
    signedRecordSha256: digest(await readFile(originalFile)),
    media: stream,
    layout: await json(
      join(project, '.cutroom/migrations/project-layout.v1.json'),
    ),
  }
}
async function realEdit() {
  const original = await realpath(process.env.CUTROOM_SPOKEN_SOURCE)
  const model = await realpath(process.env.CUTROOM_WHISPER_MODEL)
  const project = join(output, '口播精剪')
  await mkdir(project)
  const video = join(temp, '真实口播片段.mp4')
  execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-ss',
    '6',
    '-i',
    original,
    '-t',
    '9',
    '-vf',
    'scale=-2:540',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    video,
  ])
  const key = ['secrets/local.key', 'computer-use/secrets/local.key']
    .map((relative) => join(profile, relative))
    .find(existsSync)
  assert.ok(key)
  await mkdir(join(state, 'secrets'), { mode: 0o700 })
  await copyFile(key, join(state, 'secrets/local.key'))
  await chmod(join(state, 'secrets/local.key'), 0o600)
  await copyFile(
    join(profile, 'model_config.json'),
    join(state, 'model_config.json'),
  )
  await chmod(join(state, 'model_config.json'), 0o600)
  const config = await json(join(state, 'model_config.json'))
  const selected = config.models.find((m) => m.entryId === config.activeModelId)
  assert.ok(selected?.modelId)
  const which = (cmd) =>
    execFileSync('which', [cmd], { encoding: 'utf8' }).trim()
  await writeFile(
    join(state, 'video-analysis.json'),
    JSON.stringify({
      ffmpegPath: which('ffmpeg'),
      whisperPath: which('whisper-cli'),
      modelPath: model,
      language: 'zh',
      transcriptionProvider: 'whisper',
      autoTranscribe: false,
    }),
  )
  await launch()
  await selectFile(project)
  await page.getByTestId('new-project').click()
  await page.getByRole('button', { name: '新建剪辑', exact: true }).click()
  await page.locator('.editor-workspace').waitFor()
  await selectFile(video)
  await page.getByRole('button', { name: '导入素材', exact: true }).click()
  await page.locator('.asset-card').first().waitFor()
  await page.screencast.start({
    path: join(output, 'edit-workbench.webm'),
    size: page.viewportSize() || { width: 1280, height: 800 },
  })
  recording = true
  const field = page.getByRole('textbox', { name: '消息输入框' })
  if (!(await field.isVisible()))
    await page.getByTestId('editor-agent-toggle').click()
  await field.fill(
    '请调用自主精剪工具完整审看工程里这段约9秒的真实口播，保留原声和一段完整表达，首尾合理收紧，做一版单轨精剪。无需字幕、特效或配乐。通过底部方案卡让我确认一次，确认后继续剪辑、完整审片和交付。',
  )
  await field.press('Enter')
  const card = page
    .locator('[data-takeover="approval"], [data-takeover="plan"]')
    .first()
  await card.waitFor({ timeout: 240_000 })
  await page.screenshot({ path: join(output, 'proposal.png') })
  await card.getByRole('button', { name: /^(允许本次|批准并执行)$/ }).click()
  let last = ''
  for (let i = 0; i < 420; i++) {
    const current = await currentState(project)
    if (current !== last) {
      console.log('precision state:', current)
      last = current
    }
    if (current === 'delivered') break
    if (['paused', 'blocked', 'conflict', 'cancelled'].includes(current))
      throw new Error('精剪停止：' + (await runRecord(project)).message)
    if (await card.isVisible()) throw new Error('精剪请求再次授权')
    await sleep(1500)
  }
  const run = await runRecord(project)
  assert.equal(run.state, 'delivered')
  await page.screenshot({ path: join(output, 'delivery.png') })
  await page.screencast.stop()
  recording = false
  await app.close()
  await launch()
  await openProject(project)
  const probe = await exportMovie(join(output, '真实口播精剪.mp4'))
  return {
    model: selected.modelId,
    source: basename(original),
    selectedSourceRange: [6, 15],
    oneApproval: true,
    runId: run.runId,
    approved: run.approved,
    state: run.state,
    reviewCount: run.reviewCount,
    checkedFrames: run.review?.checkedFrames,
    media: probe,
  }
}
try {
  const result = process.env.CUTROOM_LEGACY_PROJECT
    ? await legacy()
    : await realEdit()
  await writeFile(
    join(output, 'acceptance.json'),
    JSON.stringify(result, null, 2),
  )
  console.log('Cutroom acceptance complete', output)
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (recording) await page?.screencast.stop().catch(() => {})
  await app?.close().catch(() => {})
  await rm(temp, { recursive: true, force: true })
}
