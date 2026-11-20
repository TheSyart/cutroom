import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  chmodSync,
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type Page, type ElectronApplication } from 'playwright-core'
import { verifyPreviewExport } from './compare'
import { startFakeModel, summaryIn, type Step } from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const output = resolve(
  process.env.CUTROOM_ACCEPTANCE_OUTPUT || join(desktop, 'out-e2e', 'motion'),
)
const home = process.env.CUTROOM_E2E_STATE || process.env.EMPEROR_CONFIG_DIR!
const real = Boolean(process.env.CUTROOM_MOTION_REAL_PROFILE)
const spoken = process.env.CUTROOM_MOTION_SPEECH
const tag = real ? 'live-model' : spoken ? 'spoken' : 'studio'
mkdirSync(output, { recursive: true })
const project = mkdtempSync(join(output, tag + '-project-'))
const outMovie = join(project, tag + '.mp4')
const timeline = () =>
  JSON.parse(readFileSync(join(project, 'timeline.json'), 'utf8'))
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const trace: { status: string; seq: number; frame: number; id?: string }[] = []
async function wait(check: () => unknown | Promise<unknown>, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await pause(80)
  }
  throw new Error(
    'Timed out waiting for motion workspace. ' +
      JSON.stringify(trace.slice(-3)),
  )
}
async function pick(app: ElectronApplication, path: string, save = false) {
  await app.evaluate(
    ({ dialog }, { path, save }) => {
      if (save)
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: path,
        })) as typeof dialog.showSaveDialog
      else
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog
    },
    { path, save },
  )
}
async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (p): p is [string, string] => typeof p[1] === 'string',
      ),
    ),
    CUTROOM_DATA_DIR: home,
    CUTROOM_CACHE_DIR: join(home, 'caches'),
    VIDEO_EDIT_AGENT_DATA_DIR: home,
    EMPEROR_CONFIG_DIR: home,
  }
  delete env.VIDEO_EDIT_AGENT_LEGACY_MODEL_HOME
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    cwd: desktop,
    ...(process.env.CUTROOM_ACCEPTANCE_EXECUTABLE
      ? { executablePath: process.env.CUTROOM_ACCEPTANCE_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.CUTROOM_ACCEPTANCE_EXECUTABLE ? [] : ['.']),
      '--user-data-dir=' + join(home, 'profile'),
    ],
    env,
    timeout: 60000,
  })
  const page = await app.firstWindow()
  const handle = await app.browserWindow(page)
  const windowId = await handle.evaluate((win) => win.id)
  await handle.dispose()
  const size = await app.evaluate(({ BrowserWindow, screen }, id) => {
    const win = BrowserWindow.fromId(id)!
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const width = Math.min(1500, area.width)
    const height = Math.min(920, area.height)
    win.setBounds({
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    })
    const [contentWidth, contentHeight] = win.getContentSize()
    return { width: contentWidth!, height: contentHeight! }
  }, windowId)
  await page.setViewportSize(size)
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 })
  return { app, page }
}

function object(
  id: string,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  html: string,
  draw = '',
  frame = 0,
) {
  return {
    id,
    name,
    html,
    draw,
    bounds: { x, y, width: w, height: h },
    markers: [{ frame, label: name }],
  }
}
const node = (label: string, note: string, color: string) =>
  `<div style="border:3px solid ${color};border-radius:26px;background:#15243a;padding:34px 38px;height:100%;font-family:system-ui;color:white"><div style="font-size:56px;font-weight:700">${label}</div><div style="font-size:30px;color:${color};margin-top:12px">${note}</div></div>`
