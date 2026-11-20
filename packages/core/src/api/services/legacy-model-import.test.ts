import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readModelConfigForImport } from '../../config/model-config'
import {
  LocalSecretStore,
  openWithKey,
  sealWithKey,
} from '../../security/local-secret-store'
import { sealerFromSecretStore } from '../../security/secret-sealer'
import { importLegacyDeepSeek } from './legacy-model-import'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function home(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function destinationSealer() {
  const key = randomBytes(32)
  return sealerFromSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value, context) => sealWithKey(key, value, context),
    decryptString: (data, context) => openWithKey(key, data, context),
  })
}

function writeLegacy(
  root: string,
  models: unknown[],
  activeModelId: string | null,
): string {
  const path = join(root, 'model_config.json')
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 2, activeModelId, models }, null, 2),
    { mode: 0o600 },
  )
  return path
}

function deepseek(entryId = 'legacy-deepseek', apiKey = 'sk-legacy') {
  return {
    entryId,
    provider: 'deepseek',
    protocol: 'openai',
    transport: 'chat-completions',
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek',
    apiBase: 'https://api.deepseek.com/v1',
    apiKey,
    contextWindowTokens: 128000,
    maxTokens: 8192,
    reasoningEffort: null,
  }
}

describe('legacy DeepSeek model import', () => {
  it('imports only DeepSeek, re-seals the key and activates the legacy active entry', async () => {
    const legacyHome = home('legacy-import-source-')
    const stateRoot = home('legacy-import-dest-')
    const source = writeLegacy(
      legacyHome,
      [
        deepseek(),
        {
          ...deepseek('other', 'sk-other'),
          provider: 'openai',
          modelId: 'gpt-test',
          apiBase: 'https://api.openai.com/v1',
        },
      ],
      'legacy-deepseek',
    )
    const before = readFileSync(source, 'utf8')
    const sealer = destinationSealer()
    const result = await importLegacyDeepSeek({
      legacyHome,
      stateRoot,
      sealer,
    })
    expect(result.skipped).toBeNull()
    expect(result.imported).toHaveLength(1)
    const imported = await readModelConfigForImport(stateRoot, sealer)
    expect(imported?.models).toHaveLength(1)
    expect(imported?.models[0]).toMatchObject({
      provider: 'deepseek',
      transport: 'chat-completions',
      modelId: 'deepseek-chat',
      apiKey: 'sk-legacy',
    })
    expect(imported?.activeModelId).toBe(imported?.models[0]?.entryId)
    const disk = readFileSync(join(stateRoot, 'model_config.json'), 'utf8')
    expect(disk).toContain('el1:')
    expect(disk).not.toContain('sk-legacy')
    expect(readFileSync(source, 'utf8')).toBe(before)
  })

  it('opens a sealed legacy key with the old home key', async () => {
    const legacyHome = home('legacy-import-sealed-')
    const stateRoot = home('legacy-import-sealed-dest-')
    const oldKey = randomBytes(32)
    const keyDir = join(legacyHome, 'computer-use', 'secrets')
    mkdirSync(keyDir, { recursive: true })
    chmodSync(keyDir, 0o700)
    writeFileSync(join(keyDir, 'local.key'), oldKey, { mode: 0o600 })
    const sealed = `el1:${sealWithKey(
      oldKey,
      'sk-sealed-legacy',
      'model_config.json#models/legacy-deepseek/apiKey',
    ).toString('base64')}`
    writeLegacy(
      legacyHome,
      [deepseek('legacy-deepseek', sealed)],
      'legacy-deepseek',
    )
    const oldSealer = sealerFromSecretStore(
      new LocalSecretStore({ keyPath: join(keyDir, 'local.key') }),
    )
    expect(oldSealer.available).toBe(true)
    expect(
      oldSealer.open(sealed, 'model_config.json#models/legacy-deepseek/apiKey'),
    ).toBe('sk-sealed-legacy')
    const sealer = destinationSealer()
    const result = await importLegacyDeepSeek({
      legacyHome,
      stateRoot,
      sealer,
    })
    expect(result.imported).toHaveLength(1)
    const imported = await readModelConfigForImport(stateRoot, sealer)
    expect(imported?.models[0]?.apiKey).toBe('sk-sealed-legacy')
  })

  it('does not overwrite a profile that already has models', async () => {
    const legacyHome = home('legacy-import-configured-source-')
    const stateRoot = home('legacy-import-configured-dest-')
    writeLegacy(legacyHome, [deepseek()], 'legacy-deepseek')
    writeLegacy(stateRoot, [deepseek('existing', 'sk-existing')], 'existing')
    const result = await importLegacyDeepSeek({
      legacyHome,
      stateRoot,
      sealer: destinationSealer(),
    })
    expect(result).toMatchObject({
      skipped: 'already_configured',
      imported: [],
    })
  })

  it('is idempotent after the marker was written', async () => {
    const legacyHome = home('legacy-import-marker-source-')
    const stateRoot = home('legacy-import-marker-dest-')
    writeLegacy(legacyHome, [deepseek()], 'legacy-deepseek')
    const sealer = destinationSealer()
    await importLegacyDeepSeek({ legacyHome, stateRoot, sealer })
    const second = await importLegacyDeepSeek({ legacyHome, stateRoot, sealer })
    expect(second.skipped).toBe('already_imported')
  })

  it('skips a legacy key that cannot be opened instead of crashing', async () => {
    const legacyHome = home('legacy-import-broken-source-')
    const stateRoot = home('legacy-import-broken-dest-')
    const oldKey = randomBytes(32)
    const keyDir = join(legacyHome, 'computer-use', 'secrets')
    mkdirSync(keyDir, { recursive: true })
    chmodSync(keyDir, 0o700)
    writeFileSync(join(keyDir, 'local.key'), oldKey, { mode: 0o600 })
    const sealed = `el1:${sealWithKey(oldKey, 'sk', 'wrong-context').toString(
      'base64',
    )}`
    writeLegacy(
      legacyHome,
      [deepseek('legacy-deepseek', sealed)],
      'legacy-deepseek',
    )
    const result = await importLegacyDeepSeek({
      legacyHome,
      stateRoot,
      sealer: destinationSealer(),
    })
    expect(result).toMatchObject({ skipped: 'no_deepseek_key', imported: [] })
  })

  it('does nothing when the legacy home has no config', async () => {
    const result = await importLegacyDeepSeek({
      legacyHome: home('legacy-import-missing-source-'),
      stateRoot: home('legacy-import-missing-dest-'),
      sealer: destinationSealer(),
    })
    expect(result).toMatchObject({ skipped: 'legacy_missing', imported: [] })
  })
})
