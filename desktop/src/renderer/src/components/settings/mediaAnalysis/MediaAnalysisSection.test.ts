// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaAnalysisSection from './MediaAnalysisSection.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

const defaults = {
  transcriptionProvider: 'whisper',
  autoTranscribe: false,
  language: 'zh',
  modelPath: '/test/model.bin',
}
let config: Record<string, unknown>
let funAsrConfigured: boolean
let app: App

beforeEach(() => {
  config = { ...defaults }
  funAsrConfigured = false
  core.mockImplementation(async (operation, input) => {
    if (operation === 'videoProject.mediaCacheUsage')
      return { bytes: 2048, files: 2 }
    if (operation === 'videoProject.clearMediaCache')
      return {
        bytes: 1024,
        files: 1,
        removedBytes: 1024,
        removedFiles: 1,
        skipped: 1,
      }
    if (operation === 'videoProject.getAnalysisConfig') return config
    if (operation === 'videoProject.analysisStatus')
      return { ...config, funAsrConfigured, ffmpegPath: '/test/ffmpeg' }
    if (operation === 'videoProject.setAnalysisConfig') {
      const { funAsrApiKey, ...settings } = input
      if (funAsrApiKey !== undefined) funAsrConfigured = Boolean(funAsrApiKey)
      config = settings
      return config
    }
    throw new Error(operation)
  })
})

afterEach(() => {
  app.unmount()
  document.body.replaceChildren()
  core.mockReset()
})

async function mount() {
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp(MediaAnalysisSection)
  app.mount(root)
  await flush()
  return root
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function button(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  )
  expect(button).toBeDefined()
  return button!
}

function inputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('media analysis settings', () => {
  it('reports cache usage and the result of a clear that skipped an active file', async () => {
    const root = await mount()
    expect(root.textContent).toContain('2.0 KiB')
    button('清理缓存').click()
    await flush()
    expect(root.textContent).toContain('已清理 1.0 KiB，跳过 1 项')
    expect(root.textContent).toContain('共 1 个文件')
  })
  it('shows a recoverable read failure without reporting unknown tools as missing', async () => {
    core.mockRejectedValueOnce(new Error('服务未连接'))
    const root = await mount()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '服务未连接',
    )
    expect(root.textContent).not.toContain('缺失')
    expect(root.querySelector('[data-testid="analysis-service"]')).toBeNull()
    button('重新读取').click()
    await flush()
    expect(
      root.querySelector('[data-testid="analysis-service"]')?.textContent,
    ).toContain('本地 Whisper')
  })

  it('enables cloud transcription explicitly and permits an explicit offline fallback', async () => {
    const root = await mount()
    expect(root.textContent).toContain('本地 Whisper')
    root.querySelector<HTMLButtonElement>('#analysis-provider')!.click()
    await flush()
    button('阿里云 Fun-ASR').click()
    await flush()
    expect(config.transcriptionProvider).toBe('fun-asr')
    expect(root.textContent).toContain('发送提取的音频')
    expect(root.textContent).toContain('请填写阿里云北京地域的 API Key')
    expect(root.textContent).not.toContain('缺少 whisper-cli')

    root.querySelector<HTMLButtonElement>('#analysis-provider')!.click()
    await flush()
    button('本地 Whisper').click()
    await flush()
    expect(config).toEqual(defaults)
  })

  it('masks the API key, saves it explicitly and removes it without losing local configuration', async () => {
    config.transcriptionProvider = 'fun-asr'
    const root = await mount()
    const input = root.querySelector<HTMLInputElement>('#analysis-fun-asr-key')!
    expect(input.type).toBe('password')
    inputValue(input, ' test-credential ')
    await flush()
    expect(core).not.toHaveBeenCalledWith(
      'videoProject.setAnalysisConfig',
      expect.anything(),
    )
    button('保存密钥').click()
    await flush()
    expect(core).toHaveBeenCalledWith('videoProject.setAnalysisConfig', {
      ...defaults,
      transcriptionProvider: 'fun-asr',
      funAsrApiKey: 'test-credential',
    })
    expect(input.value).toBe('')
    button('移除密钥').click()
    await flush()
    expect(core).toHaveBeenLastCalledWith('videoProject.analysisStatus')
    expect(core).toHaveBeenCalledWith('videoProject.setAnalysisConfig', {
      ...defaults,
      transcriptionProvider: 'fun-asr',
      funAsrApiKey: null,
    })
    expect(root.textContent).toContain('请填写阿里云北京地域的 API Key')
  })

  it('saves comma- and newline-separated hotwords without rewriting the key', async () => {
    config.transcriptionProvider = 'fun-asr'
    funAsrConfigured = true
    const root = await mount()
    const field = root.querySelector<HTMLTextAreaElement>(
      '#analysis-fun-asr-hotwords',
    )!
    inputValue(field, '小单， 剪辑\nFun-ASR, 小单')
    await flush()
    button('保存热词').click()
    await flush()
    expect(core).toHaveBeenCalledWith('videoProject.setAnalysisConfig', {
      ...defaults,
      transcriptionProvider: 'fun-asr',
      funAsrHotwords: ['小单', '剪辑', 'Fun-ASR'],
    })
    expect(funAsrConfigured).toBe(true)
  })
})
