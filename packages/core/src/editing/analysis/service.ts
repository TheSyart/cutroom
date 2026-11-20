import { createEditingStaging } from '../staging'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { contentDigest } from '../project-layout'
import { EditingMediaCache } from '../media-cache'
import { EmperorError } from '../../errors'
import { writeJsonAtomic } from '../../store/atomic-json'
import {
  AnalysisConfigStore,
  type AnalysisConfig,
  type ResolvedAnalysisConfig,
} from './config'
import type { SecretSealer } from '../../security/secret-sealer'
import type { TranscriptionProvider } from './config'
import { probeMedia } from './media-process'
import { collectPcmPeaks } from './pcm'
import { findExecutable, findWhisperModel } from './paths'
import type { TranscriptSegment } from './captions'
import type { VideoAsset, VideoProjectResult } from '../types'
import {
  mapEvidenceToTimeline,
  measureSource,
  parseWhisperEvidence,
  type MediaEvidence,
  type TranscriptToken,
} from './evidence'

export interface AnalysisStatus {
  transcriptionProvider: TranscriptionProvider
  funAsrConfigured: boolean
  ffmpegPath: string | null
  whisperPath: string | null
  modelPath: string | null
  ready: boolean
  language: ResolvedAnalysisConfig['language']
  autoTranscribe: boolean
}

export interface AnalysisProgress {
  stage: 'extract-audio' | 'transcribe' | 'frames' | 'cache'
  progress: number
}

export interface TranscriptResult {
  assetId: string
  language: string
  segments: TranscriptSegment[]
  tokens?: TranscriptToken[]
  peaks: number[]
  cached: boolean
  model: string
}

export interface FrameResult {
  time: number
  bytes: Buffer
}

export interface FrameRegion {
  x: number
  y: number
  width: number
  height: number
}

function frameFilter(region?: FrameRegion, fullResolution = false): string {
  if (!region) return fullResolution ? 'null' : "scale='min(960,iw)':-2"
  const { x, y, width, height } = region
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1 ||
    y + height > 1
  )
    error(
      '抽帧裁剪区域必须位于画面内，宽高必须大于零。',
      'frame_region_invalid',
    )
  const crop = `crop=w='max(1,trunc(iw*${width}))':h='max(1,trunc(ih*${height}))':x='trunc(iw*${x})':y='trunc(ih*${y})':exact=1`
  return fullResolution
    ? crop
    : `${crop},scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2`
}

interface RunResult {
  stdout: Buffer
  stderr: string
}

export interface VideoAnalysisServiceOptions {
  stateRoot: string
  mediaCache?: EditingMediaCache
  sealer?: SecretSealer | null
  cloudAllowed?: boolean
  now?: () => Date
}

const transcriptCacheSchema = z
  .object({
    version: z.literal(1),
    assetId: z.string(),
    signature: z.string(),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string(),
    modelSignature: z.string().optional(),
    language: z.string(),
    createdAt: z.string(),
    segments: z.array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      }),
    ),
    peaks: z.array(z.number()).default([]),
    tokens: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          text: z.string(),
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .optional(),
  })
  .strict()

export type TranscriptCache = z.infer<typeof transcriptCacheSchema>

function error(message: string, code: string): never {
  throw new EmperorError(message, code)
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) error('分析已取消。', 'analysis_cancelled')
}