const title = object(
  'title',
  '工具调用',
  138,
  135,
  1600,
  125,
  '<div style="font:700 92px system-ui;color:#f4f6fb">一次工具调用</div>',
)
const left = object(
  'agent',
  'Agent 节点',
  142,
  424,
  435,
  212,
  node('Agent', '发出请求', '#60dece'),
)
const right = object(
  'tool',
  '工具节点',
  1338,
  424,
  435,
  212,
  node('工具', '执行任务', '#eab574'),
)
const arrow = (index: number) =>
  object(
    'request',
    '请求路径',
    575,
    450,
    770,
    120,
    '<svg viewBox="0 0 770 120" width="100%" height="100%"><path class="line" fill="none" stroke="#62decc" stroke-width="9" stroke-linecap="round" stroke-dasharray="744 744" d="M4 81H748"/><path class="head" fill="#62decc" d="M0 0l-28 -19v38z"/></svg>',
    `const distance = Math.max(0, Math.min(${Math.min(744, 30 + index * 36)}, (t-0.15)*420));
     root.style.opacity = distance > 0 ? '1' : '0';
     root.querySelector('.line').setAttribute('stroke-dashoffset',String(744-distance));
     root.querySelector('.head').setAttribute('transform','translate('+(4+distance)+' 81)');`,
    30,
  )
