import { EmperorError } from '../../errors'
import {
  checkMediaCancelled,
  noSelectedPackets,
  nullOutput,
  printedNumber,
  runMedia,
  streamInput,
  strictDecode,
} from './media-process'

interface SequenceOptions {
  ffmpegPath: string
  path: string
  start: number
  end: number
  fps: 2 | 4 | 8
  signal?: AbortSignal
}

interface FrameSheet {
  bytes: Buffer
  time: number
  /** Source timestamps in reading order, one for each occupied cell. */
  times: number[]
  columns: number
  rows: number
}

const ticksPerSecond = 1_000_000
const cadenceFramesPerPage = 16
const maximumSceneChanges = 3
const multipartBoundary = 'video-sequence'
const mediaTimeoutMs = 60_000

async function sampleTimestamps(
  input: string[],
  trim: string,
  { ffmpegPath, fps, signal }: SequenceOptions,
  startTick: number,
): Promise<number[]> {
  const cadence = ticksPerSecond / fps
  const samples = new Map<number, number>()
  const sceneChanges: Array<{ score: number; before: number; after: number }> =
    []
  let frame: number | null = null
  let previous: number | null = null
  await runMedia(
    ffmpegPath,
    [
      ...input,
      '-vf',
      [
        trim,
        'scale=160:160:force_original_aspect_ratio=decrease:force_divisible_by=2',
        "select='gte(scene,0)'",
        'metadata=mode=print:key=lavfi.scene_score:file=pipe\\\\\\:1',
      ].join(','),
      '-fps_mode',
      'passthrough',
      ...nullOutput,
    ],
    {
      signal,
      timeoutMs: mediaTimeoutMs,
      onLine(line, stream) {
        if (stream !== 'stdout') return
        if (line.startsWith('frame:')) {
          frame = printedNumber(line, '\\bpts:\\s*')
          return
        }
        const score = printedNumber(line, '^lavfi\\.scene_score=')
        if (frame === null || score === null) return
        const slot = Math.floor((frame - startTick) / cadence)
        if (!samples.has(slot)) samples.set(slot, frame)
        if (previous !== null && score >= 0.08) {
          sceneChanges.push({ score, before: previous, after: frame })
          sceneChanges.sort((left, right) => right.score - left.score)
          if (sceneChanges.length > maximumSceneChanges) sceneChanges.pop()
        }
        previous = frame
      },
    },
  ).catch((cause: unknown) => {
    if (!noSelectedPackets(cause)) throw cause
  })
  const ticks = new Set(samples.values())
  for (const { before, after } of sceneChanges) {
    ticks.add(before)
    ticks.add(after)
  }
  if (previous !== null) ticks.add(previous)
  return [...ticks].sort((a, b) => a - b)
}

function parseSheets(output: Buffer, count: number): Buffer[] {
  const boundary = Buffer.from(`--${multipartBoundary}\r\n`)
  const sheets: Buffer[] = []
  let offset = 0
  while (sheets.length < count) {
    if (!output.subarray(offset, offset + boundary.length).equals(boundary))
      break
    const header = offset + boundary.length
    const headerEnd = output.indexOf('\r\n\r\n', header)
    if (headerEnd < 0 || headerEnd - header > 256) break
    const length = Number(
      output
        .toString('ascii', header, headerEnd)
        .match(/^content-length: (\d+)$/im)?.[1],
    )
    const start = headerEnd + 4
    const end = start + length
    if (
      !Number.isSafeInteger(length) ||
      length < 4 ||
      end + 2 > output.length ||
      output.readUInt16BE(start) !== 0xffd8 ||
      output.readUInt16BE(end - 2) !== 0xffd9
    )
      break
    sheets.push(output.subarray(start, end))
    offset = end + 2
  }
  if (sheets.length !== count || !output.subarray(offset).equals(boundary))
    throw new EmperorError('无法读取完整的视频帧图。', 'media_check_failed')
  return sheets
}

export async function readVideoSequence(
  options: SequenceOptions,
): Promise<{ sheets: FrameSheet[]; start: number; end: number }> {
  const { ffmpegPath, path, start, end, fps, signal } = options
  checkMediaCancelled(signal)
  const startTick = Math.round(start * ticksPerSecond)
  const endTick = Math.round(end * ticksPerSecond)
  if (
    ![2, 4, 8].includes(fps) ||
    !Number.isSafeInteger(startTick) ||
    !Number.isSafeInteger(endTick) ||
    start < 0 ||
    endTick <= startTick ||
    endTick - startTick > (cadenceFramesPerPage * ticksPerSecond) / fps
  )
    throw new EmperorError('视频帧时间范围无效。', 'analysis_range_invalid')

  // A common trim and microsecond time base keep both passes on the same
  // source frame timestamps, including footage with variable frame duration.
  const input = [
    ...strictDecode,
    '-v',
    'error',
    '-copyts',
    '-start_at_zero',
    '-ss',
    `${startTick}us`,
    ...streamInput(path),
    '-map',
    '0:V:0',
  ]
  const trim = `settb=AVTB,trim=start_pts=${startTick}:end_pts=${endTick}`
  const timestamps = await sampleTimestamps(input, trim, options, startTick)
  checkMediaCancelled(signal)
  if (!timestamps.length) return { sheets: [], start, end }

  const sheetCount = Math.ceil(timestamps.length / cadenceFramesPerPage)
  const framesPerSheet = Math.ceil(timestamps.length / sheetCount)
  const columns = Math.ceil(Math.sqrt(framesPerSheet))
  const rows = Math.ceil(framesPerSheet / columns)
  const select = timestamps.map((timestamp) => `eq(pts,${timestamp})`).join('+')
  const output = await runMedia(
    ffmpegPath,
    [
      ...input,
      '-vf',
      [
        trim,
        `select='${select}'`,
        "scale=w='max(2,trunc(min(384,384*dar)/2)*2)':h='max(2,trunc(min(384,384/dar)/2)*2)',setsar=1",
        `tile=${columns}x${rows}:nb_frames=${framesPerSheet}:margin=2:padding=2`,
      ].join(','),
      '-fps_mode',
      'passthrough',
      '-c:v',
      'mjpeg',
      '-q:v',
      '3',
      '-f',
      'mpjpeg',
      '-boundary_tag',
      multipartBoundary,
      'pipe:1',
    ],
    { signal, timeoutMs: mediaTimeoutMs },
  )
  checkMediaCancelled(signal)
  const sheets = parseSheets(output, sheetCount).map((bytes, index) => {
    const first = index * framesPerSheet
    const times = timestamps
      .slice(first, first + framesPerSheet)
      .map((timestamp) => timestamp / ticksPerSecond)
    return { bytes, time: times[0]!, times, columns, rows }
  })
  return { sheets, start, end }
}
