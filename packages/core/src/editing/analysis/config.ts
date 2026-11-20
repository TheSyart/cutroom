import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { EmperorError } from '../../errors'
import { isSealedSecret, type SecretSealer } from '../../security/secret-sealer'
import { writeJsonAtomic } from '../../store/atomic-json'

const fields = z
  .object({
    whisperPath: z.string().trim().min(1).max(4096).optional(),
    ffmpegPath: z.string().trim().min(1).max(4096).optional(),
    modelPath: z.string().trim().min(1).max(4096).optional(),
    language: z.enum(['auto', 'zh', 'en']).optional(),
    autoTranscribe: z.boolean().optional(),
    transcriptionProvider: z.enum(['whisper', 'fun-asr']).optional(),
    funAsrHotwords: z
      .array(z.string().trim().min(1).max(128))
      .max(500)
      .optional(),
  })
  .strict()

export const analysisConfigSchema = fields.extend({
  funAsrApiKey: z.string().trim().min(1).max(4096).nullable().optional(),
})
const diskSchema = fields.extend({
  sealedFunAsrKey: z.string().refine(isSealedSecret).optional(),
})
export const FUN_ASR_KEY_CONTEXT = 'video-analysis.fun-asr.beijing.api-key'
export type AnalysisConfig = z.infer<typeof analysisConfigSchema>
export type TranscriptionProvider = 'whisper' | 'fun-asr'
export interface ResolvedAnalysisConfig extends z.infer<typeof fields> {
  language: 'auto' | 'zh' | 'en'
  autoTranscribe: boolean
  transcriptionProvider: TranscriptionProvider
}

export function defaultAnalysisConfig(): ResolvedAnalysisConfig {
  return {
    language: 'zh',
    autoTranscribe: false,
    transcriptionProvider: 'whisper',
  }
}

export class AnalysisConfigStore {
  private pending = Promise.resolve()
  constructor(
    private readonly path: string,
    private readonly sealer?: SecretSealer | null,
  ) {}

  private async disk() {
    try {
      return diskSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new EmperorError('转写设置无法读取。', 'analysis_config_invalid')
    }
  }

  async snapshot() {
    const { sealedFunAsrKey, ...fields } = await this.disk()
    const config = {
      ...defaultAnalysisConfig(),
      ...fields,
    }
    return {
      config,
      funAsrConfigured: Boolean(sealedFunAsrKey && this.sealer?.available),
      openKey: () => {
        if (sealedFunAsrKey && this.sealer) {
          try {
            return this.sealer.open(sealedFunAsrKey, FUN_ASR_KEY_CONTEXT)
          } catch {
            /* Key must be entered again. */
          }
        }
        throw new EmperorError(
          '请在设置中重新填写阿里云北京 API Key。',
          'fun_asr_key_missing',
        )
      },
    }
  }
  async read(): Promise<ResolvedAnalysisConfig> {
    return (await this.snapshot()).config
  }
  write(input: AnalysisConfig): Promise<ResolvedAnalysisConfig> {
    const save = this.pending.then(async () => {
      const { funAsrApiKey, ...rest } = analysisConfigSchema.parse(input)
      const old = await this.disk()
      const sealedFunAsrKey =
        funAsrApiKey === undefined
          ? old.sealedFunAsrKey
          : funAsrApiKey === null
            ? undefined
            : this.sealer?.seal(funAsrApiKey, FUN_ASR_KEY_CONTEXT)
      if (funAsrApiKey && !sealedFunAsrKey)
        throw new EmperorError(
          '本机密钥存储不可用。',
          'secret_store_unavailable',
        )
      // Keep local settings replacement semantics. Preserve cloud selections when an older client saves.
      const next = {
        ...rest,
        language: rest.language ?? 'zh',
        autoTranscribe: rest.autoTranscribe ?? false,
        transcriptionProvider:
          rest.transcriptionProvider ?? old.transcriptionProvider ?? 'whisper',
        funAsrHotwords: rest.funAsrHotwords ?? old.funAsrHotwords,
      }
      await writeJsonAtomic(
        this.path,
        { ...next, sealedFunAsrKey },
        { mode: 0o600 },
      )
      return next
    })
    this.pending = save.then(
      () => {},
      () => {},
    )
    return save
  }
}
