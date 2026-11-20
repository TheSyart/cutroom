import { createEditingStaging } from './staging'
import { spawn } from 'node:child_process'
import { link, lstat, realpath, rename, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { EmperorError } from '../errors'
import { logger } from '../util/log'
import { findExecutable } from './analysis/paths'
import { withFilterGraphFile } from './analysis/media-process'
import { renderMotionLayer, type RenderMotionFrame } from './motion-export'
import { timelineLayout, zoomViewport } from './timeline'
import {
  captionAss,
  CAPTION_WIDTH as WIDTH,
  CAPTION_HEIGHT as HEIGHT,
  CAPTION_FPS as FPS,
} from './caption-layout'
import type { VideoProjectResult } from './types'
import { recordWorkspaceOutput } from './workspace-inputs'

export interface RenderVideoOptions {
  destination: string
  ffmpegPath: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  renderMotionFrame?: RenderMotionFrame
  recordWorkspaceOutput?: boolean
}

export interface VideoExportResult {
  path: string
  duration: number
  revision: number
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new EmperorError('导出已取消。', 'export_cancelled')
}

function time(value: number): string {
  return value.toFixed(6)
}

function tempoFilters(speed: number): string[] {
  // Even at 1×, atempo time-stretches small windows and shifts speech transients.
  if (speed === 1) return ['anull']
  if (speed < 0.5) return ['atempo=0.5', `atempo=${speed / 0.5}`]
  if (speed > 2) return ['atempo=2', `atempo=${speed / 2}`]
  return [`atempo=${speed}`]
}

async function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
  onStdout?: (text: string) => void,
): Promise<string> {
  checkCancelled(signal)
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      if (onStdout) onStdout(text)
      else stdout = (stdout + text).slice(-32_768)
    })
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr = (stderr + text).slice(-8_192)
    })
    child.once('error', (cause) => {
      failure = cause
    })
    child.once('close', (code) => {
      if (signal?.aborted)
        reject(new EmperorError('导出已取消。', 'export_cancelled'))
      else if (!failure && code === 0) resolvePromise(stdout)
      else
        reject(
          new EmperorError(
            `视频导出失败。${failure?.message ?? stderr.trim().split('\n').slice(-4).join('\n')}`,
            'export_failed',
          ),
        )
    })
  })
}

async function sourceFile(root: string, path: string): Promise<string> {
  const fullPath = resolve(root, path)
  const target = await realpath(fullPath)
  const rel = relative(root, target)
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    target !== fullPath ||
    !(await lstat(target)).isFile()
  )
    throw new EmperorError(
      '工程素材路径无效，请重新定位素材。',
      'invalid_asset_path',
    )
  return target
}

async function destinationPath(
  snapshot: VideoProjectResult,
  destination: string,
): Promise<{ path: string; identity: string | null }> {
  if (extname(destination).toLowerCase() !== '.mp4')
    throw new EmperorError(
      '请选择 .mp4 文件作为导出位置。',
      'invalid_export_destination',
    )
  const path = join(await realpath(dirname(destination)), basename(destination))
  const target = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'ENOENT') throw cause
    return null
  })
  const root = await realpath(snapshot.projectPath)
  const assets = snapshot.project.assets.map((asset) =>
    resolve(root, asset.path),
  )
  let aliasesAsset = assets.includes(path)
  if (target?.isFile() && !aliasesAsset) {
    for (const asset of assets) {
      const entry = await lstat(asset).catch(() => null)
      if (entry && target.dev === entry.dev && target.ino === entry.ino) {
        aliasesAsset = true
        break
      }
    }
  }
  if ((target && !target.isFile()) || aliasesAsset)
    throw new EmperorError(
      '请选择另一个位置，工程素材不能用作导出目标。',
      'invalid_export_destination',
    )
  const identity = target
    ? [target.dev, target.ino, target.size, target.mtimeMs].join(':')
    : null
  return { path, identity }
}

