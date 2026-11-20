import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApi, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
const roots: string[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('Core startup legacy DeepSeek import', () => {
  it('imports and activates the original Agent’s DeepSeek entry in an empty profile', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'legacy-api-home-'))
    roots.push(legacy)
    writeFileSync(
      join(legacy, 'model_config.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          activeModelId: 'legacy-deepseek',
          models: [
            {
              entryId: 'legacy-deepseek',
              provider: 'deepseek',
              protocol: 'openai',
              modelId: 'deepseek-chat',
              displayName: 'DeepSeek',
              apiBase: 'https://api.deepseek.com/v1',
              apiKey: 'sk-legacy',
              contextWindowTokens: 128000,
              maxTokens: 8192,
              reasoningEffort: null,
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    const fixture = await makeApi({
      extra: { legacyModelHome: legacy },
    })
    fixtures.push(fixture)
    const config = await fixture.api.model.getConfig()
    expect(config.models).toHaveLength(1)
    expect(config.models[0]).toMatchObject({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek',
    })
    expect(config.current?.modelId).toBe('deepseek-chat')
  })
})
