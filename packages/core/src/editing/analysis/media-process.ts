import { spawn } from 'node:child_process'
import { EmperorError } from '../../errors'
import { dirname, join } from 'node:path'
import { findExecutable } from './paths'

export function checkMediaCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new EmperorError('媒体检查已取消。', 'analysis_cancelled')
}

export async function runMedia(
  executable: string,
  args: string[],
  options: {
    signal?: AbortSignal
    timeoutMs: number
    cwd?: string
    onChunk?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  },
): Promise<Buffer> {
  checkMediaCancelled(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let diagnostic = ''
    let failure: Error | undefined
    const stop = (cause: Error) => {
      failure ??= cause
      child.kill('SIGKILL')
    }
    const abort = () =>
      stop(new EmperorError('媒体检查已取消。', 'analysis_cancelled'))
    const timer = setTimeout(
      () => stop(new EmperorError('媒体检查超时。', 'media_check_failed')),
      options.timeoutMs,
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const pending = { stdout: '', stderr: '' }
    const receive = (chunk: Buffer, stream: keyof typeof pending) => {
      if (failure) return
      if (stream === 'stderr')
        diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000)
      if (stream === 'stdout' && !options.onLine && !options.onChunk) {
        bytes += chunk.length
        if (bytes > 8_000_000) {
          stop(new EmperorError('媒体检查输出超出限制。', 'media_check_failed'))
          return
        }
        chunks.push(chunk)
      }
      try {
        options.onChunk?.(chunk, stream)
      } catch (cause) {
        stop(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      if (!options.onLine) return
      const lines = (pending[stream] + chunk.toString('utf8')).split(/[\r\n]+/)
      pending[stream] = (lines.pop() ?? '').slice(-8192)
      try {
        for (const line of lines) options.onLine(line, stream)
      } catch (cause) {
        stop(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, 'stderr'))
    child.on('error', stop)
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new EmperorError(
            diagnostic.trim().split(/\r?\n/).at(-1) || '媒体检查失败。',
            'media_check_failed',
          ),
        )
      else resolve(Buffer.concat(chunks))
    })
  })
}

interface MediaStream {
  codec_type?: string
  codec_name?: string
  avg_frame_rate?: string
  duration?: string
  width?: number
  height?: number
  disposition?: { attached_pic?: number }
}

export interface MediaProbe {
  duration: number | null
  video?: MediaStream
  audio?: MediaStream
}

export async function probeMedia(
  ffmpegPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  const ffprobe = findExecutable(
    'ffprobe',
    join(dirname(ffmpegPath), 'ffprobe'),
  )
  if (!ffprobe) throw new EmperorError('没有找到 ffprobe。', 'ffprobe_missing')
  const output = await runMedia(
    ffprobe,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,avg_frame_rate,duration,width,height:stream_disposition=attached_pic',
      '-of',
      'json',
      file,
    ],
    { signal, timeoutMs: 60_000 },
  )
  const parsed = JSON.parse(output.toString('utf8')) as {
    format?: { duration?: string }
    streams?: MediaStream[]
  }
  const video = parsed.streams?.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  )
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = Math.max(
    ...[parsed.format?.duration, video?.duration, audio?.duration]
      .map(Number)
      .filter(Number.isFinite),
  )
  return { duration: duration > 0 ? duration : null, video, audio }
}

/** FFmpeg 8 reports this when seeking after the last selectable frame with -xerror. */
export function noSelectedPackets(cause: unknown): boolean {
  return (
    cause instanceof EmperorError &&
    /nothing was written .* received no packets/i.test(cause.message)
  )
}

const preciseNumber = '(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)'

export function printedNumber(line: string, key: string): number | null {
  const match = line.match(new RegExp(`${key}${preciseNumber}`))
  return match ? Number(match[1]) : null
}

export interface SignalWindow {
  start: number
  end: number
}

export function signalIntervals(
  name: 'black' | 'silence',
  duration: number,
): { push(line: string): void; values(includeOpen?: boolean): SignalWindow[] } {
  const result: SignalWindow[] = []
  let open: number | null = null
  return {
    push(line) {
      if (!line.includes(`${name}_`)) return
      const start = printedNumber(line, `${name}_start:\\s*`)
      const end = printedNumber(line, `${name}_end:\\s*`)
      if (start !== null) open = Math.max(0, start)
      if (end !== null && open !== null) {
        result.push({
          start: open,
          end: Math.min(duration, end),
        })
        open = null
      }
    },
    values(includeOpen = true) {
      return open === null || !includeOpen
        ? result
        : [...result, { start: open, end: duration }]
    },
  }
}

export const streamInput = (file: string) => [
  '-protocol_whitelist',
  'file,pipe',
  '-i',
  file,
]
export const strictDecode = [
  '-nostdin',
  '-hide_banner',
  '-xerror',
  '-err_detect',
  'explode',
]
export const nullOutput = ['-f', 'null', '-']

// astats runs over the actual decoded samples, with one measured window per fixed sample block.
export function signalStatsFilter(windowSamples: number): string {
  return `asetnsamples=n=${windowSamples}:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+RMS_level,ametadata=mode=print:file=pipe\\\\:1`
}

export function signalStats(
  emit: (time: number, peakDb: number, rmsDb: number) => void,
) {
  let time: number | null = null
  let peak: number | null = null
  let rms: number | null = null
  return (line: string) => {
    if (line.startsWith('frame:')) {
      time = printedNumber(line, 'pts_time:\\s*')
      peak = rms = null
    } else if (line.startsWith('lavfi.astats.Overall.Peak_level=')) {
      peak = printedNumber(line, 'Peak_level=') ?? -120
    } else if (line.startsWith('lavfi.astats.Overall.RMS_level=')) {
      rms = printedNumber(line, 'RMS_level=') ?? -120
    }
    if (time === null || peak === null || rms === null) return
    emit(time, Math.max(-120, peak), Math.max(-120, rms))
    time = null
  }
}
