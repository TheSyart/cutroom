import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MOTION_FPS, motionFrameAt, type MotionScene } from './motion'

export type RenderMotionFrame = (
  scene: MotionScene,
  localFrame: number,
  signal?: AbortSignal,
) => Promise<Uint8Array>

/** Encode the alpha layer sequentially. Pipe backpressure bounds memory for long scenes. */
export async function renderMotionLayer(
  scene: MotionScene,
  path: string,
  ffmpeg: string,
  render: RenderMotionFrame,
  signal?: AbortSignal,
  progress?: (completed: number) => void,
): Promise<void> {
  signal?.throwIfAborted()
  const child = spawn(
    ffmpeg,
    [
      '-v',
      'error',
      '-nostdin',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-framerate',
      String(MOTION_FPS),
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'qtrle',
      '-pix_fmt',
      'argb',
      '-y',
      path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], signal },
  )
  let error = ''
  child.stderr.on('data', (chunk) => {
    error = (error + chunk.toString()).slice(-2048)
  })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(error.trim() || '动效图层编码失败。')),
    )
  })
  async function* frames() {
    for (let i = 0; i < scene.durationFrames; i++) {
      signal?.throwIfAborted()
      const local = motionFrameAt(scene, (scene.startFrame + i) / MOTION_FPS)
      if (local === null) throw new Error('请先重新绑定此动效的原声。')
      yield await render(scene, local, signal)
      progress?.(i + 1)
    }
  }
  try {
    await Promise.all([
      done,
      pipeline(Readable.from(frames()), child.stdin, { signal }),
    ])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}