async function fileSignature(path: string): Promise<string> {
  const info = await stat(path)
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

function cacheKey(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export class VideoAnalysisService {
  readonly mediaCache: EditingMediaCache
  readonly config: AnalysisConfigStore
  private readonly digests = new Map<string, Promise<string>>()
  private contentHash(path: string, signature: string) {
    const key = JSON.stringify([path, signature])
    const cached = this.digests.get(key)
    if (cached) return cached
    if (this.digests.size >= 256)
      this.digests.delete(this.digests.keys().next().value!)
    const hash = contentDigest(path).then(async (digest) => {
      if ((await fileSignature(path)) !== signature)
        error('素材已更改，请重试。', 'asset_changed')
      return digest
    })
    this.digests.set(key, hash)
    void hash.catch(() => this.digests.delete(key))
    return hash
  }
  private readonly now: () => Date

  constructor(private readonly options: VideoAnalysisServiceOptions) {
    this.mediaCache =
      options.mediaCache ?? new EditingMediaCache(options.stateRoot)
    this.config = new AnalysisConfigStore(
      join(options.stateRoot, 'video-analysis.json'),
      options.sealer,
    )
    this.now = options.now ?? (() => new Date())
  }

  async readConfig(): Promise<ResolvedAnalysisConfig> {
    return this.config.read()
  }

  async saveConfig(input: AnalysisConfig): Promise<ResolvedAnalysisConfig> {
    return this.config.write(input)
  }

  async status(): Promise<AnalysisStatus> {
    return this.resolveStatus(await this.config.snapshot())
  }

  private resolveStatus({
    config,
    funAsrConfigured,
  }: Awaited<ReturnType<AnalysisConfigStore['snapshot']>>): AnalysisStatus {
    const ffmpegPath = findExecutable('ffmpeg', config.ffmpegPath)
    const whisperPath = findExecutable('whisper-cli', config.whisperPath)
    const modelPath = findWhisperModel(this.options.stateRoot, config.modelPath)
    return {
      ffmpegPath,
      whisperPath,
      modelPath,
      transcriptionProvider: config.transcriptionProvider,
      funAsrConfigured,
      ready: Boolean(
        ffmpegPath &&
        (config.transcriptionProvider === 'fun-asr'
          ? this.options.cloudAllowed !== false && funAsrConfigured
          : whisperPath && modelPath),
      ),
      language: config.language,
      autoTranscribe: config.autoTranscribe,
    }
  }

  async transcribe(
    projectRoot: string,
    asset: VideoAsset,
    options: {
      language?: 'auto' | 'zh' | 'en'
      force?: boolean
      preferTokens?: boolean
      signal?: AbortSignal
      expectedProvider?: TranscriptionProvider
      cloudAllowed?: boolean
    } = {},
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<TranscriptResult> {
    checkCancelled(options.signal)
    if (asset.kind === 'image')
      error('图片没有可以转写的语音。', 'transcription_unsupported')
    const snapshot = await this.config.snapshot()
    const status = this.resolveStatus(snapshot)
    this.checkProvider(status, options)
    const cloud = status.transcriptionProvider === 'fun-asr'

    if (!status.ffmpegPath)
      error('没有找到 ffmpeg，请先安装或在设置中指定路径。', 'ffmpeg_missing')
    if (!cloud && !status.whisperPath)
      error(
        '没有找到 whisper-cli，请先安装 whisper.cpp 或在设置中指定路径。',
        'whisper_missing',
      )
    if (!cloud && !status.modelPath)
      error(
        '没有找到 Whisper 模型，请在设置中选择 ggml-small 等模型文件。',
        'model_missing',
      )
    const model = cloud ? 'fun-asr' : status.modelPath!
    const root = await realpath(projectRoot)
    const assetPath = await realpath(this.insideProject(root, asset.path))
    if (!assetPath.startsWith(root + sep))
      error('素材路径超出了项目目录。', 'invalid_asset_path')
    const hotwords = snapshot.config.funAsrHotwords ?? []
    const [signature, modelSignature] = await Promise.all([
      fileSignature(assetPath),
      cloud ? cacheKey(hotwords) : fileSignature(model),
    ])
    const language = options.language ?? status.language
    const cachePath = await this.transcriptPath(
      projectRoot,
      asset.id,
      true,
      cloud ? modelSignature : undefined,
    )
    checkCancelled(options.signal)
    if (!options.force) {
      const cached = await this.readCache(cachePath)
      if (
        cached &&
        cached.assetId === asset.id &&
        (cached.signature === signature ||
          (cached.contentSha256 &&
            (await this.contentHash(assetPath, signature)) ===
              cached.contentSha256)) &&
        cached.model === model &&
        cached.modelSignature === modelSignature &&
        cached.language === language &&
        (!options.preferTokens || cached.tokens !== undefined)
      )
        return {
          assetId: asset.id,
          language: cached.language,
          segments: cached.segments,
          tokens: cached.tokens,
          peaks: await this.waveform(
            root,
            asset,
            status.ffmpegPath,
            options.signal,
          ),
          cached: true,
          model: cached.model,
        }
    }
    const staging = await createEditingStaging(tmpdir())
    const temporary = staging.path
    const wav = join(temporary, 'audio.wav')
    const output = join(temporary, 'transcript')
    let noAudio = false
    try {
      onProgress?.({ stage: 'extract-audio', progress: 5 })
      await this.run(
        status.ffmpegPath,
        [
          '-y',
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          assetPath,
          '-map',
          '0:a:0',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          '-vn',
          '-ac',
          '1',
          '-af',
          'aresample=16000:async=1:first_pts=0',
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        {
          signal: options.signal,
          failure: 'transcription_failed',
          timeoutMs: 15 * 60 * 1000,
          onStderr: (stderr) => {
            noAudio = /Stream map .*matches no streams/i.test(stderr)
          },
        },
      ).catch((cause: unknown) => {
        checkCancelled(options.signal)
        if (!noAudio) throw cause
      })
      if (noAudio) {
        const cache: TranscriptCache = {
          version: 1,
          assetId: asset.id,
          signature,
          contentSha256: await this.contentHash(assetPath, signature),
          model,
          modelSignature,
          language,
          createdAt: this.now().toISOString(),
          segments: [],
          tokens: [],
          peaks: [],
        }
        checkCancelled(options.signal)
        await writeJsonAtomic(cachePath, cache, { mode: 0o600 })
        return { ...cache, cached: false }
      }
      onProgress?.({ stage: 'transcribe', progress: 10 })
      const recognize = async () => {
        if (cloud) {
          const { transcribeFunAsr } = await import('./fun-asr')
          const updated = await this.config.snapshot()
          this.checkProvider(this.resolveStatus(updated), {
            ...options,
            expectedProvider: 'fun-asr',
          })
          return transcribeFunAsr({
            wav,
            apiKey: updated.openKey(),
            hotwords,
            language,
            signal: options.signal,
          })
        }
        await this.run(
          status.whisperPath!,
          [
            '-m',
            model,
            '-f',
            wav,
            '-l',
            language,
            '-ojf',
            '-of',
            output,
            '-pp',
          ],
          {
            signal: options.signal,
            failure: 'transcription_failed',
            timeoutMs: 15 * 60 * 1000,
            onStderr: (text) => {
              const matches = [...text.matchAll(/progress\s*=\s*(\d+)%/g)]
              const match = matches.at(-1)
              if (match)
                onProgress?.({
                  stage: 'transcribe',
                  progress: Math.min(90, 10 + Number(match[1]) * 0.8),
                })
            },
          },
        )
        return parseWhisperEvidence(
          JSON.parse(await readFile(`${output}.json`, 'utf8')),
        )
      }
      const { segments, tokens } = await recognize()
      const cache: TranscriptCache = {
        version: 1,
        assetId: asset.id,
        signature,
        contentSha256: await this.contentHash(assetPath, signature),
        model,
        modelSignature,
        language,
        createdAt: this.now().toISOString(),
        segments,
        tokens,
        peaks: [],
      }
      checkCancelled(options.signal)
      if ((await fileSignature(assetPath)) !== signature)
        error('素材在转写期间发生了变化，请重试。', 'asset_changed')
      checkCancelled(options.signal)
      await writeJsonAtomic(cachePath, cache, { mode: 0o600 })
      const peaks = await this.waveform(
        root,
        asset,
        status.ffmpegPath,
        options.signal,
      )
      onProgress?.({ stage: 'cache', progress: 95 })
      return {
        assetId: asset.id,
        language,
        segments,
        tokens,
        peaks,
        cached: false,
        model,
      }
    } finally {
      await staging.close()
    }
  }

  private checkProvider(
    status: AnalysisStatus,
    options: {
      expectedProvider?: TranscriptionProvider
      cloudAllowed?: boolean
    },
  ) {
    if (
      options.expectedProvider &&
      options.expectedProvider !== status.transcriptionProvider
    )
      error(
        '转写引擎已更改，请重新开始任务。',
        'transcription_provider_changed',
      )
    if (
      status.transcriptionProvider === 'fun-asr' &&
      (this.options.cloudAllowed === false || options.cloudAllowed === false)
    )
      error('当前任务不允许云端转写。', 'cloud_transcription_disabled')
  }

  async inspectEvidence(
    snapshot: VideoProjectResult,
    asset: VideoAsset,
    options: {
      signal?: AbortSignal
      language?: 'auto' | 'zh' | 'en'
      expectedProvider?: TranscriptionProvider
      cloudAllowed?: boolean
      start?: number
      end?: number
    } = {},
  ): Promise<MediaEvidence> {
    checkCancelled(options.signal)
    if (asset.kind === 'image')
      error('静态图片没有可分析的时间轴。', 'analysis_unsupported')
    const status = await this.status()
    if (!status.ffmpegPath)
      error('没有找到 ffmpeg，请先安装或在设置中指定路径。', 'ffmpeg_missing')
    this.checkProvider(status, options)
    const projectPath = await realpath(snapshot.projectPath)
    const sourcePath = this.insideProject(projectPath, asset.path)
    const path = await realpath(sourcePath)
    if (!path.startsWith(`${projectPath}${sep}`))
      error('素材路径超出了项目目录。', 'invalid_asset_path')
    const signature = await fileSignature(path)
    const result = await measureSource(status.ffmpegPath, path, asset, options)
    let transcription: MediaEvidence['transcription'] = 'unavailable'
    let transcriptionDiagnostic: string | undefined =
      result.audio === 'absent' ? '素材没有音频流。' : undefined
    if (result.audio === 'present') {
      try {
        const transcript = await this.transcribe(
          projectPath,
          { ...asset, path },
          {
            signal: options.signal,
            language: options.language,
            preferTokens: true,
            expectedProvider:
              options.expectedProvider ?? status.transcriptionProvider,
            cloudAllowed: options.cloudAllowed,
          },
        )
        const withinRange = (event: TranscriptSegment) =>
          event.start < result.end && event.end > result.start
        const segments = transcript.segments.filter(withinRange)
        const tokens = (transcript.tokens ?? []).filter(withinRange)
        transcription = tokens.length ? 'token' : 'segment'
        if (!segments.length)
          transcriptionDiagnostic = '该范围未返回带时间戳的语音。'
        for (const segment of segments)
          result.events.push({ kind: 'transcript', ...segment })
        for (const token of tokens)
          result.events.push({ kind: 'token', ...token })
      } catch (cause) {
        checkCancelled(options.signal)
        if (
          cause instanceof EmperorError &&
          [
            'asset_changed',
            'transcription_provider_changed',
            'cloud_transcription_disabled',
            'fun_asr_account_unavailable',
          ].includes(cause.code)
        )
          throw cause
        transcriptionDiagnostic =
          cause instanceof Error ? cause.message : String(cause)
      }
    }
    checkCancelled(options.signal)
    if ((await fileSignature(sourcePath)) !== signature)
      error('素材在分析期间发生了变化，请重试。', 'asset_changed')
    const clips = snapshot.project.clips.filter(
      (clip) => clip.assetId === asset.id,
    )
    return {
      assetId: asset.id,
      start: result.start,
      end: result.end,
      duration: result.duration,
      nextStart:
        result.end < Math.min(result.duration, options.end ?? Infinity)
          ? result.end
          : null,
      audio: result.audio,
      transcription,
      transcriptionDiagnostic,
      events: result.events
        .sort((left, right) => left.start - right.start || left.end - right.end)
        .map((event) => ({
          ...event,
          timeline: mapEvidenceToTimeline(event, clips),
        })),
    }
  }

  private readonly waveformJobs = new Map<string, Promise<number[]>>()

  async waveform(
    projectRoot: string,
    asset: VideoAsset,
    ffmpeg: string | null,
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (!ffmpeg || asset.kind === 'image') return []
    try {
      const root = await realpath(projectRoot)
      const source = this.insideProject(root, asset.path)
      if ((await realpath(source)) !== source) return []
      const identity = await fileSignature(source)
      const directory = await this.mediaCache.directory(root, 'waveforms')
      const file = join(
        directory,
        cacheKey(['peaks-v1', asset.id, identity]) + '.json',
      )
      if ((await lstat(file).catch(() => null))?.isFile()) {
        const data = z
          .array(z.number().min(0).max(1))
          .max(400)
          .safeParse(JSON.parse(await readFile(file, 'utf8')))
        if (data.success) return data.data
      }
      let pending = this.waveformJobs.get(file)
      if (!pending) {
        const finish = this.mediaCache.begin(file)
        pending = (async () => {
          const probe = await probeMedia(ffmpeg, source, signal)
          const values: number[] = []
          if (probe.audio && (probe.duration ?? asset.duration)) {
            const collector = collectPcmPeaks(
              (probe.duration ?? asset.duration)! * 8000,
            )
            await this.run(
              ffmpeg,
              [
                '-v',
                'error',
                '-protocol_whitelist',
                'file,pipe',
                '-i',
                source,
                '-map',
                '0:a:0',
                '-vn',
                '-ac',
                '1',
                '-ar',
                '8000',
                '-f',
                's16le',
                'pipe:1',
              ],
              {
                signal,
                failure: 'waveform_failed',
                timeoutMs: 15 * 60_000,
                onStdout: collector.push,
              },
            )
            values.push(...collector.values())
          }
          if ((await fileSignature(source)) !== identity) return []
          await writeJsonAtomic(file, values, { mode: 0o600, signal })
          return values
        })().finally(() => {
          finish()
          this.waveformJobs.delete(file)
        })
        this.waveformJobs.set(file, pending)
      }
      return await pending
    } catch {
      checkCancelled(signal)
      return []
    }
  }

  async readTranscript(
    projectRoot: string,
    asset: VideoAsset,
    status?: AnalysisStatus,
  ): Promise<TranscriptCache | null> {
    try {
      const snapshot = await this.config.snapshot()
      const current = status ?? this.resolveStatus(snapshot)
      if (
        current.transcriptionProvider !== snapshot.config.transcriptionProvider
      )
        return null
      const cloud = current.transcriptionProvider === 'fun-asr'
      const model = cloud ? 'fun-asr' : current.modelPath
      if (!model) return null
      const cloudSignature = cloud
        ? cacheKey(snapshot.config.funAsrHotwords ?? [])
        : undefined
      const cache = await this.readCache(
        await this.transcriptPath(projectRoot, asset.id, false, cloudSignature),
      )
      if (
        !cache ||
        cache.model !== model ||
        cache.language !== current.language
      )
        return null
      const root = await realpath(projectRoot)
      const source = this.insideProject(root, asset.path)
      if ((await realpath(source)) !== source || cache.assetId !== asset.id)
        return null
      const [signature, modelSignature] = await Promise.all([
        fileSignature(source),
        cloudSignature ?? fileSignature(model),
      ])
      return cache.modelSignature === modelSignature &&
        (cache.signature === signature ||
          (cache.contentSha256 &&
            (await this.contentHash(source, signature)) ===
              cache.contentSha256))
        ? cache
        : null
    } catch {
      return null
    }
  }

  async frames(
    projectRoot: string,
    asset: VideoAsset,
    times: number[],
    signal?: AbortSignal,
    region?: FrameRegion,
    fullResolution = false,
  ): Promise<FrameResult[]> {
    checkCancelled(signal)
    const status = await this.status()
    if (!status.ffmpegPath)
      error('没有找到 ffmpeg，请先安装或在设置中指定路径。', 'ffmpeg_missing')
    if (asset.kind === 'audio')
      error('音频素材没有可提取的画面。', 'frames_unsupported')
    if (asset.kind === 'image' && times.some((time) => time !== 0))
      error('静态图片只支持在零秒提取画面。', 'frame_time_invalid')
    const filter = frameFilter(region, fullResolution)
    const root = await realpath(projectRoot)
    const sourcePath = this.insideProject(root, asset.path)
    const assetPath = await realpath(sourcePath)
    if (!assetPath.startsWith(`${root}${sep}`))
      error('素材路径超出了项目目录。', 'invalid_asset_path')
    const signature = await fileSignature(assetPath)
    const directory = await this.mediaCache.directory(projectRoot, 'frames')
    const result: FrameResult[] = []
    let failure: unknown
    for (const time of [
      ...new Set(times.map((value) => Math.max(0, value))),
    ].slice(0, 6)) {
      checkCancelled(signal)
      const cachePath = join(
        directory,
        `${cacheKey([asset.id, signature, time, ...(region ? [region.x, region.y, region.width, region.height] : []), ...(fullResolution ? ['native'] : [])])}.jpg`,
      )
      try {
        if ((await lstat(cachePath)).isFile()) {
          const bytes = await readFile(cachePath)
          if (bytes.length) {
            result.push({ time, bytes })
            continue
          }
        }
      } catch {
        // Extract below.
      }
      const finish = this.mediaCache.begin(cachePath)
      try {
        const frame = await this.run(
          status.ffmpegPath,
          [
            '-v',
            'error',
            '-ss',
            String(time),
            '-i',
            assetPath,
            '-frames:v',
            '1',
            '-vf',
            filter,
            '-q:v',
            '4',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            'pipe:1',
          ],
          { signal, failure: 'frames_failed', timeoutMs: 60_000 },
        )
        if (!frame.stdout.length) continue
        checkCancelled(signal)
        if ((await fileSignature(sourcePath)) !== signature)
          error('素材在抽帧期间发生了变化，请重试。', 'asset_changed')
        const temporary = `${cachePath}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, frame.stdout, { flag: 'wx', mode: 0o600 })
          checkCancelled(signal)
          await rename(temporary, cachePath)
        } finally {
          await rm(temporary, { force: true })
        }
        result.push({ time, bytes: frame.stdout })
      } catch (cause) {
        checkCancelled(signal)
        if (cause instanceof EmperorError && cause.code === 'asset_changed')
          throw cause
        failure ??= cause
      } finally {
        finish()
      }
    }
    if (!result.length && failure) throw failure
    return result
  }

  private async cacheDirectory(
    root: string,
    folder: 'transcripts',
    create: boolean,
  ): Promise<string> {
    let directory = root
    for (const component of ['.cutroom', 'analysis', folder]) {
      directory = join(directory, component)
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code !== 'EEXIST') throw cause
          },
        )
      }
      if (!(await lstat(directory)).isDirectory())
        error('分析缓存目录不可用。', 'invalid_analysis_path')
    }
    return directory
  }

  private async transcriptPath(
    projectRoot: string,
    assetId: string,
    create = false,
    cloudSignature?: string,
  ): Promise<string> {
    const directory = await this.cacheDirectory(
      projectRoot,
      'transcripts',
      create,
    )
    const filename =
      basename(assetId) === assetId ? assetId : cacheKey([assetId])
    if (cloudSignature)
      return join(
        directory,
        `fun-asr.${cacheKey([assetId, cloudSignature])}.cache.json`,
      )
    return join(directory, `${filename}.json`)
  }

  private async readCache(path: string): Promise<TranscriptCache | null> {
    try {
      if (!(await lstat(path)).isFile()) return null
      const parsed = transcriptCacheSchema.safeParse(
        JSON.parse(await readFile(path, 'utf8')),
      )
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private insideProject(projectRoot: string, relativePath: string): string {
    const root = resolve(projectRoot)
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(`${root}${sep}`))
      error('素材路径超出了项目目录。', 'invalid_asset_path')
    return target
  }

  private run(
    bin: string,
    args: string[],
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      failure: string
      onStderr?: (text: string) => void
      onStdout?: (chunk: Buffer) => void
    },
  ): Promise<RunResult> {
    checkCancelled(options.signal)
    return new Promise((resolvePromise, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let settled = false
      const finish = (failure: Error | null, result?: RunResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (failure) reject(failure)
        else resolvePromise(result!)
      }
      const abort = () => {
        child.kill('SIGTERM')
        finish(new EmperorError('分析已取消。', 'analysis_cancelled'))
      }
      const timer = options.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGTERM')
            finish(new EmperorError('分析超时。', options.failure))
          }, options.timeoutMs)
        : null
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        if (options.onStdout) {
          options.onStdout(chunk)
        } else if (stdoutBytes + chunk.length <= 16_000_000) {
          chunks.push(chunk)
          stdoutBytes += chunk.length
        } else {
          child.kill('SIGTERM')
          finish(new EmperorError('分析工具输出超出限制。', options.failure))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-200_000)
        options.onStderr?.(stderr)
      })
      child.on('error', (cause) =>
        finish(
          new EmperorError(
            `无法启动分析工具：${cause.message}`,
            options.failure,
          ),
        ),
      )
      child.on('close', (code) => {
        if (code === 0) finish(null, { stdout: Buffer.concat(chunks), stderr })
        else
          finish(
            new EmperorError(
              stderr.trim().split('\n').at(-1) ||
                `分析工具退出码 ${code ?? '未知'}`,
              options.failure,
            ),
          )
      })
    })
  }
}
