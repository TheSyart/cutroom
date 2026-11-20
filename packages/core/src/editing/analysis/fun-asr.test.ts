import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalKeySealer } from '../../security/secret-sealer'
import { VideoAnalysisService } from './service'
import { transcribeFunAsr } from './fun-asr'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'video-fun-asr-test-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

const fixtureKey = 'unit-test-fixture-value'
const policy = {
  upload_host: 'https://test.oss-cn-beijing.aliyuncs.com',
  upload_dir: 'dashscope/tmp/test',
  oss_access_key_id: 'temporary',
  signature: 'signature',
  policy: 'policy',
  x_oss_object_acl: 'private',
  x_oss_forbid_overwrite: 'true',
}
const resultUrl =
  'https://result.oss-cn-beijing.aliyuncs.com/text.json?signed=fixture'
function mockApi() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: policy }))
    .mockResolvedValueOnce(new Response(''))
    .mockResolvedValueOnce(
      Response.json({ output: { task_id: 'unit-task-id' } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        output: {
          task_status: 'SUCCEEDED',
          results: [
            { subtask_status: 'SUCCEEDED', transcription_url: resultUrl },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        transcripts: [
          {
            sentences: [
              {
                begin_time: 20,
                end_time: 180,
                text: '北京。',
                words: [
                  {
                    text: '北京',
                    begin_time: 20,
                    end_time: 175,
                    punctuation: '。',
                  },
                ],
              },
            ],
          },
        ],
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it('preserves sealed credentials on omission, clears on null and never returns secrets', async () => {
  const service = new VideoAnalysisService({
    stateRoot: root,
    sealer: createLocalKeySealer(root),
  })
  const config = await service.saveConfig({
    transcriptionProvider: 'fun-asr',
    funAsrApiKey: fixtureKey,
  })
  expect(config).not.toHaveProperty('funAsrApiKey')
  expect(await service.readConfig()).toEqual(config)
  expect(readFileSync(join(root, 'video-analysis.json'), 'utf8')).not.toContain(
    fixtureKey,
  )
  await service.saveConfig({ language: 'en' })
  expect(await service.status()).toMatchObject({
    transcriptionProvider: 'fun-asr',
    funAsrConfigured: true,
  })
  await service.saveConfig({ funAsrApiKey: null })
  expect((await service.status()).funAsrConfigured).toBe(false)
})

it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
  'uploads only the extracted audio, maps real timings and isolates caches by provider and vocabulary',
  async () => {
    const service = new VideoAnalysisService({
      stateRoot: root,
      sealer: createLocalKeySealer(root),
    })
    const asset = {
      id: 'sample',
      path: 'sample.mp4',
      kind: 'video' as const,
      displayName: 'sample',
      duration: 0.2,
      width: 16,
      height: 16,
    }
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=16x16:d=0.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:duration=0.2',
      '-shortest',
      join(root, asset.path),
    ])
    await service.saveConfig({
      funAsrApiKey: fixtureKey,
      transcriptionProvider: 'fun-asr',
      funAsrHotwords: ['北京'],
    })
    const fetcher = mockApi()
    await expect(
      service.transcribe(root, asset, { expectedProvider: 'whisper' }),
    ).rejects.toMatchObject({ code: 'transcription_provider_changed' })
    await expect(
      service.transcribe(root, asset, { cloudAllowed: false }),
    ).rejects.toMatchObject({ code: 'cloud_transcription_disabled' })
    expect(fetcher).not.toHaveBeenCalled()
    const result = await service.transcribe(root, asset, {
      expectedProvider: 'fun-asr',
    })
    expect(result.segments).toEqual([
      { start: 0.02, end: 0.18, text: '北京。' },
    ])
    expect(result.tokens).toEqual([{ start: 0.02, end: 0.175, text: '北京' }])
    const calls = fetcher.mock.calls
    expect(calls.map((c) => new URL(String(c[0])).hostname)).toEqual([
      'dashscope.aliyuncs.com',
      'test.oss-cn-beijing.aliyuncs.com',
      'dashscope.aliyuncs.com',
      'dashscope.aliyuncs.com',
      'result.oss-cn-beijing.aliyuncs.com',
    ])
    expect(
      calls.map((c) => new Headers(c[1]?.headers).get('Authorization')),
    ).toEqual([
      'Bearer ' + fixtureKey,
      null,
      'Bearer ' + fixtureKey,
      'Bearer ' + fixtureKey,
      null,
    ])
    expect(calls.every((c) => c[1]?.redirect === 'error')).toBe(true)
    const upload = calls[1]?.[1]?.body as FormData
    expect(Array.from(upload.keys()).at(-1)).toBe('file')
    expect((upload.get('file') as File).type).toBe('audio/wav')
    expect(upload.get('x-oss-object-acl')).toBe('private')
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({
      model: 'fun-asr',
      input: { file_urls: ['oss://' + upload.get('key')] },
      parameters: { vocabulary: { 北京: 5 } },
    })
    expect((await service.transcribe(root, asset)).cached).toBe(true)
    expect((await service.readTranscript(root, asset))?.tokens).toEqual(
      result.tokens,
    )
    await service.saveConfig({ funAsrHotwords: ['上海'] })
    expect(await service.readTranscript(root, asset)).toBeNull()
    await service.saveConfig({
      funAsrHotwords: ['北京'],
      transcriptionProvider: 'whisper',
    })
    expect(await service.readTranscript(root, asset)).toBeNull()
    await service.saveConfig({ transcriptionProvider: 'fun-asr' })
    expect((await service.transcribe(root, asset)).cached).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(5)
    const copy = join(root, 'copied-project')
    mkdirSync(copy)
    cpSync(join(root, '.cutroom'), join(copy, '.cutroom'), { recursive: true })
    cpSync(join(root, asset.path), join(copy, asset.path))
    expect((await service.transcribe(copy, asset)).cached).toBe(true)
    expect((await service.readTranscript(copy, asset))?.tokens).toEqual(
      result.tokens,
    )
    expect(fetcher).toHaveBeenCalledTimes(5)
    writeFileSync(join(copy, asset.path), 'changed source')
    expect(await service.readTranscript(copy, asset)).toBeNull()
  },
)

it('rejects unsafe upload hosts and redacts network errors', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: { ...policy, upload_host: 'https://evil.example/secret' },
      }),
    )
    .mockRejectedValueOnce(new Error(fixtureKey))
  vi.stubGlobal('fetch', fetcher)
  const input = {
    wav: join(root, 'a.wav'),
    apiKey: fixtureKey,
    language: 'auto' as const,
  }
  writeFileSync(input.wav, 'fixture')
  await expect(transcribeFunAsr(input)).rejects.toMatchObject({
    code: 'fun_asr_failed',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(transcribeFunAsr(input)).rejects.toThrow(
    '阿里云 Fun-ASR 获取临时上传凭证失败。',
  )
  await expect(
    transcribeFunAsr({ ...input, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'analysis_cancelled' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