const result = object(
  'result',
  '结果返回',
  578,
  566,
  760,
  96,
  '<svg viewBox="0 0 760 96" width="100%"><path d="M751 7 V70 H28 M50 48 L22 70 50 91" fill="none" stroke="#eab574" stroke-width="8" stroke-linejoin="round"/></svg>',
  'root.style.opacity=String(Math.min(1,Math.max(0,(t-2)*4)))',
  60,
)
async function installTrace(page: Page) {
  await page.exposeFunction('motionReceipt', (event: (typeof trace)[number]) =>
    trace.push(event),
  )
  await page.evaluate(() => {
    const w = window as any
    w.probe = { events: [], paints: [], start: 0 }
    w.emperor.onCoreEvent((e: any) => {
      if (e.event !== 'video_motion_work') return
      const v = e.work
      const record = {
        id: v.id,
        status: v.status,
        seq: v.seq,
        frame: v.frame,
        objectId: v.objectId,
        stepReceivedAt: v.stepReceivedAt,
        at: performance.now(),
      }
      w.probe.events.push(record)
      void w.motionReceipt(record)
    })
    function sample() {
      const img = document.querySelector(
        '[data-testid="motion-preview"] img[data-motion-seq]',
      ) as HTMLImageElement | null
      if (img?.complete && img.naturalWidth) {
        const seq = Number(img.dataset.motionSeq)
        const e = w.probe.events.findLast(
          (v: any) => v.status === 'drawing' && v.seq === seq,
        )
        if (
          e &&
          !w.probe.paints.some((p: any) => p.id === e.id && p.seq === seq)
        )
          w.probe.paints.push({
            id: e.id,
            seq,
            bridgeToPaintMs: performance.now() - e.at,
            stepToPaintMs:
              performance.timeOrigin + performance.now() - e.stepReceivedAt,
            at: performance.now(),
          })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}
interface TranscriptSegment {
  text: string
  tokens: { text: string; offsets: { from: number; to: number } }[]
}
function speechAnchor() {
  if (!spoken) return null
  const path = process.env.CUTROOM_MOTION_TRANSCRIPT
  assert.ok(
    path,
    'Spoken validation requires CUTROOM_MOTION_TRANSCRIPT with Whisper token offsets.',
  )
  const transcript = JSON.parse(readFileSync(path, 'utf8')) as {
    transcription: TranscriptSegment[]
  }
  for (const segment of transcript.transcription) {
    if (!/skill/i.test(segment.text)) continue
    for (const [index, token] of segment.tokens.entries()) {
      const spelling = token.text.trim().toLowerCase()
      const next = segment.tokens[index + 1]
      if (
        spelling !== 'skill' &&
        !(spelling === 'sk' && next?.text.trim().toLowerCase() === 'ill')
      )
        continue
      const startMs = token.offsets.from
      assert.ok(Number.isFinite(startMs) && startMs >= 0)
      return {
        word: 'skill',
        segment: segment.text,
        token: token.text.trim(),
        startMs,
        sourceTime: startMs / 1000,
        frame: Math.round((startMs * 30) / 1000),
      }
    }
  }
  throw new Error(
    'Could not locate a timestamped skill or sk + ill token in ' + path,
  )
}
async function activeVideo(page: Page) {
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[data-preview-active="true"] video',
    )
    return Boolean(
      video && video.readyState >= 2 && video.videoWidth > 0 && !video.error,
    )
  })
}
async function addSpokenClip(
  app: ElectronApplication,
  page: Page,
  path: string,
) {
  await pick(app, path)
  await page.getByRole('button', { name: '导入素材', exact: true }).click()
  await wait(() => timeline().assets[0]?.duration >= 7.99)
  const asset = page.getByTestId('asset-' + timeline().assets[0].id)
  if (!(await asset.isVisible()))
    await page.getByTestId('editor-assets-toggle').click()
  await asset.click()
  await page.getByRole('button', { name: '添加到时间线', exact: true }).click()
  await wait(() => timeline().clips.length === 1)
  const close = page.getByRole('button', { name: '关闭素材库', exact: true })
  if (await close.isVisible()) await close.click()
  await activeVideo(page)
}
async function verifySpokenClipMove(page: Page) {
  const initial = timeline()
  const before = initial.motionScenes[0]
  const clip = initial.clips[0]
  assert.equal(before.anchor?.clipId, clip.id)
  const field = page.locator(`[data-clip-id="${clip.id}"]`)
  const lane = page.locator('.video-row .lane').first()
  await field.dragTo(lane, {
    sourcePosition: { x: 20, y: 20 },
    targetPosition: { x: 60, y: 20 },
  })
  await wait(() => timeline().clips[0].timelineStart > clip.timelineStart + 0.1)
  const moved = timeline()
  const delta = moved.clips[0].timelineStart - clip.timelineStart
  const after = moved.motionScenes[0]
  assert.equal(after.anchor.clipId, clip.id)
  assert.equal(after.anchor.sourceTime, before.anchor.sourceTime)
  assert.equal(after.startFrame, before.startFrame + Math.round(delta * 30))
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await wait(
    () =>
      timeline().clips[0].timelineStart === clip.timelineStart &&
      timeline().motionScenes[0].startFrame === before.startFrame,
  )
  assert.deepEqual(timeline().motionScenes, initial.motionScenes)
  return {
    clipId: clip.id,
    sourceTime: before.anchor.sourceTime,
    initialSceneFrame: before.startFrame,
    movedSceneFrame: after.startFrame,
    clipMoveSeconds: delta,
    undoSceneFrame: timeline().motionScenes[0].startFrame,
  }
}

async function openDrawingMenu(page: Page) {
  const plus = page.getByRole('button', { name: '添加附件与能力' })
  if (
    !(await page.getByTestId('editor-agent-composer').isVisible()) &&
    (await page
      .getByTestId('editor-agent-toggle')
      .getAttribute('aria-pressed')) === 'false'
  ) {
    await page.getByTestId('editor-agent-toggle').click()
  }
  await plus.click()
  return page.getByTestId('motion-enabled')
}

async function main() {
  const started = Date.now()
  const anchor = speechAnchor()
  const session = await launchAfterConfig()
  let { app, page } = session
  const fake = session.fake
  let recording = false
  try {
    await pick(app, project)
    await page.getByTestId('new-project').click()
    await page.getByRole('button', { name: '新建剪辑', exact: true }).click()
    await page.locator('.editor-workspace').waitFor()
    if (spoken) await addSpokenClip(app, page, spoken)
    const revision = timeline().revision
    await installTrace(page)
    await page.screencast.start({
      path: join(output, tag + '-drawing.webm'),
      size: page.viewportSize()!,
    })
    recording = true
    const toggle = await openDrawingMenu(page)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await toggle.press('Escape')
    const tool = (name: string, args: Record<string, unknown>) => ({
      tools: [{ name, args }],
    })
    const common = (request: Parameters<Step>[0]) => {
      const v = summaryIn(request)
      assert.ok(v.workId, 'Tool failed: ' + JSON.stringify(v).slice(0, 300))
      assert.ok(typeof v.seq === 'number')
      return { workId: v.workId, expectedSeq: v.seq }
    }
    const base = anchor?.frame ?? 0
    const takeovers: {
      seq: number
      head: number
      afterSeq?: number
      afterHead?: number
      resumeHead?: number
      resumeFrame?: number
    }[] = []
    const readScrubber = async () =>
      Number(await page.locator('.playback-scrubber').inputValue())
    const steps: Step[] = [
      () =>
        tool('video_motion_begin', {
          sceneId: 'round-trip',
          name: '一次工具调用',
          story: anchor
            ? '在原声说到 skill 时显示标签，保留原声。'
            : '请求从 Agent 到工具，结果沿下方路径返回。',
          startFrame: base,
          durationFrames: spoken ? 96 : 240,
          mode: spoken ? 'overlay' : 'fullscreen',
          expectedVersion: 0,
          expectedRevision: revision,
          ...(spoken
            ? {
                anchor: {
                  clipId: timeline().clips[0].id,
                  sourceTime: anchor!.sourceTime,
                },
              }
            : {}),
        }),
    ]
    const objects = spoken
      ? [
          object(
            'anchor',
            'skill',
            115,
            725,
            610,
            118,
            '<div style="font:700 60px system-ui;color:white;background:#124341;border-left:12px solid #68e0d0;border-radius:18px;padding:15px 35px">skill</div>',
            'gsap.set(root,{x:Math.min(1,t*4)*12})',
          ),
        ]
      : [
          title,
          left,
          right,
          ...Array.from({ length: 21 }, (_, i) => arrow(i)),
          result,
        ]
    for (const [i, o] of objects.entries()) {
      steps.push(async (req) => {
        const input = common(req)
        if (!spoken && [4, 5, 6].includes(i)) {
          await wait(() =>
            trace.some(
              (event) =>
                event.status === 'drawing' && event.seq === input.expectedSeq,
            ),
          )
          await page.waitForFunction(
            (seq) =>
              Number(
                document
                  .querySelector('[data-testid="motion-preview"] img')
                  ?.getAttribute('data-motion-seq'),
              ) === seq,
            input.expectedSeq,
          )
        }
        if (i === 4 && !spoken) {
          await page
            .locator('.timeline-ruler')
            .click({ position: { x: 400, y: 12 } })
          await wait(
            async () =>
              (await page
                .getByTestId('motion-follow')
                .getAttribute('aria-pressed')) === 'false',
          )
          const head = await readScrubber()
          assert.ok(
            Math.abs(head - 5) < 0.04,
            'Ruler seek did not take the playhead to 5 s: ' + head,
          )
          takeovers.push({ seq: input.expectedSeq, head })
        }
        if (i === 5 && !spoken) {
          const held = takeovers[0]!
          await wait(() =>
            trace.some(
              (event) => event.status === 'drawing' && event.seq > held.seq,
            ),
          )
          held.afterSeq = input.expectedSeq
          held.afterHead = await readScrubber()
          assert.equal(
            held.afterHead,
            held.head,
            'Agent drawing displaced the manual playhead',
          )
          assert.equal(
            await page
              .getByTestId('motion-follow')
              .getAttribute('aria-pressed'),
            'false',
          )
        }
        if (i === 6 && !spoken) {
          const latest = [...trace]
            .reverse()
            .find((e) => e.status === 'drawing')
          assert.ok(latest)
          assert.equal(latest.seq, input.expectedSeq)
          await page.getByTestId('motion-follow').click()
          await wait(
            async () =>
              Math.abs((await readScrubber()) - latest.frame / 30) <= 0.011,
          )
          assert.equal(
            await page
              .getByTestId('motion-follow')
              .getAttribute('aria-pressed'),
            'true',
          )
          assert.ok(
            await page
              .getByRole('button', { name: '播放', exact: true })
              .isVisible(),
            'Resume unexpectedly started playback',
          )
          takeovers[0]!.resumeFrame = latest.frame
          takeovers[0]!.resumeHead = await readScrubber()
        }
        await pause(i < 4 ? 650 : 250)
        return tool('video_motion_object', {
          ...input,
          object: o,
          frame: base + (spoken ? 0 : Math.min(i * 3, 90)),
        })
      })
    }
    steps.push(
      async (req) => {
        const input = common(req)
        await pause(950)
        assert.equal(timeline().revision, revision)
        return tool('video_motion_finish', input)
      },
      () => ({ text: '动效已完成。' }),
    )
    fake?.enqueue(...steps)
    const message = real
      ? '请在当前空工程绘制一段 8 秒全屏动效：蓝色圆点从左移到右，显示文字「工具调用」。使用动效绘制工具逐步创建，完成后提交到时间线。'
      : spoken
        ? '在口播说到 skill 时添加一个绑定到这段原声的动效标注。'
        : '绘制八秒全屏动效，逐步画出 Agent 和工具之间的一次请求与返回。'
    const field = page.getByRole('textbox', { name: '消息输入框' })
    await field.fill(message)
    await page.evaluate(() => {
      ;(window as any).probe.start = performance.now()
    })
    await field.press('Enter')
    await wait(
      () =>
        trace.some((v) => v.status === 'committed') ||
        Boolean(fake?.errors.length),
      real ? 240000 : 75000,
    )
    assert.deepEqual(fake?.errors ?? [], [])
    await wait(() => timeline().motionScenes?.length === 1)
    await page.screenshot({ path: join(output, tag + '-workspace.png') })
    if (!spoken && !real) {
      const marker = page
        .locator('[data-motion-object="request"] [data-motion-marker]')
        .first()
      if (!(await marker.isVisible()))
        await page.locator('[data-motion-expand="round-trip"]').click()
      await marker.click()
      assert.equal(
        await page
          .getByTestId('motion-highlight')
          .getAttribute('data-object-id'),
        'request',
      )
      await marker.click({ button: 'right' })
      await page.getByTestId('timeline-add-reference').click()
      await wait(() =>
        field.evaluate((el) =>
          (el instanceof HTMLTextAreaElement
            ? el.value
            : (el.textContent ?? '')
          ).includes('请求路径'),
        ),
      )
    }
    const clipMove = spoken ? await verifySpokenClipMove(page) : undefined
    await page.screencast.stop()
    recording = false
    const probe = await page.evaluate(() => (window as any).probe)
    const warm = probe.paints.slice(1) as {
      bridgeToPaintMs: number
      stepToPaintMs: number
    }[]
    function p95(metric: 'bridgeToPaintMs' | 'stepToPaintMs'): number | null {
      if (!warm.length) return null
      const sorted = warm.map((sample) => sample[metric]).sort((a, b) => a - b)
      assert.ok(
        sorted.every(Number.isFinite),
        'Missing sample timing for ' + metric,
      )
      return sorted[Math.ceil(sorted.length * 0.95) - 1]!
    }
    const warmStepP95Ms = p95('stepToPaintMs')
    const bridgeP95Ms = p95('bridgeToPaintMs')
    const stats = {
      ...(anchor ? { wordAnchor: anchor, clipMove } : {}),
      takeovers,
      model: real ? 'configured' : 'scripted-local',
      scene: timeline().motionScenes[0].name,
      firstMs: probe.paints[0]?.at - probe.start,
      warmStepP95Ms,
      bridgeP95Ms,
      samples: warm.length,
      events: probe.events,
      paints: probe.paints,
    }
    writeFileSync(
      join(output, tag + '-timing.json'),
      JSON.stringify(stats, null, 2),
    )
    assert.ok(probe.paints.length, 'No real preview paint during drawing')
    if (!spoken && !real) {
      assert.ok(warm.length >= 18)
      assert.ok(
        warmStepP95Ms !== null && warmStepP95Ms <= 300,
        'step to paint warm P95 ' + warmStepP95Ms,
      )
    }
    const stored = timeline().motionScenes
    await app.close()
    ;({ app, page } = await launch())
    await pick(app, project)
    await page.getByTestId('open-folder').click()
    await page.locator('.editor-workspace').waitFor()
    const reopenedToggle = await openDrawingMenu(page)
    await wait(
      async () =>
        (await reopenedToggle.getAttribute('aria-checked')) === 'true',
    )
    await reopenedToggle.press('Escape')
    assert.deepEqual(timeline().motionScenes, stored)
    await pick(app, outMovie, true)
    await page.getByTestId('editor-export').click()
    await wait(() => existsSync(outMovie), 95000)
    const stream = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-count_frames',
          '-show_entries',
          'stream=width,height,r_frame_rate,nb_read_frames',
          '-of',
          'json',
          outMovie,
        ],
        { encoding: 'utf8' },
      ),
    ).streams[0]
    assert.equal(stream.width, 1920)
    assert.equal(stream.height, 1080)
    assert.equal(stream.r_frame_rate, '30/1')
    if (!spoken) assert.equal(stream.nb_read_frames, '240')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      outMovie,
      '-f',
      'null',
      '-',
    ])
    await verifyPreviewExport(
      page,
      outMovie,
      project,
      spoken ? [base - 1, base, base + 15] : [0, 45, 120, 239],
    )
    console.log(
      'E2E-RESULT ' +
        JSON.stringify({
          suite: 'motion',
          name: tag,
          ok: true,
          ms: Date.now() - started,
          detail: {
            ...stream,
            firstMs: stats.firstMs,
            warmStepP95Ms,
            bridgeP95Ms,
            samples: warm.length,
            project,
          },
        }),
    )
    console.log('E2E-DONE')
  } catch (e) {
    await page
      .screenshot({ path: join(output, tag + '-error.png') })
      .catch(() => {})
    console.error(e)
    console.error('last event', trace.slice(-1))
    process.exitCode = 1
  } finally {
    if (recording) await page.screencast.stop().catch(() => {})
    await app.close().catch(() => {})
    await fake?.close()
  }
}
async function launchAfterConfig() {
  if (real) {
    const profile = realpathSync(process.env.CUTROOM_MOTION_REAL_PROFILE!)
    assert.equal(
      profile,
      realpathSync(join(homedir(), 'Library/Application Support/Cutroom 试剪')),
      'Use the Cutroom trial configuration for real-model acceptance.',
    )
    assert.notEqual(realpathSync(home), profile)
    const key = ['secrets/local.key', 'computer-use/secrets/local.key']
      .map((name) => join(profile, name))
      .find(existsSync)
    assert.ok(key, 'Trial profile has no local key')
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 })
    copyFileSync(key, join(home, 'secrets/local.key'))
    chmodSync(join(home, 'secrets/local.key'), 0o600)
    copyFileSync(
      join(profile, 'model_config.json'),
      join(home, 'model_config.json'),
    )
    chmodSync(join(home, 'model_config.json'), 0o600)
  }
  const fake = real
    ? null
    : await startFakeModel({ agentTool: 'video_project_read' })
  if (fake)
    writeFileSync(
      join(home, 'model_config.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeModelId: 'motion-test',
        models: [
          {
            entryId: 'motion-test',
            provider: 'deepseek',
            protocol: 'openai',
            modelId: 'deepseek-chat',
            displayName: '本地验收模型',
            apiBase: fake.apiBase,
            apiKey: 'sk-fake',
            contextWindowTokens: 128000,
            maxTokens: 4096,
            reasoningEffort: null,
          },
        ],
      }),
    )
  return { ...(await launch()), fake }
}
void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
