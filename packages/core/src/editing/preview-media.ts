import { createEditingStaging } from './staging'
import { createHash } from 'node:crypto'
import {
  lstat,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { EditingMediaCache } from './media-cache'
import { EmperorError } from '../errors'
import { probeMedia, runMedia, streamInput } from './analysis/media-process'
import type { VideoAsset } from './types'

export type PreviewMediaKind = 'playback' | 'poster'
const scale = (edge: number) =>
  `scale=w='max(2,trunc(oh*dar/2)*2)':h='max(2,trunc(min(ih,min(${edge},${edge}/dar))/2)*2)',setsar=1`

function outside(root: string, file: string): boolean {
  const path = relative(root, file)
  return !path || path === '..' || path.startsWith('..' + sep)
}

export async function previewSourceIdentity(file: string): Promise<string> {
  const info = await lstat(file)
  if (!info.isFile())
    throw new EmperorError('预览素材不可读取。', 'invalid_asset_path')
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

/** Two background workers at most. Repeated requests for the same artifact share a job. */
export class PreviewMediaCache {
  constructor(private readonly storage: EditingMediaCache) {}

  private readonly jobs = new Map<string, Promise<void>>()
  private readonly tails: Record<PreviewMediaKind, Promise<void>> = {
    playback: Promise.resolve(),
    poster: Promise.resolve(),
  }

  async prepare(
    root: string,
    asset: VideoAsset,
    ffmpeg: string | null,
    kind: PreviewMediaKind,
    force: boolean,
    posterTime = 0,
    posterEnd?: number,
  ): Promise<
    | { path: string; proxy: false }
    | { path: string; proxy: true; signature: string }
  > {
    const audioPoster = kind === 'poster' && asset.kind === 'audio'
    if (asset.kind !== 'video' && !audioPoster)
      return { path: asset.path, proxy: false }
    const source = resolve(root, asset.path)
    if (outside(root, source) || (await realpath(source)) !== source)
      throw new EmperorError('工程素材路径无效。', 'invalid_asset_path')
    const fingerprint = await previewSourceIdentity(source)
    if (!ffmpeg) {
      if (kind === 'playback' && !force)
        return { path: asset.path, proxy: false }
      throw new EmperorError('需要 FFmpeg 来生成兼容预览。', 'ffmpeg_missing')
    }
    if (kind === 'playback' && !force) {
      const { video } = await probeMedia(ffmpeg, source)
      const rate =
        Number(video?.avg_frame_rate?.split('/')[0]) /
        Number(video?.avg_frame_rate?.split('/')[1])
      if (
        video?.codec_name === 'h264' &&
        source.toLowerCase().endsWith('.mp4') &&
        Math.max(video.width ?? 0, video.height ?? 0) <= 1920 &&
        (!Number.isFinite(rate) || rate <= 30.1)
      )
        return { path: asset.path, proxy: false }
    }
    const seek =
      kind === 'poster'
        ? Math.max(0, Math.min(posterTime, asset.duration ?? posterTime))
        : 0
    const waveSeconds = audioPoster
      ? Math.max(
          0.01,
          Math.min(8, (posterEnd ?? asset.duration ?? seek + 8) - seek),
        )
      : 0
    const cache = await this.storage.directory(
      root,
      audioPoster ? 'waveforms' : kind === 'poster' ? 'thumbnails' : 'proxies',
    )
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          'v2',
          fingerprint,
          asset.path,
          kind,
          ...(seek ? [seek] : []),
          ...(waveSeconds ? ['wave', waveSeconds] : []),
        ]),
      )
      .digest('hex')
    const file = join(cache, key + (kind === 'poster' ? '.jpg' : '.mp4'))
    if (!(await this.cached(file))) {
      let job = this.jobs.get(file)
      if (!job) {
        const finish = this.storage.begin(file)
        job = this.tails[kind].then(() =>
          this.build(
            cache,
            file,
            source,
            fingerprint,
            ffmpeg,
            kind,
            seek,
            waveSeconds,
          ),
        )
        job = job.finally(finish)
        this.jobs.set(file, job)
        this.tails[kind] = job.catch(() => undefined)
        void job.finally(() => this.jobs.delete(file)).catch(() => undefined)
      }
      await job
    }
    return { path: file, proxy: true, signature: fingerprint }
  }

  private async cached(file: string): Promise<boolean> {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return Boolean(info?.isFile() && info.size > 0)
  }

  private async build(
    cache: string,
    file: string,
    source: string,
    fingerprint: string,
    ffmpeg: string,
    kind: PreviewMediaKind,
    seek: number,
    waveSeconds: number,
  ) {
    if ((await previewSourceIdentity(source)) !== fingerprint)
      throw new EmperorError(
        '素材已更新，请重新生成预览。',
        'preview_source_changed',
      )
    const staging = await createEditingStaging(cache)
    const work = staging.path
    const poster = kind === 'poster'
    const result = join(work, poster ? 'poster.jpg' : 'proxy.mp4')
    try {
      const transcode = (hardware: boolean) =>
        runMedia(
          ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-threads',
            '2',
            '-filter_threads',
            '2',
            ...(hardware ? ['-hwaccel', 'videotoolbox'] : []),
            ...(seek ? ['-ss', String(seek)] : []),
            ...streamInput(source),
            '-map',
            '0:V:0',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-vf',
            scale(poster ? 360 : 1280),
            ...(poster
              ? ['-frames:v', '1', '-an', '-q:v', '3', '-update', '1']
              : [
                  '-map',
                  '0:a:0?',
                  '-fps_mode',
                  'passthrough',
                  ...(hardware
                    ? [
                        '-c:v',
                        'h264_videotoolbox',
                        '-allow_sw',
                        '0',
                        '-b:v',
                        '3500k',
                      ]
                    : [
                        '-c:v',
                        'libx264',
                        '-threads',
                        '2',
                        '-preset',
                        'ultrafast',
                        '-crf',
                        '23',
                      ]),
                  '-pix_fmt',
                  'yuv420p',
                  '-g',
                  '30',
                  '-force_key_frames',
                  'expr:gte(t,n_forced*0.5)',
                  '-c:a',
                  'aac',
                  '-b:a',
                  '160k',
                  '-movflags',
                  '+faststart',
                ]),
            result,
          ],
          { timeoutMs: poster ? 30_000 : 30 * 60_000 },
        )
      if (waveSeconds) {
        await runMedia(
          ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-ss',
            String(seek),
            '-t',
            String(waveSeconds),
            ...streamInput(source),
            '-filter_complex',
            '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=180x64:scale=sqrt:colors=0x8DB4D4[wave]',
            '-map',
            '[wave]',
            '-frames:v',
            '1',
            '-an',
            '-update',
            '1',
            result,
          ],
          { timeoutMs: 30_000 },
        )
      } else if (!poster && process.platform === 'darwin') {
        try {
          await transcode(true)
        } catch {
          await rm(result, { force: true })
          await transcode(false)
        }
      } else await transcode(false)
      if ((await previewSourceIdentity(source)) !== fingerprint)
        throw new EmperorError(
          '素材已更新，请重新生成预览。',
          'preview_source_changed',
        )
      if (!(await this.cached(result)))
        throw new EmperorError('无法生成兼容预览。', 'preview_unavailable')
      await rename(result, file)
      await this.prune(cache, file).catch(() => undefined)
    } finally {
      await staging.close()
    }
  }

  private async prune(cache: string, recent: string): Promise<void> {
    const names = (await readdir(cache)).filter((name) =>
      /^[a-f0-9]{64}\.(mp4|jpg)$/.test(name),
    )
    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(cache, name)
        return { path, info: await stat(path).catch(() => null) }
      }),
    )
    let bytes = 0
    files.sort((a, b) =>
      a.path === recent
        ? -1
        : b.path === recent
          ? 1
          : (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0),
    )
    for (const [index, { path, info }] of files.entries()) {
      bytes += info?.size ?? 0
      if (
        path !== recent &&
        !this.storage.busy(path) &&
        (index >= 256 || bytes > 2 * 1024 ** 3)
      )
        await unlink(path).catch(() => undefined)
    }
  }
}
