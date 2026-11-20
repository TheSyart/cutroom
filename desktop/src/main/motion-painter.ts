import { createHash, randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { motionSceneSchema } from '@emperor/core/api'
import type { MotionScene } from '@emperor/core/editing'
import gsapSource from 'gsap/dist/gsap.min.js?raw'

const blank =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden;background:transparent}#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;overflow:hidden}</style>
<body><div id="stage"></div></body>`)

// Runs only in the unprivileged drawing document. Every frame reconstructs its
// DOM and resets GSAP, so seeking never depends on a previously played frame.
const prepare = `(objects, mode) => {
  const painters = objects.map(o => new Function('root','t','frame','gsap',o.draw))
  const stage = document.querySelector('#stage')
  stage.style.background = mode === 'fullscreen' ? '#10141c' : 'transparent'
  window.drawCutroomFrame = async frame => {
    gsap.globalTimeline.clear()
    gsap.globalTimeline.totalTime(0, true)
    gsap.ticker.sleep()
    stage.replaceChildren()
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i], b = o.bounds, root = document.createElement('div')
      Object.assign(root.style,{position:'absolute',left:b.x+'px',top:b.y+'px',width:b.width+'px',height:b.height+'px'})
      root.id = o.id
      root.innerHTML = o.html
      stage.append(root)
      painters[i](root,frame/30,frame,gsap)
    }
    gsap.globalTimeline.totalTime(frame/30, true)
    for (const animation of stage.getAnimations({subtree:true})) {
      animation.pause()
      animation.currentTime = frame*1000/30
    }
    for (const svg of stage.querySelectorAll('svg')) {
      svg.pauseAnimations()
      svg.setCurrentTime(frame/30)
    }
    gsap.ticker.sleep()
    await document.fonts.ready
    await Promise.all([...stage.querySelectorAll('img')].map(i => i.decode()))
    return stage.getBoundingClientRect().width
  }
}`

class PaintSurface {
  private window?: BrowserWindow
  private sceneKey = ''
  private queue: Promise<unknown> = Promise.resolve()
  private idle?: NodeJS.Timeout

  render(
    scene: MotionScene,
    frame: number,
    width: number,
    signal?: AbortSignal,
  ) {
    const next = this.queue.then(async () => {
      signal?.throwIfAborted()
      clearTimeout(this.idle)
      let timeout: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          this.paint(scene, frame, width),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              this.close()
              reject(new Error('动效帧绘制超时，请简化本步绘制。'))
            }, 8000)
          }),
        ])
      } finally {
        clearTimeout(timeout)
        this.idle = setTimeout(() => this.close(), 20000)
      }
    })
    this.queue = next.catch(() => {})
    return next
  }

  close() {
    clearTimeout(this.idle)
    this.sceneKey = ''
    const win = this.window
    this.window = undefined
    if (win && !win.isDestroyed()) win.destroy()
  }

  private async paint(
    scene: MotionScene,
    frame: number,
    width: number,
  ): Promise<Buffer> {
    const height = Math.round((width * 9) / 16)
    if (!this.window || this.window.isDestroyed()) {
      const isolated = session.fromPartition('cutroom-motion-' + randomUUID(), {
        cache: false,
      })
      isolated.setPermissionRequestHandler((_wc, _permission, respond) =>
        respond(false),
      )
      isolated.setPermissionCheckHandler(() => false)
      isolated.setDevicePermissionHandler(() => false)
      isolated.on('will-download', (event) => event.preventDefault())
      isolated.webRequest.onBeforeRequest((request, respond) =>
        respond({
          cancel:
            !request.url.startsWith('data:') && request.url !== 'about:blank',
        }),
      )
      this.window = new BrowserWindow({
        width,
        height,
        useContentSize: true,
        show: false,
        transparent: true,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          backgroundThrottling: false,
          offscreen: true,
          disableDialogs: true,
          webSecurity: true,
        },
      })
      const wc = this.window.webContents
      wc.setAudioMuted(true)
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('will-navigate', (event) => event.preventDefault())
      wc.on('will-frame-navigate', (event) => event.preventDefault())
      wc.on('will-attach-webview', (event) => event.preventDefault())
      wc.debugger.attach()
    }
    const win = this.window
    const wc = win.webContents
    // Hash the authoring source as a draft may reuse its public revision.
    const key = createHash('sha256')
      .update(JSON.stringify([scene.mode, scene.objects, width]))
      .digest('hex')
    if (key !== this.sceneKey) {
      this.sceneKey = ''
      win.setContentSize(width, height)
      await wc.loadURL(blank)
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        // CSS viewport units, media queries, SVG and Canvas see identical
        // design coordinates in thumbnails, the monitor and the final movie.
        width: 1920,
        height: 1080,
        deviceScaleFactor: width / 1920,
        mobile: false,
      })
      await wc.debugger.sendCommand(
        'Emulation.setDefaultBackgroundColorOverride',
        { color: { r: 0, g: 0, b: 0, a: 0 } },
      )
      await wc.executeJavaScript(gsapSource + '\n;void 0')
      await wc.executeJavaScript(
        `(${prepare})(${JSON.stringify(scene.objects)},${JSON.stringify(scene.mode)})`,
      )
      this.sceneKey = key
    }
    await wc.executeJavaScript(`window.drawCutroomFrame(${frame})`)
    const png = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    })) as { data: string }
    return Buffer.from(png.data, 'base64')
  }
}

const thumbnails = new PaintSurface()
const interactive = new PaintSurface()
// New tool calls can preflight while the monitor is still auditioning the previous version.
const validating = new PaintSurface()
// Reuse validated frames in the monitor and filmstrip without running the authoring code twice.
const previews = new Map<string, Promise<Buffer>>()
let previewBytes = 0
const previewSizes = new Map<string, number>()
const exporting = new PaintSurface()

export function closeMotionPainters() {
  interactive.close()
  validating.close()
  thumbnails.close()
  exporting.close()
  previews.clear()
  previewSizes.clear()
  previewBytes = 0
}

export function previewMotionFrame(
  scene: MotionScene,
  frame: number,
  width: number,
  preflight = false,
) {
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    !Number.isSafeInteger(width) ||
    width < 96 ||
    width > 1920
  )
    throw new Error('无效的动效预览范围。')
  const valid = motionSceneSchema.parse(scene)
  const key = createHash('sha256')
    .update(JSON.stringify([valid.mode, valid.objects, frame, width]))
    .digest('hex')
  const previous = previews.get(key)
  if (previous) return previous
  const surface = preflight
    ? validating
    : width <= 320
      ? thumbnails
      : interactive
  const pending = surface.render(valid, frame, width)
  previews.set(key, pending)
  void pending.then(
    (bytes) => {
      if (previews.get(key) !== pending) return
      previewSizes.set(key, bytes.length)
      previewBytes += bytes.length
      while (previewBytes > 32 * 1024 * 1024 || previewSizes.size > 256) {
        const oldest = previewSizes.keys().next().value
        if (oldest === undefined) break
        previewBytes -= previewSizes.get(oldest)!
        previewSizes.delete(oldest)
        previews.delete(oldest)
      }
    },
    () => {
      if (previews.get(key) === pending) previews.delete(key)
    },
  )
  return pending
}

export function exportMotionFrame(
  scene: MotionScene,
  frame: number,
  signal?: AbortSignal,
) {
  return exporting.render(scene, frame, 1920, signal)
}