export async function renderVideoProject(
  snapshot: VideoProjectResult,
  options: RenderVideoOptions,
): Promise<VideoExportResult> {
  const { signal } = options
  checkCancelled(signal)
  const { project } = snapshot
  const layout = timelineLayout(project)
  const scenes = project.motionScenes ?? []
  if (scenes.some((scene) => scene.anchor?.status === 'lost'))
    throw new EmperorError(
      '有动效失去了原声绑定，请重新绑定或删除后再导出。',
      'motion_anchor_lost',
    )
  if (scenes.length && !options.renderMotionFrame)
    throw new EmperorError(
      '当前宿主未提供动效绘制。',
      'motion_renderer_unavailable',
    )
  if (!layout.clips.length && !scenes.length)
    throw new EmperorError('请先添加需要导出的片段。', 'empty_video_project')
  const used = new Set(project.clips.map((clip) => clip.assetId))
  const usedAssets = project.assets.filter((asset) => used.has(asset.id))
  if (snapshot.missingAssetIds?.some((id) => used.has(id)))
    throw new EmperorError(
      '时间线中有离线素材，请重新定位后导出。',
      'asset_missing',
    )
  const ffprobe = findExecutable(
    'ffprobe',
    join(dirname(options.ffmpegPath), 'ffprobe'),
  )
  if (!ffprobe)
    throw new EmperorError(
      '没有找到 ffprobe，请安装包含 ffprobe 的 FFmpeg。',
      'ffprobe_missing',
    )
  const target = await destinationPath(snapshot, options.destination)
  const destination = target.path
  const files = new Map<string, { path: string; audio: boolean }>()
  const audible = new Set(
    project.clips
      .filter((clip) => !clip.muted && clip.volume > 0)
      .map((clip) => clip.assetId),
  )
  const root = await realpath(snapshot.projectPath)
  for (const asset of usedAssets) {
    checkCancelled(signal)
    const path = await sourceFile(root, asset.path).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        throw new EmperorError(
          `素材「${asset.displayName}」已离线。`,
          'asset_missing',
        )
      throw cause
    })
    const audio =
      asset.kind !== 'image' &&
      audible.has(asset.id) &&
      Boolean(
        (
          await run(
            ffprobe,
            [
              '-v',
              'error',
              '-protocol_whitelist',
              'file,pipe',
              '-select_streams',
              'a:0',
              '-show_entries',
              'stream=index',
              '-of',
              'csv=p=0',
              path,
            ],
            signal,
          )
        ).trim(),
      )
    if (asset.kind === 'audio' && audible.has(asset.id) && !audio)
      throw new EmperorError(
        `素材「${asset.displayName}」缺少音频流。`,
        'invalid_audio',
      )
    files.set(asset.id, { path, audio })
  }
  checkCancelled(signal)
  const staging = await createEditingStaging(dirname(destination))
  const temporary = staging.path
  try {
    const inputs: string[] = []
    const filters = [
      `color=0x${project.canvas.background.slice(1)}:${WIDTH}x${HEIGHT}:${FPS}:d=${time(layout.totalDuration)}[picture0]`,
    ]
    const audioChannels: string[] = []
    const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
    for (const [input, entry] of layout.clips.entries()) {
      const clip = project.clips[entry.index]!
      const asset = assets.get(clip.assetId)!
      const file = files.get(asset.id)!
      if (
        asset.kind === 'image' &&
        extname(file.path).toLowerCase() === '.gif'
      ) {
        inputs.push(
          '-stream_loop',
          '-1',
          '-t',
          time(entry.duration),
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          file.path,
        )
      } else if (asset.kind === 'image') {
        inputs.push(
          '-framerate',
          String(FPS),
          '-f',
          'image2',
          '-pattern_type',
          'none',
          '-loop',
          '1',
          '-t',
          time(entry.duration),
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          file.path,
        )
      } else {
        inputs.push(
          '-ss',
          time(clip.sourceIn),
          '-t',
          time(clip.sourceOut - clip.sourceIn),
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          file.path,
        )
      }

      if (asset.kind === 'audio') {
        filters.push(`[picture${input}]null[picture${input + 1}]`)
      } else {
        const width = Math.round((WIDTH * clip.transform.scale) / 2) * 2
        const height = Math.round((HEIGHT * clip.transform.scale) / 2) * 2
        const cover = project.canvas.fit === 'cover'
        const scaling = [
          `scale=${width}:${height}:force_original_aspect_ratio=${cover ? 'increase' : 'decrease'}:force_divisible_by=2`,
          ...(cover ? [`crop=${width}:${height}`] : []),
        ]
        filters.push(
          `[${input}:v]setpts=(PTS-STARTPTS)/${clip.speed},fps=${FPS},${scaling.join(',')},setsar=1,format=yuva420p,settb=AVTB,setpts=PTS+${time(entry.start)}/TB[clip${input}]`,
        )
        const x = time((WIDTH * clip.transform.x) / 100)
        const y = time((HEIGHT * clip.transform.y) / 100)
        filters.push(
          `[picture${input}][clip${input}]overlay=x='(W-w)/2+(${x})':y='(H-h)/2+(${y})':eof_action=repeat:repeatlast=1:enable='gte(t,${time(entry.start)})*lt(t,${time(entry.end)})'[picture${input + 1}]`,
        )
      }
      if (file.audio && !clip.muted && clip.volume > 0) {
        const channel = `[audio${input}]`
        const fades = []
        if (clip.fadeIn)
          fades.push(
            `afade=t=in:d=${time(Math.min(entry.duration, clip.fadeIn))}`,
          )
        if (clip.fadeOut) {
          const length = Math.min(entry.duration, clip.fadeOut)
          fades.push(
            `afade=t=out:st=${time(entry.duration - length)}:d=${time(length)}`,
          )
        }
        filters.push(
          `[${input}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${tempoFilters(clip.speed).join(',')},atrim=end_sample=${Math.round(entry.duration * 48000)},volume=${clip.volume},${fades.length ? fades.join(',') + ',' : ''}adelay=${Math.round(entry.start * 48000)}S:all=1${channel}`,
        )
        audioChannels.push(channel)
      }
    }
    let lastPicture = `[picture${layout.clips.length}]`
    const annotations = project.annotations ?? []
    const overlays = [
      ...annotations.filter((a) => a.kind === 'zoom'),
      ...scenes.map((scene, index) => ({
        kind: 'motion' as const,
        scene,
        index,
      })),
      ...annotations.filter((a) => a.kind === 'box'),
    ]
    const motionFrames = scenes.reduce(
      (total, scene) => total + scene.durationFrames,
      0,
    )
    let finishedFrames = 0
    for (const [i, a] of overlays.entries()) {
      if (a.kind === 'motion') {
        const { scene, index } = a
        const path = join(temporary, `motion-${index}.mov`)
        await renderMotionLayer(
          scene,
          path,
          options.ffmpegPath,
          options.renderMotionFrame!,
          signal,
          (count) =>
            options.onProgress?.(
              Math.floor((65 * (finishedFrames + count)) / motionFrames),
            ),
        )
        finishedFrames += scene.durationFrames
        inputs.push('-protocol_whitelist', 'file,pipe', '-i', path)
        // Align both the alpha stream and the overlay gate to integer project frames.
        const start = scene.startFrame
        const end = start + scene.durationFrames
        filters.push(
          `[${layout.clips.length + index}:v]format=rgba,settb=1/${FPS},setpts=PTS+${start}[motion${index}]`,
          `${lastPicture}[motion${index}]overlay=eof_action=pass:enable='gte(n,${start})*lt(n,${end})'[anno${i}]`,
        )
        lastPicture = `[anno${i}]`
        continue
      }
      const enabled = `enable='gte(t,${time(a.start)})*lt(t,${time(a.end)})'`
      if (a.kind === 'box') {
        filters.push(
          `${lastPicture}drawbox=x=${a.x * WIDTH}:y=${a.y * HEIGHT}:w=${a.width * WIDTH}:h=${a.height * HEIGHT}:color=0x${a.color.slice(1)}:t=5:${enabled}[anno${i}]`,
        )
      } else {
        const v = zoomViewport(a)
        filters.push(
          `${lastPicture}split[base${i}][region${i}]`,
          `[region${i}]crop=${Math.round((WIDTH * v.size) / 2) * 2}:${Math.round((HEIGHT * v.size) / 2) * 2}:${Math.round(WIDTH * v.x)}:${Math.round(HEIGHT * v.y)},scale=${WIDTH}:${HEIGHT},setsar=1[zoom${i}]`,
          `[base${i}][zoom${i}]overlay=0:0:${enabled}[anno${i}]`,
        )
      }
      lastPicture = `[anno${i}]`
    }
    if (layout.subtitles.length) {
      await writeFile(
        join(temporary, 'captions.ass'),
        captionAss(layout.subtitles, project.captionStyle),
      )
      filters.push(
        `${lastPicture}subtitles=filename=captions.ass,format=yuv420p[video]`,
      )
    } else {
      filters.push(`${lastPicture}format=yuv420p[video]`)
    }
    filters.push('anullsrc=r=48000:cl=stereo[silence]')
    filters.push(
      `[silence]${audioChannels.join('')}amix=inputs=${audioChannels.length + 1}:duration=first:normalize=0[audio]`,
    )
    await writeFile(join(temporary, 'filters.txt'), filters.join(';\n'))
    const output = join(temporary, 'output.mp4')
    let progressBuffer = ''
    let lastPercent = -1
    await withFilterGraphFile((option) =>
      run(
        options.ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-filter_complex_threads',
          '2',
          ...inputs,
          option,
          'filters.txt',
          '-map',
          '[video]',
          '-map',
          '[audio]',
          '-t',
          time(layout.totalDuration),
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '19',
          '-pix_fmt',
          'yuv420p',
          '-threads',
          '4',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          output,
        ],
        signal,
        temporary,
        (chunk) => {
          progressBuffer += chunk
          const lines = progressBuffer.split('\n')
          progressBuffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('out_time_us=')) continue
            const timestamp = Number(line.slice('out_time_us='.length))
            if (!Number.isFinite(timestamp)) continue
            const percent = Math.max(
              0,
              Math.min(
                99,
                Math.floor(
                  (motionFrames ? 65 : 0) +
                    ((motionFrames ? 0.35 : 1) * timestamp) /
                      10_000 /
                      layout.totalDuration,
                ),
              ),
            )
            if (percent > lastPercent) options.onProgress?.(percent)
            lastPercent = percent
          }
        },
      ),
    )
    checkCancelled(signal)
    if (!(await lstat(output)).size)
      throw new EmperorError('导出没有生成可用的视频文件。', 'export_failed')
    const finalTarget = await destinationPath(snapshot, destination)
    if (
      finalTarget.path !== target.path ||
      finalTarget.identity !== target.identity
    )
      throw new EmperorError(
        '导出位置在渲染期间发生了变化，请重新选择。',
        'invalid_export_destination',
      )
    checkCancelled(signal)
    if (target.identity === null) await link(output, destination)
    else await rename(output, destination)
  } finally {
    await staging.close()
  }
  if (options.recordWorkspaceOutput) {
    await recordWorkspaceOutput(snapshot, destination).catch(
      (error: unknown) => {
        logger.warn('Video export receipt could not be saved', {
          code: (error as NodeJS.ErrnoException).code,
        })
      },
    )
  }
  options.onProgress?.(100)
  return {
    path: destination,
    duration: layout.totalDuration,
    revision: project.revision,
  }
}
