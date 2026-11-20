import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { EmperorError } from '../../errors'

const base = 'https://dashscope.aliyuncs.com/api/v1'
const nonempty = z.string().min(1)
const uploadPolicy = z.object({
  data: z.object({
    upload_host: nonempty,
    upload_dir: nonempty,
    oss_access_key_id: nonempty,
    signature: nonempty,
    policy: nonempty,
    x_oss_object_acl: z.literal('private'),
    x_oss_forbid_overwrite: z
      .union([z.enum(['true', 'false']), z.boolean()])
      .transform(String),
  }),
})
const timing = z.object({
  begin_time: z.number().nonnegative(),
  end_time: z.number().nonnegative(),
  text: z.string(),
})
const transcript = z.object({
  transcripts: z.array(
    z.object({
      sentences: z.array(timing.extend({ words: z.array(timing).optional() })),
    }),
  ),
})

function normalized(item: z.infer<typeof timing>) {
  if (item.end_time < item.begin_time) throw new Error('invalid timing')
  return {
    start: item.begin_time / 1000,
    end: item.end_time / 1000,
    text: item.text,
  }
}

function ossUrl(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9-]+\.)?oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(url.hostname)
  )
    throw new Error('invalid OSS endpoint')
  return url
}

export async function transcribeFunAsr(options: {
  wav: string
  apiKey: string
  hotwords?: string[]
  language: 'auto' | 'zh' | 'en'
  signal?: AbortSignal
}) {
  const timeout = AbortSignal.timeout(30 * 60 * 1000)
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout
  const bearer = { Authorization: 'Bearer ' + options.apiKey }
  let stage = '获取临时上传凭证'
  async function request(url: string | URL, init: RequestInit = {}) {
    const response = await fetch(url, { ...init, signal, redirect: 'error' })
    if (!response.ok) {
      if (String(url).startsWith(base + '/')) {
        const reason = (await response.json().catch(() => null)) as {
          code?: string
        } | null
        if (reason?.code === 'Arrearage')
          throw new EmperorError(
            '阿里云拒绝转写请求（Arrearage）。请检查账户余额与服务状态。',
            'fun_asr_account_unavailable',
          )
      }
      throw new EmperorError(
        `阿里云 Fun-ASR ${stage}失败（HTTP ${response.status}）。`,
        'fun_asr_failed',
      )
    }
    return response
  }
  try {
    signal.throwIfAborted()
    const policy = uploadPolicy.parse(
      await (
        await request(base + '/uploads?action=getPolicy&model=fun-asr', {
          headers: bearer,
        })
      ).json(),
    ).data
    stage = '上传音轨'
    const host = ossUrl(policy.upload_host)
    const dir = policy.upload_dir.replace(/\/+$/, '')
    if (
      !/^[a-zA-Z0-9_/-]+$/.test(dir) ||
      dir.startsWith('/') ||
      dir.includes('//')
    )
      throw new Error('invalid directory')
    const key = dir + '/' + randomUUID() + '.wav'
    const form = new FormData()
    for (const [field, value] of Object.entries({
      key,
      OSSAccessKeyId: policy.oss_access_key_id,
      Signature: policy.signature,
      policy: policy.policy,
      'x-oss-object-acl': policy.x_oss_object_acl,
      'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
      success_action_status: '200',
      'x-oss-content-type': 'audio/wav',
    }))
      form.append(field, value)
    form.append(
      'file',
      await openAsBlob(options.wav, { type: 'audio/wav' }),
      'audio.wav',
    )
    await request(host, { method: 'POST', body: form })
    stage = '提交转写'
    const parameters = {
      ...(options.hotwords?.length
        ? {
            vocabulary: Object.fromEntries(
              options.hotwords.map((word) => [word, 5]),
            ),
          }
        : {}),
      ...(options.language !== 'auto'
        ? { language_hints: [options.language] }
        : {}),
    }
    const submission = await request(
      base + '/services/audio/asr/transcription',
      {
        method: 'POST',
        headers: {
          ...bearer,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
          'X-DashScope-OssResourceResolve': 'enable',
        },
        body: JSON.stringify({
          model: 'fun-asr',
          input: { file_urls: ['oss://' + key] },
          parameters,
        }),
      },
    )
    const {
      output: { task_id },
    } = z
      .object({
        output: z.object({ task_id: nonempty.regex(/^[a-zA-Z0-9_-]+$/) }),
      })
      .parse(await submission.json())
    stage = '查询转写任务'
    for (;;) {
      const response = await request(base + '/tasks/' + task_id, {
        headers: bearer,
      })
      const { output } = z
        .object({
          output: z.object({
            task_status: nonempty,
            results: z
              .array(
                z.object({
                  subtask_status: nonempty.optional(),
                  transcription_url: nonempty.optional(),
                }),
              )
              .optional(),
          }),
        })
        .parse(await response.json())
      if (output.task_status === 'SUCCEEDED') {
        const result = output.results?.[0]
        if (
          !result?.transcription_url ||
          (result.subtask_status && result.subtask_status !== 'SUCCEEDED')
        )
          throw new Error('no result')
        stage = '读取转写结果'
        const json = await (
          await request(ossUrl(result.transcription_url))
        ).json()
        const sentences = transcript
          .parse(json)
          .transcripts.flatMap((t) => t.sentences)
        return {
          segments: sentences.map(normalized),
          tokens: sentences.flatMap((s) => (s.words ?? []).map(normalized)),
        }
      }
      if (!['PENDING', 'RUNNING'].includes(output.task_status))
        throw new Error('task terminated')
      await delay(2000, undefined, { signal })
    }
  } catch (cause) {
    if (options.signal?.aborted)
      throw new EmperorError('分析已取消。', 'analysis_cancelled')
    if (timeout.aborted)
      throw new EmperorError('阿里云 Fun-ASR 转写超时。', 'fun_asr_timeout')
    if (cause instanceof EmperorError) throw cause
    throw new EmperorError(`阿里云 Fun-ASR ${stage}失败。`, 'fun_asr_failed')
  }
}
