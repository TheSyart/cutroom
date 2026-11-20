/**
 * Real editing-workspace acceptance in Electron: native-picker automation,
 * local media grants, real Core/IPC persistence and a scripted local model.
 * No paid model, user profile, or source media outside the temporary fixture
 * directories is used.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright-core'
import {
  lastToolResult,
  startFakeModel,
  type ChatRequest,
  type FakeModel,
} from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = resolve(
  process.env.CUTROOM_ACCEPTANCE_OUTPUT || join(desktop, 'out-e2e', 'editing'),
)
const SUITE = 'editing'
interface Result {
  suite: string
  name: string
  ok: boolean
  ms: number
  detail?: unknown
  error?: string
}
interface Clip {
  id: string
  trackId: string
  assetId: string
  timelineStart: number
  sourceIn: number
  sourceOut: number
  speed: number
  volume: number
  muted: boolean
  transform: { scale: number; x: number; y: number }
}
interface Project {
  name: string
  revision: number
  tracks: Array<{ id: string; kind: 'video'; name: string; index: number }>
  subtitles: Array<{ id: string; start: number; end: number; text: string }>
  assets: Array<{
    id: string
    kind: 'video' | 'image'
    path: string
    displayName: string
    duration: number | null
    width: number | null
    height: number | null
  }>
  clips: Clip[]
  canvas: { fit: 'contain' | 'cover'; background: string }
}
const results: Result[] = []
let page: Page

function report(result: Result): void {
  results.push(result)
  process.stdout.write(`E2E-RESULT ${JSON.stringify(result)}\n`)
}
class Abort extends Error {}
async function check<T>(name: string, body: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    const detail = await body()
    report({ suite: SUITE, name, ok: true, ms: Date.now() - started, detail })
    return detail
  } catch (error) {
    report({
      suite: SUITE,
      name,
      ok: false,
      ms: Date.now() - started,
      error:
        error instanceof Error
          ? (error.stack ?? error.message).split('\n').slice(0, 10).join(' ')
          : String(error),
    })
    await page
      ?.screenshot({
        path: join(shots, `fail-${name.replace(/[^\w-]+/g, '_')}.png`),
      })
      .catch(() => undefined)
    throw new Abort(name)
  }
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  }
  throw new Error(
    `timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`,
  )
}
function commandAvailable(executable: string): boolean {
  return spawnSync(executable, ['-version'], { stdio: 'ignore' }).status === 0
}

function runMediaCommand(executable: string, args: string[]): Buffer {
  const result = spawnSync(executable, args, { timeout: 30_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`)
  return result.stdout
}

function prepareHome(
  home: string,
  model: FakeModel,
  realExport: boolean,
): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-editing',
      models: [
        {
          entryId: 'fake-editing',
          provider: 'deepseek',
          protocol: 'openai',
          modelId: 'deepseek-chat',
          displayName: 'DeepSeek Fake',
          apiBase: model.apiBase,
          apiKey: 'sk-fake',
          contextWindowTokens: 128_000,
          maxTokens: 4096,
          reasoningEffort: null,
          capabilityOverrides: { vision: true },
        },
      ],
    }),
    { mode: 0o600 },
  )
  const frame = join(home, 'fake-frame.jpg')
  writeFileSync(
    frame,
    Buffer.from(
      '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Lf//Z',
      'base64',
    ),
  )
  const ffmpeg = join(home, 'fake-ffmpeg.sh')
  writeFileSync(
    ffmpeg,
    `#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
case " $* " in
  *" s16le "*) head -c 16000 /dev/zero; exit 0 ;;
  *" image2pipe "*) cat "$DIR/fake-frame.jpg"; exit 0 ;;
  *" pcm_s16le "*) : > "\${@: -1}"; exit 0 ;;
esac
${realExport ? 'exec ffmpeg "$@"' : 'echo "Real FFmpeg is unavailable for this fixture" >&2; exit 1'}
`,
    { mode: 0o755 },
  )
  const whisper = join(home, 'fake-whisper.sh')
  writeFileSync(
    whisper,
    `#!/bin/bash
set -e
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-of" ]; then out="$arg"; fi
  prev="$arg"
done
cat > "$out.json" <<'JSON'
{"transcription":[{"offsets":{"from":0,"to":1500},"text":"第一句测试字幕"},{"offsets":{"from":1500,"to":3000},"text":"第二句测试字幕"}]}
JSON
echo "progress = 100%" >&2
`,
    { mode: 0o755 },
  )
  writeFileSync(join(home, 'ggml-test.bin'), 'fake-model')
  writeFileSync(
    join(home, 'video-analysis.json'),
    JSON.stringify({
      ffmpegPath: ffmpeg,
      whisperPath: whisper,
      modelPath: join(home, 'ggml-test.bin'),
      language: 'zh',
    }),
    { mode: 0o600 },
  )
}
async function launch(home: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.CUTROOM_DATA_DIR = home
  env.CUTROOM_CACHE_DIR = join(home, 'caches')
  env.VIDEO_EDIT_AGENT_DATA_DIR = home
  env.EMPEROR_CONFIG_DIR = home
  const app = await _electron.launch({
    ...(process.env.CUTROOM_ACCEPTANCE_EXECUTABLE
      ? { executablePath: process.env.CUTROOM_ACCEPTANCE_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.CUTROOM_ACCEPTANCE_EXECUTABLE ? [] : ['.']),
      `--user-data-dir=${join(home, 'electron-profile')}`,
    ],
    cwd: desktop,
    env,
    timeout: 60_000,
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.app-frame').waitFor({ timeout: 60_000 })
  return app
}
async function nativeSelection(
  app: ElectronApplication,
  paths: string[],
): Promise<void> {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: selected,
    })) as typeof dialog.showOpenDialog
  }, paths)
}
async function nativeSaveSelection(
  app: ElectronApplication,
  filePath?: string,
): Promise<() => Promise<number>> {
  await app.evaluate(({ dialog }, path) => {
    const save = Object.assign(
      async () => {
        save.calls += 1
        return { canceled: path === undefined, filePath: path }
      },
      { calls: 0 },
    )
    dialog.showSaveDialog = save as typeof dialog.showSaveDialog
  }, filePath)
  return () =>
    app.evaluate(
      ({ dialog }) =>
        (
          dialog.showSaveDialog as typeof dialog.showSaveDialog & {
            calls: number
          }
        ).calls,
    )
}
async function setInput(
  selector: string,
  value: string | number,
  event = 'change',
): Promise<void> {
  await page.locator(selector).evaluate(
    (element, input) => {
      const field = element as HTMLInputElement
      field.value = String(input.value)
      field.dispatchEvent(new Event(input.event, { bubbles: true }))
    },
    { value, event },
  )
}
function readProject(workspace: string): Project {
  const file = existsSync(join(workspace, 'timeline.json'))
    ? 'timeline.json'
    : 'video-edit.json'
  return JSON.parse(readFileSync(join(workspace, file), 'utf8')) as Project
}
function workspaceSession(workspace: string): string {
  const metadata = JSON.parse(
    readFileSync(join(workspace, '.cutroom', 'workspace.json'), 'utf8'),
  ) as { chatSessionId?: string }
  return metadata.chatSessionId ?? ''
}
async function showAgent(): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Cutroom Agent', exact: true })
  if (!(await tab.isVisible()))
    await page.getByTestId('editor-agent-toggle').click()
  else if ((await tab.getAttribute('aria-selected')) !== 'true')
    await tab.click()
}
async function sendAgentPrompt(text: string): Promise<void> {
  await showAgent()
  await page.getByRole('textbox', { name: '消息输入框' }).fill(text)
  const send = page
    .getByTestId('editor-agent-composer')
    .getByRole('button', { name: '发送', exact: true })
  await send.click()
}
function toolStep(
  name: string,
  args: Record<string, unknown>,
): () => { tools: Array<{ name: string; args: Record<string, unknown> }> } {
  return () => ({ tools: [{ name, args }] })
}
function textStep(text: string): () => { text: string } {
  return () => ({ text })
}
async function citeTimelineTarget(
  target: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  await target.click({ button: 'right', position })
  await page
    .getByRole('menu', { name: '时间线操作' })
    .getByRole('menuitem', { name: '添加到对话', exact: true })
    .click()
}

async function verifyTimelineReferences(
  workspace: string,
  model: FakeModel,
): Promise<void> {
  const before = readProject(workspace)
  const [first, target] = before.clips
  const cue = before.subtitles[0]
  assert.ok(
    first && target && cue,
    'timeline fixture needs two clips and a subtitle',
  )
  const served = model.served.length
  await showAgent()
  const input = page.getByRole('textbox', { name: '消息输入框' })
  await input.fill('请检查这几处')
  await page.locator(`[data-clip-id="${first.id}"]`).click()
  await page.getByRole('tab', { name: '参数', exact: true }).click()
  assert.equal(await input.isVisible(), false)
  await citeTimelineTarget(page.locator(`[data-clip-id="${target.id}"]`))
  const chips = input.locator('button[data-kind=timeline]')
  const clipChip = chips.filter({ has: page.locator('.poster') }).first()
  await clipChip.waitFor()
  assert.equal(
    await page.locator(`[data-clip-id="${first.id}"].selected`).count(),
    1,
  )
  const clipAsset = before.assets.find((asset) => asset.id === target.assetId)!
  assert.ok(
    (await clipChip.innerText()).includes(clipAsset.displayName.slice(0, 16)),
  )
  await until(
    () =>
      clipChip
        .locator('img')
        .evaluateAll((images) =>
          images.some((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    'clip source frame decoded',
  )
  await citeTimelineTarget(page.locator(`[data-subtitle-id="${cue.id}"]`))
  assert.ok(
    (await input.locator('[data-target=subtitle]').innerText()).includes(
      cue.text.slice(0, 20),
    ),
  )
  await citeTimelineTarget(page.locator('[data-timeline-track]').first())
  await input.locator('[data-target=track]').waitFor()
  const ruler = page.locator('.timeline-ruler')
  const point = { x: 100, y: 14 }
  await page.locator('.timeline-scroll').evaluate((node) => {
    node.scrollLeft = 0
  })
  await citeTimelineTarget(ruler, point)
  await input.locator('[data-target=point]').waitFor()
  await ruler.click({ position: { x: 12, y: 14 } })
  await ruler.click({ position: point, modifiers: ['Shift'] })
  await citeTimelineTarget(ruler, point)
  await input.locator('[data-target=range]').waitFor()
  assert.equal(await chips.count(), 5)
  assert.ok((await input.innerText()).startsWith('请检查这几处'))
  assert.equal(model.served.length, served)
  await page.screenshot({ path: join(shots, 'timeline-references.png') })
  model.enqueue((request) => {
    const prompt = JSON.stringify(request.messages)
    assert.ok(prompt.includes('时间线引用快照'))
    assert.ok(
      prompt.includes(target.id) &&
        prompt.includes(cue.id) &&
        prompt.includes('sourceIn'),
    )
    return { text: '已收到五处时间线引用。' }
  })
  await page
    .getByTestId('editor-agent-composer')
    .getByRole('button', { name: '发送', exact: true })
    .click()
  const row = page
    .locator('.user-row')
    .filter({ hasText: '请检查这几处' })
    .last()
  await row.locator('[data-target=clip]').click()
  await page.locator(`[data-clip-id="${target.id}"].selected`).waitFor()
  await row.locator('[data-target=subtitle]').click()
  await page.locator(`[data-subtitle-id="${cue.id}"].selected`).waitFor()
  await row.locator('[data-target=range]').click()
  await page.locator('[data-reference-range]').waitFor()
  await until(
    () => model.served.length > served,
    'structured snapshots reached local model',
  )
  assert.equal(model.errors.length, 0)
  await row.hover()
  await row.getByRole('button', { name: '编辑后重新发送' }).click()
  await until(
    async () => (await chips.count()) === 5,
    'edit restores five inline references',
  )
  await page.screenshot({ path: join(shots, 'timeline-reference-history.png') })
  assert.deepEqual(readProject(workspace), before)
}
function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
async function buttonContrast(button: Locator) {
  return button.evaluate((element) => {
    type Rgba = [number, number, number, number]
    const parse = (color: string): Rgba => {
      const values = color.match(/[\d.]+/g)?.map(Number) ?? []
      return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1]
    }
    const over = (source: Rgba, destination: Rgba): Rgba => {
      const alpha = source[3] + destination[3] * (1 - source[3])
      if (!alpha) return [0, 0, 0, 0]
      const channel = (index: number) =>
        (source[index] * source[3] +
          destination[index] * destination[3] * (1 - source[3])) /
        alpha
      return [channel(0), channel(1), channel(2), alpha]
    }
    let background: Rgba = [0, 0, 0, 0]
    let current: Element | null = element
    while (current && background[3] < 1) {
      background = over(
        background,
        parse(getComputedStyle(current).backgroundColor),
      )
      current = current.parentElement
    }
    background = over(background, [255, 255, 255, 1])
    const foreground = over(parse(getComputedStyle(element).color), background)
    const luminance = (color: Rgba): number => {
      const [r, g, b] = color.slice(0, 3).map((channel) => {
        const value = channel / 255
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const first = luminance(foreground)
    const second = luminance(background)
    const rgb = (color: Rgba) =>
      `rgb(${color.slice(0, 3).map(Math.round).join(', ')})`
    return {
      ratio:
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      foreground: rgb(foreground),
      background: rgb(background),
    }
  })
}
async function addAsset(name: string): Promise<void> {
  await page.locator('.asset-card').filter({ hasText: name }).click()
  await page.getByRole('button', { name: '添加到时间线' }).click()
}

function lastResult<T>(request: ChatRequest): T {
  const messages = request.messages.slice()
  // OpenAI-compatible requests can carry tool images in a separate user message.
  if (receivedJpegs({ messages: messages.slice(-1) }).length > 0) messages.pop()
  const result = lastToolResult({ ...request, messages })
  assert.ok(result, 'missing JSON tool result')
  return JSON.parse(result) as T
}

function receivedJpegs(request: ChatRequest): Buffer[] {
  return request.messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content.flatMap((part) => {
          const url = part?.image_url?.url
          return typeof url === 'string' &&
            url.startsWith('data:image/jpeg;base64,')
            ? [
                Buffer.from(
                  url.slice('data:image/jpeg;base64,'.length),
                  'base64',
                ),
              ]
            : []
        })
      : [],
  )
}

async function precisionScenario(
  app: ElectronApplication,
  model: FakeModel,
  workspace: string,
  source: string,
  originalHash: string,
): Promise<void> {
  const planMode = process.env.VIDEO_EDIT_E2E_PRECISION_PLAN === '1'
  await check(
    (planMode ? 'manual plan: ' : '') +
      'one approval produces an editable, reviewed precision cut and manual MP4',
    async () => {
      await nativeSelection(app, [workspace])
      await page.getByTestId('new-project').click()
      await page.getByRole('button', { name: '新建剪辑', exact: true }).click()
      await page.locator('.editor-workspace').waitFor()
      await nativeSelection(app, [source])
      await page.getByRole('button', { name: '导入素材', exact: true }).click()
      await until(
        () => (readProject(workspace).assets[0]?.duration ?? 0) >= 1.9,
        'source metadata',
      )
      const base = readProject(workspace)
      const asset = base.assets[0]!
      const trackId = base.tracks[0]!.id
      const destination = join(workspace, 'precision-user-export.mp4')
      const saveCalls = await nativeSaveSelection(app, destination)
      const cutName = '正片开场'
      const delivery = '已交付一段带字幕的精剪稿。[00:00.84](#ve-cut-0.84)'
      const reviewSeconds: number[] = []
      const captionSeconds: number[] = []
      const frameHashes = new Set<string>()
      let finishDraftInspection!: () => void
      const waitForDraftInspection = new Promise<void>((resolve) => {
        finishDraftInspection = resolve
      })

      await page.evaluate(() => {
        const selector = '[data-takeover="approval"], [data-takeover="plan"]'
        const receipt = { count: 0 }
        Object.assign(window, { precisionApprovalReceipt: receipt })
        new MutationObserver((changes) => {
          for (const change of changes) {
            for (const node of change.addedNodes) {
              if (!(node instanceof Element)) continue
              receipt.count +=
                Number(node.matches(selector)) +
                node.querySelectorAll(selector).length
            }
          }
        }).observe(document.body, { childList: true, subtree: true })
      })

      model.enqueue(
        (request) => {
          const names = request.tools?.map((tool) => tool.function.name) ?? []
          assert.ok(names.includes('video_start_precision_edit'))
          assert.ok(!names.includes('video_stage_edit'))
          return toolStep('video_start_precision_edit', {})()
        },
        (request) => {
          const names = new Set(
            request.tools?.map((tool) => tool.function.name),
          )
          for (const name of [
            'video_analyze_workspace',
            'video_read_video',
            'video_read_evidence',
            'video_propose_treatment',
            'video_preview_edit',
            'video_stage_edit',
            'video_review_draft',
            'video_finish_draft',
          ])
            assert.ok(names.has(name), `missing precision tool ${name}`)
          return toolStep('video_analyze_workspace', {})()
        },
        (request) => {
          const context = lastResult<{
            assets: Array<{ id: string }>
            totalClips: number
          }>(request)
          assert.equal(context.assets[0]?.id, asset.id)
          assert.equal(context.totalClips, 0)
          return toolStep('video_analyze_workspace', {
            assetId: asset.id,
            start: 0,
            end: 1.9,
          })()
        },
        (request) => {
          const evidence = lastResult<{ events: Array<{ kind: string }> }>(
            request,
          )
          assert.ok(
            evidence.events.length > 0,
            'expected timed source analysis',
          )
          return toolStep('video_read_video', {
            from: 'source',
            assetId: asset.id,
          })()
        },
        (request) => {
          const sheet = lastResult<{
            sheets: Array<{ times: number[] }>
            nextStart: number | null
            coverage: { unread: unknown[] }
          }>(request)
          assert.equal(sheet.nextStart, null)
          assert.equal(sheet.coverage.unread.length, 0)
          assert.ok(sheet.sheets[0]!.times.length > 2)
          assert.ok(
            receivedJpegs(request).length >= 1,
            'source sheet reached model',
          )
          return toolStep('video_read_evidence', {
            from: 'source',
            assetId: asset.id,
            times: [0.3],
          })()
        },
        (request) => {
          const images = receivedJpegs(request)
          assert.ok(images.length >= 1, 'source JPEG did not reach model')
          for (const jpeg of images) {
            assert.equal(jpeg.readUInt16BE(), 0xffd8)
            frameHashes.add(createHash('sha256').update(jpeg).digest('hex'))
          }
          const { sourceEvidence } = lastResult<{
            sourceEvidence: Array<{ id: string; kind: string }>
          }>(request)
          assert.ok(sourceEvidence.length >= 1)
          return toolStep('video_record_source_notes', {
            notes: [
              {
                assetId: asset.id,
                start: 0.2,
                end: 0.6,
                provenance: 'observed',
                observation: '画面在开场保持稳定。',
                evidence: sourceEvidence,
              },
            ],
          })()
        },
        (request) => {
          assert.equal(
            lastResult<{ file: string }>(request).file,
            'source-notes.json',
          )
          return toolStep('video_propose_treatment', {
            summary: '保留开场动作和原声，剪掉头尾并加一条字幕。',
            mustKeep: ['原声'],
            pacing: '开场直接进入内容。',
            picture: '沿用原画面。',
          })()
        },
        (request) => {
          assert.equal(
            lastResult<{ approved: boolean }>(request).approved,
            true,
          )
          assert.ok(existsSync(join(workspace, 'timeline.json')))
          assert.match(
            readFileSync(join(workspace, 'editing-brief.md'), 'utf8'),
            /保留开场动作和原声/,
          )
          assert.deepEqual(
            readProject(workspace),
            base,
            'approved draft must not change the live project',
          )
          return toolStep('video_preview_edit', {
            generation: 0,
            commands: [
              {
                type: 'addClip',
                assetId: asset.id,
                trackId,
                sourceIn: 0.2,
                sourceOut: 1.8,
                timelineStart: 0,
              },
            ],
          })()
        },
        (request) => {
          const rehearsal = lastResult<{
            previousDuration: number
            duration: number
            generation: number
          }>(request)
          assert.equal(rehearsal.previousDuration, 0)
          assert.ok(Math.abs(rehearsal.duration - 1.6) < 0.05)
          assert.equal(rehearsal.generation, 0)
          assert.deepEqual(readProject(workspace), base)
          return toolStep('video_stage_edit', {
            phase: 'rough_cut',
            generation: rehearsal.generation,
            commands: [
              {
                type: 'addClip',
                assetId: asset.id,
                trackId,
                sourceIn: 0.2,
                sourceOut: 1.8,
                timelineStart: 0,
              },
            ],
          })()
        },
        (request) => {
          const staged = lastResult<{
            clipCount: number
            selected: string[]
            generation: number
          }>(request)
          assert.equal(staged.clipCount, 1)
          assert.ok(staged.selected[0])
          assert.deepEqual(
            readProject(workspace),
            base,
            'rough cut leaked into the live project',
          )
          return toolStep('video_stage_edit', {
            phase: 'fine_cut',
            generation: staged.generation,
            commands: [
              {
                type: 'updateClip',
                clipId: staged.selected[0],
                volume: 0.8,
                fadeOut: 0.15,
              },
              {
                type: 'addSubtitle',
                start: 0.2,
                end: 1.2,
                text: 'Precision acceptance',
              },
            ],
          })()
        },
        async (request) => {
          assert.equal(
            lastResult<{ subtitleCount: number }>(request).subtitleCount,
            1,
          )
          assert.deepEqual(
            readProject(workspace),
            base,
            'fine cut leaked into the live project',
          )
          await waitForDraftInspection
          return toolStep('video_review_draft', {})()
        },
        (request) => {
          const review = lastResult<{
            targets: number[]
            duration: number
            attempts: number
            issues: Array<{ severity: string }>
            captions: { total: number; checked: number; targets: number[] }
          }>(request)
          assert.equal(review.attempts, 1)
          assert.ok(Math.abs(review.duration - 1.6) < 0.05)
          assert.ok(review.targets.length > 0 && review.targets.length <= 6)
          assert.ok(!review.issues.some((issue) => issue.severity === 'error'))
          assert.equal(review.captions.total, 1)
          assert.equal(review.captions.checked, 1)
          captionSeconds.push(...review.captions.targets)
          reviewSeconds.push(...new Set([...review.targets, ...captionSeconds]))
          return toolStep('video_read_evidence', {
            from: 'draft',
            times: reviewSeconds,
          })()
        },
        (request) => {
          const result = lastResult<{
            timebase: string
            framesInOrder: number[]
          }>(request)
          assert.equal(result.timebase, 'timeline_seconds')
          assert.deepEqual(result.framesInOrder, reviewSeconds)
          const draftImages = receivedJpegs(request).filter(
            (jpeg) =>
              !frameHashes.has(createHash('sha256').update(jpeg).digest('hex')),
          )
          assert.ok(
            draftImages.length >= reviewSeconds.length,
            'draft JPEGs did not reach model',
          )
          assert.deepEqual(
            readProject(workspace),
            base,
            'review changed the live project before delivery',
          )
          return toolStep('video_read_video', { from: 'draft' })()
        },
        (request) => {
          const sheet = lastResult<{
            nextStart: number | null
            coverage: { unread: unknown[] }
            timebase: string
          }>(request)
          assert.equal(sheet.nextStart, null)
          assert.equal(sheet.timebase, 'timeline_seconds')
          assert.deepEqual(sheet.coverage.unread, [])
          return toolStep('video_finish_draft', {
            summary: delivery,
            bookmarks: [{ label: cutName, time: 0.2 }],
            checkedTimes: reviewSeconds,
            captionChecks: captionSeconds.map((time) => ({
              time,
              result: 'clear',
            })),
          })()
        },
        (request) => {
          assert.equal(
            lastResult<{ state: string }>(request).state,
            'delivered',
          )
          return { text: delivery }
        },
      )
      if (planMode) {
        await showAgent()
        await page.getByRole('button', { name: '添加附件与能力' }).click()
        await page.getByRole('menuitem', { name: /计划模式/ }).click()
        await page.getByRole('button', { name: '退出计划' }).waitFor()
      }
      await sendAgentPrompt(
        '保留测试片的开场动作和原声，精剪为约 1.6 秒，加入一条字幕。',
      )
      const reviewCard = page
        .getByTestId('editor-agent-composer')
        .locator(
          planMode ? '[data-takeover="plan"]' : '[data-takeover="approval"]',
        )
      await reviewCard.waitFor({ timeout: 20_000 })
      assert.equal(
        await page
          .locator(
            '[data-testid="editor-agent-composer"] .composer-editor-input',
          )
          .innerText(),
        '',
      )
      assert.match((await reviewCard.textContent()) ?? '', /保留开场动作和原声/)
      assert.deepEqual(readProject(workspace), base)
      await reviewCard
        .getByRole('button', {
          name: planMode ? '批准并执行' : '允许本次',
          exact: true,
        })
        .click()

      const draftTab = page.getByTestId('editor-draft-view')
      const liveTab = page.getByTestId('editor-live-view')
      const timeline = page.getByRole('region', { name: '剪辑时间线' })
      const monitor = page.getByRole('region', { name: '节目预览' })
      try {
        await until(
          async () => {
            if (model.errors[0]) throw model.errors[0]
            return timeline
              .locator('[data-subtitle-id][data-agent-change]')
              .isVisible()
          },
          'live fine-cut draft with a changed subtitle',
          45_000,
        )
        assert.equal(await draftTab.getAttribute('aria-pressed'), 'true')
        assert.equal(await timeline.getAttribute('data-readonly'), 'true')
        const clip = timeline.locator('[data-clip-id][data-agent-change]')
        assert.equal(await clip.count(), 1)
        assert.equal(await clip.getAttribute('draggable'), 'false')
        assert.equal(
          await timeline
            .getByRole('button', { name: '拆分', exact: true })
            .isDisabled(),
          true,
        )
        assert.equal(await page.getByTestId('editor-export').isDisabled(), true)
        assert.equal(await page.getByTestId('asset-import').isDisabled(), true)
        await page.getByTestId('editor-draft-change').click()
        await monitor.locator('video').waitFor()
        await citeTimelineTarget(clip)
        const draftChip = page
          .getByRole('textbox', { name: '消息输入框' })
          .locator('button[data-target=clip]')
          .last()
        await draftChip.waitFor()
        assert.match(
          (await draftChip.getAttribute('title')) ?? '',
          /Agent 草稿 g2/,
        )
        await clip.click()
        await page.keyboard.press('Delete')
        assert.equal(await clip.count(), 1)
        await page
          .getByTestId('editor-draft-coverage')
          .locator('summary')
          .click()
        await page
          .getByText(asset.displayName, { exact: true })
          .first()
          .waitFor()
        await page.screenshot({ path: join(shots, 'precision-live-draft.png') })
        await page
          .getByTestId('editor-draft-coverage')
          .locator('summary')
          .click()
        await monitor.getByRole('button', { name: '播放', exact: true }).click()
        await until(
          () =>
            monitor
              .locator('video')
              .evaluate((video: HTMLVideoElement) => video.currentTime > 0.25),
          'draft preview advances through source media',
        )
        await liveTab.click()
        assert.equal(await liveTab.getAttribute('aria-pressed'), 'true')
        assert.equal(await timeline.locator('[data-clip-id]').count(), 0)
        assert.equal(
          await timeline.getByRole('button', { name: '画面轨' }).isEnabled(),
          true,
        )
        await draftTab.click()
        assert.equal(await timeline.locator('[data-clip-id]').count(), 1)
        assert.equal(await timeline.locator('[data-subtitle-id]').count(), 1)
        assert.deepEqual(readProject(workspace), base)
      } finally {
        finishDraftInspection()
      }

      const task = page.getByRole('region', { name: '精剪任务' })
      await until(
        async () => {
          if (model.errors[0]) throw model.errors[0]
          return task.getByText('精剪已交付', { exact: true }).isVisible()
        },
        'reviewed delivery',
        45_000,
      )
      assert.deepEqual(model.errors, [])
      assert.equal(model.pending, 0)
      const committed = readProject(workspace)
      assert.equal(committed.revision, base.revision + 1)
      assert.equal(committed.clips[0]?.sourceIn, 0.2)
      assert.equal(committed.clips[0]?.sourceOut, 1.8)
      assert.equal(committed.clips[0]?.volume, 0.8)
      assert.equal(committed.subtitles[0]?.text, 'Precision acceptance')
      await draftTab.waitFor({ state: 'hidden' })
      assert.equal(await timeline.locator('[data-clip-id]').count(), 1)
      assert.equal(await timeline.locator('[data-subtitle-id]').count(), 1)
      assert.equal(await page.getByTestId('editor-export').isEnabled(), true)
      assert.equal(hash(source), originalHash)
      assert.equal(hash(join(workspace, asset.path)), originalHash)
      const approvals = await page.evaluate(
        () =>
          (window as unknown as { precisionApprovalReceipt: { count: number } })
            .precisionApprovalReceipt.count,
      )
      assert.equal(approvals, 1)
      assert.equal(
        await saveCalls(),
        0,
        'draft review must not open the user export picker',
      )
      assert.equal(existsSync(destination), false)
      await page.getByRole('link', { name: '00:00.84', exact: true }).click()
      const position = page.getByRole('slider', { name: '播放位置' })
      assert.ok(Math.abs(Number(await position.inputValue()) - 0.84) < 0.01)

      if (
        !(await task
          .locator('details.run-details')
          .evaluate((node: HTMLDetailsElement) => node.open))
      )
        await task.locator('summary.run-heading').click()
      await task.getByText('播放审片预览', { exact: true }).click()
      const preview = task.getByLabel('精剪审片预览')
      await until(
        async () =>
          (await preview.count()) === 1 &&
          (await preview.evaluate(
            (video: HTMLVideoElement) => video.readyState >= 2,
          )),
        'embedded FFmpeg draft preview',
      )
      await preview.evaluate((video: HTMLVideoElement) => video.play())
      await until(
        () =>
          preview.evaluate(
            (video: HTMLVideoElement) => video.currentTime > 0.1,
          ),
        'draft playback advances',
      )
      await page.screenshot({ path: join(shots, 'precision-delivered.png') })

      const exportButton = page.getByTestId('editor-export')
      await exportButton.click()
      await page
        .getByText('MP4 已导出', { exact: true })
        .waitFor({ timeout: 45_000 })
      assert.equal(await saveCalls(), 1)
      assert.equal(readProject(workspace).revision, committed.revision)
      const probe = JSON.parse(
        runMediaCommand('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,codec_type,width,height,r_frame_rate:format=duration',
          '-of',
          'json',
          destination,
        ]).toString(),
      ) as {
        streams: Array<{
          codec_name: string
          codec_type: string
          width?: number
          height?: number
          r_frame_rate?: string
        }>
        format: { duration: string }
      }
      const picture = probe.streams.find(
        (stream) => stream.codec_type === 'video',
      )
      assert.equal(picture?.codec_name, 'h264')
      assert.equal(picture.width, 1920)
      assert.equal(picture.height, 1080)
      assert.equal(picture.r_frame_rate, '30/1')
      assert.equal(
        probe.streams.find((stream) => stream.codec_type === 'audio')
          ?.codec_name,
        'aac',
      )
      assert.ok(Math.abs(Number(probe.format.duration) - 1.6) < 0.05)
      runMediaCommand('ffmpeg', [
        '-v',
        'error',
        '-xerror',
        '-i',
        destination,
        '-map',
        '0:v',
        '-map',
        '0:a',
        '-f',
        'null',
        '-',
      ])
      return {
        approvals,
        revision: committed.revision,
        reviewSeconds,
        duration: Number(probe.format.duration),
        resolution: '1920x1080',
        fps: 30,
      }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const precisionOnly = process.env.VIDEO_EDIT_E2E_PRECISION_ONLY === '1'
  const referenceProject = process.env.VIDEO_EDIT_E2E_REFERENCE_PROJECT
  const model = await startFakeModel({
    agentTool: precisionOnly
      ? ['video_start_precision_edit', 'video_analyze_workspace']
      : ['read', 'video_project_read'],
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'video-edit-e2e-home-')))
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), 'video-edit-e2e-workspace-')),
  )
  const sources = realpathSync(
    mkdtempSync(join(tmpdir(), 'video-edit-e2e-sources-')),
  )
  const emptyFolder = realpathSync(
    mkdtempSync(join(tmpdir(), 'video-edit-e2e-empty-')),
  )
  const video = join(sources, 'interview.mp4')
  const image = join(sources, 'storyboard.png')
  const originalVideo = join(
    desktop,
    'tests',
    'fixtures',
    'media',
    'clip-h264.mp4',
  )
  const realExport = commandAvailable('ffmpeg') && commandAvailable('ffprobe')
  if (realExport) {
    runMediaCommand('ffmpeg', [
      '-v',
      'error',
      '-i',
      originalVideo,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      '2',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      video,
    ])
  } else {
    copyFileSync(originalVideo, video)
  }
  copyFileSync(
    join(desktop, 'tests', 'fixtures', 'media', 'document-page.png'),
    image,
  )
  const originalHashes = [hash(video), hash(image)]
  prepareHome(home, model, realExport)
  let app: ElectronApplication | null = null
  let sessionId = ''
  let finalRevision = 0
  try {
    if (precisionOnly) {
      assert.ok(
        realExport,
        'precision acceptance requires real FFmpeg and FFprobe',
      )
      const configPath = join(home, 'video-analysis.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      const location = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' })
      assert.equal(location.status, 0)
      writeFileSync(
        configPath,
        JSON.stringify({ ...config, ffmpegPath: location.stdout.trim() }),
      )
    }
    app = await launch(home)
    if (referenceProject) {
      const supplied = realpathSync(referenceProject)
      await nativeSelection(app, [supplied])
      await page.getByTestId('open-folder').click()
      await page.getByRole('region', { name: '剪辑时间线' }).waitFor()
      await check(
        'right-click references from the supplied editing project',
        async () => {
          await verifyTimelineReferences(supplied, model)
          return { project: readProject(supplied).name }
        },
      )
      await app.close()
      app = await launch(home)
      await nativeSelection(app, [supplied])
      await page.getByTestId('open-folder').click()
      await page.getByRole('region', { name: '剪辑时间线' }).waitFor()
      await showAgent()
      await check(
        'saved timeline chips survive an Electron restart and can be edited',
        async () => {
          const row = page
            .locator('.user-row')
            .filter({ hasText: '请检查这几处' })
            .last()
          const subtitle = row.locator('button[data-target=subtitle]')
          await subtitle.click()
          await page
            .locator(
              `[data-subtitle-id="${readProject(supplied).subtitles[0]!.id}"].selected`,
            )
            .waitFor()
          assert.equal(
            await row.locator('button[data-kind=timeline]').count(),
            5,
          )
          await row.getByRole('button', { name: '编辑后重新发送' }).click()
          await until(
            async () =>
              (await page
                .getByRole('textbox', { name: '消息输入框' })
                .locator('button[data-kind=timeline]')
                .count()) === 5,
            'restored message references in the draft',
          )
          await page.screenshot({
            path: join(shots, 'timeline-reference-reopened.png'),
          })
        },
      )
      return
    }
    if (precisionOnly) {
      await precisionScenario(app, model, workspace, video, originalHashes[0]!)
      await check(
        'reopening the project restores the delivered precision draft and preview',
        async () => {
          const before = readProject(workspace)
          const requests = model.served.length
          await app!.close()
          app = await launch(home)
          await nativeSelection(app, [workspace])
          await page.getByTestId('open-folder').click()
          const task = page.getByRole('region', { name: '精剪任务' })
          await task.getByText('精剪已交付', { exact: true }).waitFor()
          await task.locator('summary.run-heading').click()
          await task.getByRole('button', { name: /正片开场/ }).waitFor()
          await task.getByText('播放审片预览', { exact: true }).click()
          const preview = task.getByLabel('精剪审片预览')
          await until(
            async () =>
              (await preview.count()) === 1 &&
              (await preview.evaluate(
                (video: HTMLVideoElement) => video.readyState >= 2,
              )),
            'restored rendered preview',
          )
          await preview.evaluate((video: HTMLVideoElement) => video.play())
          await until(
            () =>
              preview.evaluate(
                (video: HTMLVideoElement) => video.currentTime > 0.1,
              ),
            'reopened draft playback advances',
          )
          assert.deepEqual(readProject(workspace), before)
          assert.equal(model.served.length, requests)
          assert.equal(
            await page.locator('[data-takeover="approval"]').count(),
            0,
          )
          return { revision: before.revision, requests }
        },
      )
      return
    }
    await check(
      'default editor, explicit project choices and isolated workspace creation',
      async () => {
        await page.getByRole('main', { name: '剪辑工作区' }).waitFor()
        assert.equal(await page.locator('.session-row').count(), 0)
        assert.equal(await page.locator('.sidebar-root').count(), 0)
        assert.equal(await page.locator('.sidebar-rail').count(), 0)
        await page.getByTestId('editor-project-menu').waitFor()
        await page.getByTestId('new-project').waitFor()
        await page.getByTestId('open-folder').waitFor()

        // 打开文件夹 never initializes an empty folder.
        await nativeSelection(app!, [emptyFolder])
        await page.getByTestId('open-folder').click()
        await page.getByText('还没有剪辑工程').waitFor()
        assert.equal(existsSync(join(emptyFolder, 'timeline.json')), false)
        assert.equal(await page.locator('.session-row').count(), 0)

        await nativeSelection(app!, [workspace])
        await page.getByTestId('new-project').click()
        await page
          .getByRole('button', { name: '新建剪辑', exact: true })
          .click()
        await page.locator('.editor-workspace').waitFor()
        await page
          .getByRole('region', { name: 'Cutroom Agent', exact: true })
          .waitFor()
        await page.getByRole('textbox', { name: '消息输入框' }).waitFor()
        assert.equal(await page.getByLabel('消息输入框').count(), 1)
        assert.ok(existsSync(join(workspace, 'timeline.json')))
        sessionId = workspaceSession(workspace)
        assert.ok(sessionId)
        const history = await page.evaluate(async (id) => {
          const bridge = (
            window as unknown as {
              emperor?: {
                invokeCore: (
                  operation: string,
                  input: Record<string, unknown>,
                ) => Promise<unknown>
              }
            }
          ).emperor
          if (!bridge) return { error: 'no bridge' }
          try {
            const result = (await bridge.invokeCore('sessions.history', {
              sessionId: id,
            })) as { events?: unknown[] }
            return { events: result.events?.length ?? -1 }
          } catch (error) {
            return { error: String(error) }
          }
        }, sessionId)
        assert.equal(history.error, undefined)
        assert.ok((history.events ?? -1) >= 0)
        assert.equal(readProject(workspace).clips.length, 0)
      },
    )

    await check(
      'workbench shares the full-height right panel and places the timeline beneath the preview',
      async () => {
        const agent = (await page
          .getByRole('region', { name: 'Agent 和参数' })
          .boundingBox())!
        const upper = (await page.getByTestId('editor-upper').boundingBox())!
        const timeline = (await page
          .getByTestId('editor-timeline-region')
          .boundingBox())!
        assert.ok(agent.width >= 300)
        assert.ok(agent.x >= timeline.x + timeline.width - 2)
        assert.ok(
          Math.abs(agent.y + agent.height - (timeline.y + timeline.height)) < 3,
        )
        assert.ok(Math.abs(timeline.width - upper.width) < 2)
        const input = page.getByRole('textbox', { name: '消息输入框' })
        await input.fill('保留尚未发送的内容')
        await page.getByRole('tab', { name: '参数', exact: true }).click()
        assert.equal(await input.isVisible(), false)
        await page
          .getByRole('tab', { name: 'Cutroom Agent', exact: true })
          .click()
        await input.waitFor()
        assert.equal(await input.innerText(), '保留尚未发送的内容')
        await input.fill('')
      },
    )

    await check(
      'native multi-import copies media and reads real metadata',
      async () => {
        await nativeSelection(app!, [video, image])
        await page
          .getByRole('button', { name: '导入素材', exact: true })
          .click()
        await until(() => {
          const current = readProject(workspace)
          return (
            current.assets.length === 2 &&
            current.assets[0]?.duration === 2 &&
            current.assets.every((asset) => (asset.width ?? 0) > 0)
          )
        }, 'imported media metadata')
        const current = readProject(workspace)
        assert.deepEqual(
          current.assets.map((asset) => asset.kind),
          ['video', 'image'],
        )
        for (const [index, asset] of current.assets.entries()) {
          const copy = join(workspace, asset.path)
          assert.ok(existsSync(copy))
          assert.equal(hash(copy), originalHashes[index])
        }
        assert.equal(hash(video), originalHashes[0])
        assert.equal(hash(image), originalHashes[1])
      },
    )

    await check(
      'video and image clips play, seek, and advance across the boundary',
      async () => {
        await addAsset('interview.mp4')
        await until(
          () => readProject(workspace).clips.length === 1,
          'video clip',
        )
        await addAsset('storyboard.png')
        await until(
          () => readProject(workspace).clips.length === 2,
          'image clip',
        )
        await setInput('input[aria-label="播放位置"]', 0.5, 'input')
        await until(async () => {
          const time = await page
            .locator('.monitor-canvas video')
            .evaluate((element) => (element as HTMLVideoElement).currentTime)
          return Math.abs(time - 0.5) < 0.2
        }, 'video seek through workspace media')
        await setInput('input[aria-label="播放位置"]', 1.55, 'input')
        await page.getByRole('button', { name: '播放', exact: true }).click()
        await until(async () => {
          const playhead = await page
            .locator('input[aria-label="播放位置"]')
            .inputValue()
          return (
            Number(playhead) > 2.1 &&
            (await page.locator('.monitor-canvas img').first().isVisible())
          )
        }, 'playback across video to image')
        const hiddenVideo = page.locator('.monitor-canvas video')
        if (await hiddenVideo.count())
          assert.ok(!(await hiddenVideo.getAttribute('src'))?.endsWith('.png'))
        const pause = page.getByRole('button', { name: '暂停', exact: true })
        if (await pause.isVisible()) await pause.click()
        await setInput('input[aria-label="播放位置"]', 0.5, 'input')
        await until(async () => {
          const videoElement = page.locator('.monitor-canvas video')
          return (
            (await videoElement.isVisible()) &&
            (await videoElement.evaluate(
              (element) => (element as HTMLVideoElement).readyState,
            )) >= 1
          )
        }, 'video reload after image playback')
        assert.equal(await page.locator('.media-error').count(), 0)
        for (const name of ['导入素材', '添加到时间线']) {
          const contrast = await buttonContrast(
            page.getByRole('button', { name, exact: true }),
          )
          assert.ok(
            contrast.ratio >= 4.5,
            `${name} contrast: ${contrast.foreground} on ${contrast.background}`,
          )
        }
        await page.screenshot({ path: join(shots, 'workspace-1440-dark.png') })
      },
    )

    await check(
      'zoomed scrolled ruler, paused frame seek and pointer trim use lane coordinates',
      async () => {
        const zoom = page.getByRole('button', { name: '放大时间线' })
        for (let i = 0; i < 8; i++) await zoom.click()
        const scroll = page.locator('.timeline-scroll')
        const offset = await scroll.evaluate((el) => {
          el.scrollLeft = 80
          return el.scrollLeft
        })
        assert.ok(offset > 0)
        const ruler = (await page.locator('.timeline-ruler').boundingBox())!
        const x = Math.round(ruler.x + 1.25 * 240)
        await page.mouse.click(x, ruler.y + 12)
        const scrubber = page.locator('input[aria-label="播放位置"]')
        await until(
          async () =>
            Math.abs(Number(await scrubber.inputValue()) - 1.25) < 0.01,
          'zoomed ruler seek',
        )
        const playhead = (await page.locator('.playhead').boundingBox())!
        assert.ok(
          Math.abs(playhead.x - x) <= 2,
          `head ${playhead.x}, ruler ${x}`,
        )
        const lane = (await page
          .locator('[data-track-kind="video"] .lane')
          .boundingBox())!
        assert.ok(
          playhead.y + playhead.height >= lane.y + lane.height,
          `playhead ends at ${playhead.y + playhead.height}, above the lane bottom at ${lane.y + lane.height}`,
        )
        for (const time of [1.27, 1.28]) {
          await setInput('input[aria-label="播放位置"]', time, 'input')
          await until(
            async () =>
              page.locator('.monitor-canvas video').evaluate((el, expected) => {
                const video = el as HTMLVideoElement
                return (
                  !video.seeking &&
                  Math.abs(video.currentTime - expected) < 0.005
                )
              }, time),
            'paused fine seek',
          )
        }
        await scroll.evaluate((el) => {
          el.scrollLeft = 0
        })
        const id = readProject(workspace).clips[0]!.id
        const trim = (await page
          .locator(`[data-clip-id="${id}"] .trim-handle.right`)
          .boundingBox())!
        const tx = trim.x + trim.width / 2
        const ty = trim.y + trim.height / 2
        await page.mouse.move(tx, ty)
        await page.mouse.down()
        await page.mouse.move(tx - 48, ty, { steps: 8 })
        await page.mouse.up()
        await until(
          () =>
            Math.abs(readProject(workspace).clips[0]!.sourceOut - 1.8) < 0.01,
          'pointer trim persisted',
        )
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await until(
          () => readProject(workspace).clips[0]!.sourceOut === 2,
          'undo pointer trim',
        )
        for (let i = 0; i < 8; i++)
          await page.getByRole('button', { name: '缩小时间线' }).click()
      },
    )

    await check(
      'adds a parallel video track and composites it above the main track',
      async () => {
        await page.getByRole('button', { name: '画面轨', exact: true }).click()
        await until(
          () => readProject(workspace).tracks.length === 2,
          'second video track',
        )
        const card = page
          .locator('.asset-card')
          .filter({ hasText: 'storyboard.png' })
        const overlayLane = page
          .locator('[data-track-kind="video"] .lane')
          .first()
        await card.dragTo(overlayLane, { targetPosition: { x: 100, y: 20 } })
        await until(
          () =>
            readProject(workspace).clips.some(
              (clip) => clip.trackId !== 'main',
            ),
          'overlay clip',
        )
        const initial = readProject(workspace).clips.find(
          (clip) => clip.trackId !== 'main',
        )!
        assert.ok(
          Math.abs(initial.timelineStart - 1.25) <= 0.025,
          `asset drop at ${initial.timelineStart}`,
        )
        const overlayClip = page.locator(`[data-clip-id="${initial.id}"]`)
        await overlayClip.dragTo(overlayLane, {
          sourcePosition: { x: 20, y: 20 },
          targetPosition: { x: 60, y: 20 },
        })
        await until(() => {
          const moved = readProject(workspace).clips.find(
            (clip) => clip.id === initial.id,
          )
          return !!moved && Math.abs(moved.timelineStart - 0.5) < 0.12
        }, 'clip moved with original pointer offset')
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await until(
          () =>
            readProject(workspace).clips.find((clip) => clip.id === initial.id)
              ?.timelineStart === initial.timelineStart,
          'undo clip move',
        )
        const current = readProject(workspace)
        const overlay = current.clips.find((clip) => clip.trackId !== 'main')!
        assert.equal(current.tracks[1]?.index, 1)
        assert.ok(overlay.timelineStart > 0)
        assert.equal(await page.locator('[data-track-kind="video"]').count(), 2)
        assert.equal(await page.locator('[data-track-kind="audio"]').count(), 0)
        await setInput(
          'input[aria-label="播放位置"]',
          overlay.timelineStart + 0.1,
          'input',
        )
        await until(
          async () =>
            (await page
              .locator('.preview-layer[data-preview-active="true"]')
              .count()) === 2 &&
            (await page.locator('.monitor-canvas img').first().isVisible()),
          'two composited picture layers',
        )
        await page.screenshot({
          path: join(shots, 'workspace-two-tracks.png'),
        })
      },
    )

    await check(
      'transcribes locally, generates subtitles and edits their text',
      async () => {
        await page.locator('.video-clip').first().click()
        await page.getByRole('button', { name: '字幕', exact: true }).click()
        const generate = page.getByRole('button', {
          name: '生成字幕',
          exact: true,
        })
        await until(async () => generate.isEnabled(), 'analysis ready')
        const revision = readProject(workspace).revision
        await page.keyboard.press('Delete')
        await page.keyboard.press('Meta+z')
        await generate.click()
        await until(
          () => readProject(workspace).subtitles.length > 0,
          'generated subtitles',
        )
        assert.equal(
          readProject(workspace).revision,
          revision + 1,
          'modal keys did not edit project',
        )
        const subtitles = readProject(workspace).subtitles
        assert.ok(subtitles.some((cue) => cue.text.includes('第一句')))
        await setInput('input[aria-label="播放位置"]', 0.5, 'input')
        await until(
          async () =>
            (await page.locator('.subtitle-overlay').innerText()).includes(
              '第一句',
            ),
          'subtitle overlay',
        )
        await page.locator('.subtitle-clip').first().click()
        await page.getByRole('tab', { name: '参数', exact: true }).click()
        await page.locator('[data-inspector-tab="subtitle"]').waitFor()
        const textarea = page.locator('[data-field="subtitle-text"]')
        await textarea.fill('改过的字幕')
        await textarea.dispatchEvent('change')
        await until(
          () =>
            readProject(workspace).subtitles.some(
              (cue) => cue.text === '改过的字幕',
            ),
          'edited subtitle text',
        )
        await page.screenshot({
          path: join(shots, 'workspace-subtitles.png'),
        })
      },
    )

    await check(
      'split, trim, ripple delete, undo and redo persist',
      async () => {
        await page.locator('.video-clip').first().click()
        await setInput('input[aria-label="播放位置"]', 0.8, 'input')
        await page.getByRole('button', { name: '拆分', exact: true }).click()
        await until(
          () => readProject(workspace).clips.length === 4,
          'split clip',
        )
        let current = readProject(workspace)
        assert.equal(current.clips[0]?.sourceOut, 0.8)
        assert.equal(current.clips[1]?.sourceIn, 0.8)
        assert.equal(current.clips[1]?.timelineStart, 0.8)
        await setInput('[data-field="source-in"]', '1')
        await until(
          () => readProject(workspace).clips[1]?.sourceIn === 1,
          'trimmed source-in',
        )
        assert.equal(readProject(workspace).clips[1]?.timelineStart, 1)

        const removed = readProject(workspace).clips[1]!.id
        await page.locator(`[data-clip-id="${removed}"]`).click()
        await page.keyboard.press('Delete')
        await until(
          () => readProject(workspace).clips.length === 3,
          'ripple delete',
        )
        assert.ok(
          !readProject(workspace).clips.some((clip) => clip.id === removed),
        )
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await until(
          () => readProject(workspace).clips.length === 4,
          'undo delete',
        )
        await page.getByRole('button', { name: '重做', exact: true }).click()
        await until(
          () => readProject(workspace).clips.length === 3,
          'redo delete',
        )
        assert.ok(
          !readProject(workspace).clips.some((clip) => clip.id === removed),
        )
        current = readProject(workspace)
        assert.ok(current.revision >= 8)
        assert.equal(await page.locator('[data-track-kind="audio"]').count(), 0)
        assert.equal(await page.locator('.clip-audio').count(), 3)
      },
    )

    await check(
      'ripple range shortens all tracks and undo restores them',
      async () => {
        const original = readProject(workspace)
        const first = original.clips[0]!
        const length = (first.sourceOut - first.sourceIn) / first.speed
        const following = original.clips.find(
          (clip) =>
            clip.timelineStart >= first.timelineStart + length &&
            clip.trackId !== first.trackId,
        )
        assert.ok(following, 'fixture needs a later clip on a parallel track')
        await page.locator(`[data-clip-id="${first.id}"]`).click()
        await page
          .getByRole('button', { name: '波纹删除', exact: true })
          .click()
        await until(
          () => readProject(workspace).revision === original.revision + 1,
          'ripple range save',
        )
        const updated = readProject(workspace)
        assert.ok(!updated.clips.some((clip) => clip.id === first.id))
        const shifted = updated.clips.find((clip) => clip.id === following.id)
        assert.ok(shifted)
        assert.ok(
          Math.abs(shifted.timelineStart - (following.timelineStart - length)) <
            1e-6,
        )
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await until(
          () => readProject(workspace).revision === updated.revision + 1,
          'ripple range undo',
        )
        assert.deepEqual(readProject(workspace).clips, original.clips)
        assert.deepEqual(readProject(workspace).subtitles, original.subtitles)
      },
    )

    const exportButton = page
      .getByTestId('editor-export')
      .and(page.getByRole('button', { name: '导出 MP4', exact: true }))
    const exports = join(sources, 'exports')
    mkdirSync(exports)
    await check(
      'native save can be canceled without changing the project',
      async () => {
        const revision = readProject(workspace).revision
        const saveCalls = await nativeSaveSelection(app!)
        await exportButton.click({ timeout: 5000 })
        await until(
          async () =>
            (await saveCalls()) === 1 && (await exportButton.isEnabled()),
          'canceled export',
        )
        assert.deepEqual(readdirSync(exports), [])
        assert.equal(readProject(workspace).revision, revision)
      },
    )

    if (realExport) {
      await check(
        'exports a decodable 1080p 30 fps MP4 with audio through native save',
        async () => {
          const project = readProject(workspace)
          const mediaHashes = project.assets.map((asset) =>
            hash(join(workspace, asset.path)),
          )
          const destination = join(exports, '剪辑 成片.mp4')
          const saveCalls = await nativeSaveSelection(app!, destination)
          await exportButton.click()
          await until(
            async () =>
              existsSync(destination) && (await exportButton.isEnabled()),
            'completed export',
            45_000,
          )
          await page.getByText('MP4 已导出', { exact: true }).waitFor()
          assert.equal(await saveCalls(), 1)
          assert.deepEqual(readdirSync(exports), ['剪辑 成片.mp4'])
          assert.equal(readProject(workspace).revision, project.revision)
          assert.deepEqual(
            project.assets.map((asset) => hash(join(workspace, asset.path))),
            mediaHashes,
          )
          const probe = JSON.parse(
            runMediaCommand('ffprobe', [
              '-v',
              'error',
              '-show_entries',
              'stream=codec_type,codec_name,width,height,r_frame_rate:format=format_name,duration',
              '-of',
              'json',
              destination,
            ]).toString('utf8'),
          ) as {
            streams: Array<{
              codec_type: string
              codec_name: string
              width?: number
              height?: number
              r_frame_rate?: string
            }>
            format: { format_name: string; duration: string }
          }
          const picture = probe.streams.find(
            (stream) => stream.codec_type === 'video',
          )
          const audio = probe.streams.find(
            (stream) => stream.codec_type === 'audio',
          )
          assert.equal(picture?.codec_name, 'h264')
          assert.equal(picture.width, 1920)
          assert.equal(picture.height, 1080)
          assert.equal(picture.r_frame_rate, '30/1')
          assert.equal(audio?.codec_name, 'aac')
          assert.ok(probe.format.format_name.split(',').includes('mp4'))
          const duration = Number(probe.format.duration)
          // The last clip is the 3-second image dropped at 1.25s.
          assert.ok(Math.abs(duration - 4.25) < 1 / 30, `duration ${duration}`)
          runMediaCommand('ffmpeg', [
            '-v',
            'error',
            '-xerror',
            '-i',
            destination,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-f',
            'null',
            '-',
          ])
          const samples = runMediaCommand('ffmpeg', [
            '-v',
            'error',
            '-i',
            destination,
            '-ss',
            '0.15',
            '-t',
            '0.35',
            '-map',
            '0:a:0',
            '-ac',
            '1',
            '-ar',
            '8000',
            '-f',
            's16le',
            '-',
          ])
          let peak = 0
          for (let offset = 0; offset < samples.length; offset += 2)
            peak = Math.max(peak, Math.abs(samples.readInt16LE(offset)))
          assert.ok(peak > 1000, `expected the source tone, got peak ${peak}`)
          return {
            width: picture.width,
            height: picture.height,
            fps: picture.r_frame_rate,
            duration,
            audio: audio.codec_name,
          }
        },
      )
    } else {
      process.stderr.write(
        'editing: real MP4 output check skipped because FFmpeg or ffprobe is unavailable on PATH\n',
      )
    }

    await check(
      'canvas, transform, original audio and revision save',
      async () => {
        const current = readProject(workspace)
        const videoClip = current.clips.find(
          (clip) =>
            current.assets.find((asset) => asset.id === clip.assetId)?.kind ===
            'video',
        )!
        await page.locator(`[data-clip-id="${videoClip.id}"]`).click()
        await page.locator('[data-inspector-tab="canvas"]').click()
        await setInput('[data-field="scale"]', '1.25')
        await page.getByRole('button', { name: '适配方式' }).click()
        await page.getByRole('menuitem', { name: '填满画布' }).click()
        await setInput('input[type="color"]', '#123456')
        await page.locator('[data-inspector-tab="audio"]').click()
        await setInput('[data-field="volume"]', '0.35')
        await page.getByRole('switch', { name: '静音' }).click()
        await until(() => {
          const current = readProject(workspace)
          return (
            current.clips[0]?.transform.scale === 1.25 &&
            current.clips[0].volume === 0.35 &&
            current.clips[0].muted &&
            current.canvas.fit === 'cover' &&
            current.canvas.background === '#123456'
          )
        }, 'clip and canvas parameters')
        finalRevision = readProject(workspace).revision
        assert.equal(hash(video), originalHashes[0])
        assert.equal(hash(image), originalHashes[1])
      },
    )

    await check(
      'Agent clears accepted input, applies two edits without dialogs, undoes and focuses',
      async () => {
        const clip = readProject(workspace).clips[0]!
        assert.ok(clip)
        const targetOut = Number(
          (
            clip.sourceIn + Math.min(0.8, (clip.sourceOut - clip.sourceIn) / 2)
          ).toFixed(2),
        )
        assert.ok(targetOut > clip.sourceIn && targetOut < clip.sourceOut)
        const before = readProject(workspace)
        const volume = clip.volume === 0.25 ? 0.5 : 0.25
        let releaseFirstRequest!: () => void
        const firstRequest = new Promise<void>((resolve) => {
          releaseFirstRequest = resolve
        })
        await page.evaluate(() => {
          const state = { shown: 0 }
          Object.assign(window, { editingApprovalReceipt: state })
          const selector = '[data-takeover="approval"]'
          const observer = new MutationObserver((changes) => {
            for (const change of changes) {
              for (const node of change.addedNodes) {
                if (!(node instanceof Element)) continue
                state.shown +=
                  Number(node.matches(selector)) +
                  node.querySelectorAll(selector).length
              }
            }
          })
          observer.observe(document.body, { childList: true, subtree: true })
        })
        model.enqueue(
          async () => {
            await firstRequest
            return toolStep('video_project_read', {})()
          },
          toolStep('video_edit_preview', {
            command: {
              type: 'trimClip',
              clipId: clip.id,
              sourceOut: targetOut,
            },
          }),
          toolStep('video_edit_apply', {
            command: {
              type: 'trimClip',
              clipId: clip.id,
              sourceOut: targetOut,
            },
          }),
          toolStep('video_edit_apply', {
            command: { type: 'updateClip', clipId: clip.id, volume },
          }),
          textStep('已修剪片段并调整音量。'),
        )
        const input = page.getByRole('textbox', { name: '消息输入框' })
        try {
          await sendAgentPrompt('把第 1 段修剪短一点并降低音量')
          await page
            .getByTestId('editor-agent-composer')
            .getByRole('button', { name: '停止', exact: true })
            .waitFor()
          await until(
            async () => (await input.innerText()).trim() === '',
            'accepted Agent message clears input during the turn',
          )
          await input.fill('下一条新草稿')
        } finally {
          releaseFirstRequest()
        }
        await until(
          async () =>
            (await page.getByText('已修剪片段并调整音量。').count()) > 0,
          'Agent reply',
        )
        const afterTrim = readProject(workspace)
        assert.equal(afterTrim.revision, before.revision + 2)
        assert.equal(afterTrim.clips[0]?.sourceOut, targetOut)
        assert.equal(afterTrim.clips[0]?.volume, volume)
        assert.equal(await input.innerText(), '下一条新草稿')

        model.enqueue(
          toolStep('video_edit_history', { action: 'undo' }),
          textStep('已经撤销。'),
        )
        await sendAgentPrompt('撤销刚才的修改')
        await until(
          () => readProject(workspace).clips[0]?.volume === clip.volume,
          'Agent undo',
        )
        await until(
          async () => (await page.getByText('已经撤销。').count()) > 0,
          'undo reply',
        )
        assert.equal(readProject(workspace).clips[0]?.sourceOut, targetOut)
        assert.equal(
          await page.evaluate(
            () =>
              (
                window as unknown as {
                  editingApprovalReceipt: { shown: number }
                }
              ).editingApprovalReceipt.shown,
          ),
          0,
        )

        const focusClip = readProject(workspace).clips[0]!
        model.enqueue(
          toolStep('video_project_focus', {
            clipId: focusClip.id,
            time: 0.4,
          }),
          textStep('已经定位到第 1 段。'),
        )
        await sendAgentPrompt('定位到第 1 段')
        await until(
          async () => (await page.getByText('已经定位到第 1 段。').count()) > 0,
          'focus reply',
        )
        await until(async () => {
          const playhead = Number(
            await page.locator('input[aria-label="播放位置"]').inputValue(),
          )
          return (
            Math.abs(playhead - 0.4) < 0.05 &&
            (await page.locator('.video-clip.selected').count()) === 1
          )
        }, 'Agent focus')
        assert.ok(model.served.length >= 8)
        assert.equal(model.errors.length, 0)
        finalRevision = readProject(workspace).revision
      },
    )

    await check(
      'Agent transcribes a video clip locally without approval',
      async () => {
        const current = readProject(workspace)
        const videoClip = current.clips.find(
          (clip) =>
            current.assets.find((asset) => asset.id === clip.assetId)?.kind ===
            'video',
        )!
        assert.ok(videoClip)
        model.enqueue(
          toolStep('video_transcribe', { clipId: videoClip.id }),
          textStep('我读到了这段台词。'),
        )
        await sendAgentPrompt('读一下这段视频的台词')
        const cache = join(
          workspace,
          '.cutroom',
          'analysis',
          'transcripts',
          `${videoClip.assetId}.json`,
        )
        await until(() => existsSync(cache), 'transcript cache')
        await until(
          async () => (await page.getByText('我读到了这段台词。').count()) > 0,
          'transcribe reply',
        )
        const transcript = JSON.parse(readFileSync(cache, 'utf8')) as {
          segments: Array<{ text: string }>
        }
        assert.ok(
          transcript.segments.some((segment) =>
            segment.text.includes('第一句'),
          ),
        )
        assert.equal(model.errors.length, 0)
      },
    )

    await check(
      'responsive library and light theme remain usable',
      async () => {
        assert.equal(await page.locator('#editor-properties-panel').count(), 1)
        await page.getByTestId('editor-theme-toggle').click()
        await page.setViewportSize({ width: 1100, height: 700 })
        await showAgent()
        await page.getByTestId('editor-assets-toggle').click()
        await until(
          async () =>
            !(await page.locator('#editor-properties-panel').isVisible()),
          'narrow inspector collapses',
        )
        const monitor = await page.locator('.monitor-canvas').boundingBox()
        assert.ok(
          monitor && Math.abs(monitor.width / monitor.height - 16 / 9) < 0.015,
        )
        await page.getByRole('textbox', { name: '消息输入框' }).waitFor()
        assert.equal(await page.locator('#editor-chat-panel').count(), 1)
        assert.equal(await page.locator('.editor-tool-rail').count(), 0)
        assert.equal(await page.locator('.asset-library').isVisible(), true)
        assert.equal(await page.locator('.sidebar-root').count(), 0)
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        const lightImportButton = page.getByRole('button', {
          name: '导入素材',
          exact: true,
        })
        await until(
          () =>
            page.evaluate(
              () => document.documentElement.dataset.theme === 'light',
            ),
          'light theme',
        )
        await page.waitForTimeout(350)
        const lightContrast = await buttonContrast(lightImportButton)
        assert.ok(
          lightContrast.ratio >= 4.5,
          `light 导入素材 contrast: ${lightContrast.foreground} on ${lightContrast.background}`,
        )
        await page.screenshot({
          path: join(shots, 'workspace-1100-light-library.png'),
        })
        await page.getByTestId('editor-theme-toggle').click()
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.getByTestId('editor-inspector-toggle').click()
        await page.locator('#editor-properties-panel').waitFor()
      },
    )

    await check(
      'right-click references append to the unsent Agent draft',
      async () => {
        await verifyTimelineReferences(workspace, model)
      },
    )

    await app.close()
    app = null
    if (precisionOnly) {
      assert.ok(
        realExport,
        'precision acceptance requires real FFmpeg and FFprobe',
      )
      const configPath = join(home, 'video-analysis.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      const location = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' })
      assert.equal(location.status, 0)
      writeFileSync(
        configPath,
        JSON.stringify({ ...config, ffmpegPath: location.stdout.trim() }),
      )
    }
    app = await launch(home)
    if (precisionOnly) {
      await precisionScenario(app, model, workspace, video, originalHashes[0]!)
      await check(
        'reopening the project restores the delivered precision draft and preview',
        async () => {
          const before = readProject(workspace)
          const requests = model.served.length
          await app!.close()
          app = await launch(home)
          await nativeSelection(app, [workspace])
          await page.getByTestId('open-folder').click()
          const task = page.getByRole('region', { name: '精剪任务' })
          await task.getByText('精剪已交付', { exact: true }).waitFor()
          await task.locator('summary.run-heading').click()
          await task.getByRole('button', { name: /正片开场/ }).waitFor()
          await task.getByText('播放审片预览', { exact: true }).click()
          const preview = task.getByLabel('精剪审片预览')
          await until(
            async () =>
              (await preview.count()) === 1 &&
              (await preview.evaluate(
                (video: HTMLVideoElement) => video.readyState >= 2,
              )),
            'restored rendered preview',
          )
          await preview.evaluate((video: HTMLVideoElement) => video.play())
          await until(
            () =>
              preview.evaluate(
                (video: HTMLVideoElement) => video.currentTime > 0.1,
              ),
            'reopened draft playback advances',
          )
          assert.deepEqual(readProject(workspace), before)
          assert.equal(model.served.length, requests)
          assert.equal(
            await page.locator('[data-takeover="approval"]').count(),
            0,
          )
          return { revision: before.revision, requests }
        },
      )
      return
    }
    await check(
      'restart restores the same workspace, session and saved revision',
      async () => {
        await page.getByTestId('new-project').waitFor({ timeout: 30_000 })
        await page.getByTestId(`recent-project-${sessionId}`).click()
        await page.locator('.editor-workspace').waitFor({ timeout: 30_000 })
        await until(
          () => readProject(workspace).revision === finalRevision,
          'persisted revision',
        )
        assert.equal(readProject(workspace).canvas.background, '#123456')
        assert.equal(readProject(workspace).clips[0]?.muted, true)
        assert.equal(readProject(workspace).tracks.length, 2)
        assert.ok(
          readProject(workspace).subtitles.some(
            (cue) => cue.text === '改过的字幕',
          ),
        )
        await page.getByRole('textbox', { name: '消息输入框' }).waitFor()
        await page.getByRole('tab', { name: '参数', exact: true }).click()
        await until(
          () => page.locator('#editor-chat-panel').isHidden(),
          'Agent dock hidden after restart',
        )
        await page
          .getByRole('tab', { name: 'Cutroom Agent', exact: true })
          .click()
        await page.getByRole('textbox', { name: '消息输入框' }).waitFor()
        assert.ok(page.url().includes('/editor'))
        await page.getByText('已经定位到第 1 段。').waitFor({ timeout: 15_000 })
        await page.locator('.editor-workspace').waitFor()
        await page.screenshot({ path: join(shots, 'workspace-restored.png') })
        assert.equal(model.errors.length, 0)
      },
    )

    await check(
      'reopens a project with missing media, relinks it and preserves its clips',
      async () => {
        const before = readProject(workspace)
        const missing = before.assets.find((asset) => asset.kind === 'video')!
        const clipIds = before.clips
          .filter((clip) => clip.assetId === missing.id)
          .map((clip) => clip.id)
        assert.ok(clipIds.length > 0)
        await app!.close()
        app = null
        rmSync(join(workspace, missing.path))
        app = await launch(home)
        await page.getByTestId(`recent-project-${sessionId}`).click()
        await page.locator('.editor-workspace').waitFor()
        await page.getByTestId(`asset-${missing.id}`).click()
        await page.getByText('素材文件缺失', { exact: true }).waitFor()
        await page.locator('.media-error').waitFor({ timeout: 5000 })
        assert.ok(
          await page.getByRole('button', { name: '添加到时间线' }).isDisabled(),
        )
        const relink = page.getByRole('button', { name: '重新链接文件' })
        await nativeSelection(app!, [video])
        await relink.click()
        await until(async () => {
          const current = readProject(workspace).assets.find(
            (asset) => asset.id === missing.id,
          )
          return (
            !!current &&
            current.path !== missing.path &&
            !(await relink.isVisible())
          )
        }, 'relinked video')
        const after = readProject(workspace)
        const restored = after.assets.find((asset) => asset.id === missing.id)!
        assert.equal(hash(join(workspace, restored.path)), originalHashes[0])
        assert.deepEqual(
          after.clips
            .filter((clip) => clip.assetId === missing.id)
            .map((clip) => clip.id),
          clipIds,
        )
        assert.equal(workspaceSession(workspace), sessionId)
        await until(async () => {
          const preview = page.locator('.monitor-canvas video')
          return (
            (await preview.count()) === 1 &&
            (await preview.evaluate(
              (element) => (element as HTMLVideoElement).readyState >= 2,
            ))
          )
        }, 'relinked video preview')
        assert.equal(await page.locator('.media-error').count(), 0)
      },
    )
  } catch (error) {
    if (!(error instanceof Abort))
      report({
        suite: SUITE,
        name: 'runner',
        ok: false,
        ms: 0,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      })
  } finally {
    await app?.close().catch(() => undefined)
    await model.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    rmSync(sources, { recursive: true, force: true })
    rmSync(emptyFolder, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}
void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
