/** Real Chromium profile round trip. Both Electron processes use a throwaway macOS home. */
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktop = fileURLToPath(new URL('../../..', import.meta.url))
const root = fs.realpathSync(
  fs.mkdtempSync(join(tmpdir(), 'cutroom-migration-')),
)
const home = join(root, 'account')
const support = join(home, 'Library', 'Application Support')
const source = join(support, 'Video Edit Agent')
const target = join(support, 'Cutroom')
const logs = join(home, 'Library', 'Logs', 'Cutroom')
const env = {
  ...process.env,
  HOME: home,
  CFFIXED_USER_HOME: home,
  CUTROOM_CACHE_DIR: join(root, 'cache'),
}
for (const name of [
  'CUTROOM_DATA_DIR',
  'VIDEO_EDIT_AGENT_DATA_DIR',
  'EMPEROR_CONFIG_DIR',
  'CUTROOM_ROOT',
  'VIDEO_EDIT_AGENT_ROOT',
  'EMPEROR_AGENT_ROOT',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_RUN_AS_NODE',
])
  delete env[name]

function write(root, name, value) {
  const file = join(root, name)
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, value, { mode: 0o600 })
}
function check(name, action) {
  action()
  console.log(
    'E2E-RESULT',
    JSON.stringify({ suite: 'migration-smoke', name, ok: true }),
  )
}
function seal(key, value, context) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`el1\0${context}`))
  const bytes = Buffer.concat([
    Buffer.from('el1'),
    iv,
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return 'el1:' + bytes.toString('base64')
}

async function seedLegacyChromium() {
  const appDir = join(root, 'legacy-app')
  write(
    appDir,
    'package.json',
    JSON.stringify({
      name: 'legacy-fixture',
      main: 'main.cjs',
      version: '0.1.0',
    }),
  )
  write(
    appDir,
    'main.cjs',
    `
    const {app, BrowserWindow, protocol} = require('electron')
    app.setName('Cutroom')
    app.setPath('userData', process.env.LEGACY_CHROMIUM)
    app.setAppLogsPath(process.env.LEGACY_LOGS)
    app.commandLine.appendSwitch('use-mock-keychain')
    protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true,secure:true,supportFetchAPI:true}}])
    let window
    app.whenReady().then(async () => {
      protocol.handle('app', () => new Response('<title>Legacy fixture</title>', {headers:{'content-type':'text/html'}}))
      window = new BrowserWindow({show:false})
      await window.loadURL('app://bundle/index.html')
    })
  `,
  )
  const profile = join(source, 'electron-user-data')
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
  const app = await _electron.launch({
    cwd: desktop,
    args: [appDir],
    env: {
      ...env,
      LEGACY_CHROMIUM: profile,
      LEGACY_LOGS: join(source, 'logs'),
    },
    timeout: 30000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForURL('app://bundle/index.html')
    await page.evaluate(() => {
      localStorage.setItem('emperor.theme', 'light')
      localStorage.setItem(
        'video-edit-agent:recent-projects',
        JSON.stringify([
          {
            projectPath: '/fixture/project',
            name: 'Cutroom migration fixture',
            sessionId: 'fixture',
            openedAt: '2026-11-01',
          },
        ]),
      )
    })
    await app.evaluate(({ session }) =>
      session.defaultSession.flushStorageData(),
    )
  } finally {
    await app.close()
  }
}

const key = randomBytes(32)
const model = {
  entryId: 'fixture-model',
  provider: 'custom',
  protocol: 'openai',
  modelId: 'migration-test',
  displayName: 'Migration test',
  apiBase: 'https://migration.invalid/v1',
  apiKey: seal(
    key,
    'fixture-model-key-ABCD',
    'model_config.json#models/fixture-model/apiKey',
  ),
  contextWindowTokens: 8192,
  maxTokens: 1024,
}
const whisper = 'media/whisper/ggml-tiny.bin'
const retained = {
  'computer-use/secrets/local.key': key,
  'model_config.json': JSON.stringify({
    schemaVersion: 2,
    activeModelId: model.entryId,
    models: [model],
  }),
  'video-analysis.json': JSON.stringify({
    transcriptionProvider: 'fun-asr',
    sealedFunAsrKey: seal(
      key,
      'fixture-transcription-key',
      'video-analysis.fun-asr.beijing.api-key',
    ),
    modelPath: join(source, whisper),
  }),
  'precision-run.key': randomBytes(32).toString('hex'),
  'memory/attachments/2026-11/fixture.bin': randomBytes(128),
  'skills/fixture/SKILL.md':
    '---\nname: fixture\ndescription: Migration verification\n---\nFixture only.',
  'tokens/tokens.jsonl': '',
  [whisper]: randomBytes(256),
}
let app
try {
  for (const [name, value] of Object.entries(retained))
    write(source, name, value)
  write(home, '.emperor/sentinel', 'unchanged')
  await seedLegacyChromium()
  app = await _electron.launch({
    args: ['.'],
    cwd: desktop,
    env,
    timeout: 30000,
  })
  const page = await app.firstWindow({ timeout: 30000 })
  await page.getByTestId('recent-project-fixture').waitFor({ timeout: 30000 })
  const state = await app.evaluate(({ app }) => ({
    app: app.getName(),
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    logs: app.getPath('logs'),
  }))
  check('formal Cutroom data and logs', () => {
    assert.equal(state.app, 'Cutroom')
    for (const location of [state.userData, state.sessionData])
      assert.equal(
        fs.realpathSync(location),
        fs.realpathSync(join(target, 'electron-user-data')),
      )
    assert.equal(fs.realpathSync(state.logs), fs.realpathSync(logs))
  })
  const current = await page.evaluate(async () => ({
    theme: document.documentElement.dataset.theme,
    model: await window.emperor.invokeCore('model.getConfig'),
    asr: await window.emperor.invokeCore('videoProject.analysisStatus'),
  }))
  check(
    'saved preferences, recent project, model and transcription credentials',
    () => {
      assert.equal(current.theme, 'light')
      assert.equal(
        current.model.models.find((entry) => entry.entryId === model.entryId)
          ?.apiKey,
        '***ABCD',
      )
      assert.equal(current.asr.funAsrConfigured, true)
      assert.equal(current.asr.modelPath, join(target, whisper))
    },
  )
  check('original files and verified destination contents', () => {
    for (const [name, value] of Object.entries(retained)) {
      assert.deepEqual(fs.readFileSync(join(source, name)), Buffer.from(value))
      if (
        ![
          'video-analysis.json',
          'model_config.json',
          'computer-use/secrets/local.key',
        ].includes(name)
      )
        assert.deepEqual(
          fs.readFileSync(join(target, name)),
          Buffer.from(value),
        )
    }
    assert.deepEqual(fs.readFileSync(join(target, 'secrets/local.key')), key)
    assert.deepEqual(fs.readdirSync(join(home, '.emperor')), ['sentinel'])
    for (const directory of [
      'browser',
      'computer-use',
      'environment',
      'git',
      'scheduler',
      'delegations',
      'processes',
    ])
      assert.equal(fs.existsSync(join(target, directory)), false, directory)
  })
  await app.close()
  app = null
  const trial = join(root, 'trial')
  app = await _electron.launch({
    args: ['.'],
    cwd: desktop,
    env: {
      ...env,
      CUTROOM_DATA_DIR: trial,
      VIDEO_EDIT_AGENT_DATA_DIR: join(root, 'alias-decoy'),
    },
    timeout: 30000,
  })
  const isolated = await app.firstWindow({ timeout: 30000 })
  await isolated.waitForURL('app://bundle/index.html')
  const dirs = await app.evaluate(({ app }) => ({
    data: app.getPath('userData'),
    logs: app.getPath('logs'),
  }))
  const pref = await isolated.evaluate(() =>
    localStorage.getItem('emperor.theme'),
  )
  check(
    'explicit trial stays isolated and takes precedence over the old alias',
    () => {
      assert.equal(
        fs.realpathSync(dirs.data),
        fs.realpathSync(join(trial, 'electron-user-data')),
      )
      assert.equal(
        fs.realpathSync(dirs.logs),
        fs.realpathSync(join(trial, 'logs')),
      )
      assert.equal(fs.existsSync(join(root, 'alias-decoy')), false)
      assert.equal(fs.existsSync(join(trial, 'precision-run.key')), false)
      assert.equal(pref, null)
    },
  )
} catch (error) {
  console.error(
    'E2E-RESULT',
    JSON.stringify({
      suite: 'migration-smoke',
      name: 'runner',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  console.log('E2E-DONE')
}
