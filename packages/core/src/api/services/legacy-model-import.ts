/**
 * One-time import of the original Agent's saved DeepSeek models into the
 * Video Edit Agent profile. The source home is read-only: sealed keys are
 * opened in memory with that home's own local key and re-sealed with the
 * destination profile's sealer. Only DeepSeek entries are copied.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LocalSecretStore } from '../../security/local-secret-store'
import { assertCutroomProfilePath } from '../../runtime/cutroom-profile-paths'
import {
  activateModelEntry,
  readModelConfigForImport,
  saveModelEntries,
  type ImportableModelConfig,
  type ModelEntryDraft,
  type ModelEntryV2,
} from '../../config/model-config'
import {
  localSecretKeyPath,
  sealerFromSecretStore,
  type SecretSealer,
} from '../../security/secret-sealer'

export interface LegacyModelImportInput {
  /** The original Agent Home (`~/.emperor` in the desktop app). */
  legacyHome: string
  /** The new app's state root. */
  stateRoot: string
  /** Sealer of the destination profile. */
  sealer?: SecretSealer | null
  /** Defaults to `<stateRoot>/legacy-model-import.json`. */
  markerPath?: string
}

export interface LegacyModelImportResult {
  imported: string[]
  activeEntryId: string | null
  skipped:
    | null
    | 'already_imported'
    | 'already_configured'
    | 'legacy_missing'
    | 'no_deepseek_key'
}

function markerOf(input: LegacyModelImportInput): string {
  return input.markerPath ?? `${input.stateRoot}/legacy-model-import.json`
}

function keyOf(entry: ModelEntryV2): string {
  return `${entry.protocol}\u0000${entry.apiBase}\u0000${entry.apiKey ?? ''}`
}

function draftOf(entry: ModelEntryV2): ModelEntryDraft {
  return {
    modelId: entry.modelId,
    displayName: entry.displayName ?? entry.modelId,
    contextWindowTokens: entry.contextWindowTokens,
    maxTokens: entry.maxTokens,
    reasoningEffort: entry.reasoningEffort,
    ...(entry.transport === undefined ? {} : { transport: entry.transport }),
    ...(entry.capabilityOverrides === undefined
      ? {}
      : { capabilityOverrides: entry.capabilityOverrides }),
    ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
    ...(entry.limits === undefined ? {} : { limits: entry.limits }),
    ...(entry.sampling === undefined ? {} : { sampling: entry.sampling }),
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    ...(entry.detected === undefined ? {} : { detected: entry.detected }),
  }
}

function groupDeepSeek(
  config: ImportableModelConfig,
): Map<string, ModelEntryV2[]> {
  const groups = new Map<string, ModelEntryV2[]>()
  for (const entry of config.models) {
    if (entry.provider !== 'deepseek') continue
    if (typeof entry.apiKey !== 'string' || entry.apiKey.trim() === '') continue
    const key = keyOf(entry)
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  return groups
}

function writeMarker(
  path: string,
  source: string,
  entryIds: readonly string[],
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        importedAt: new Date().toISOString(),
        source,
        entryIds: [...entryIds],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

export async function importLegacyDeepSeek(
  input: LegacyModelImportInput,
): Promise<LegacyModelImportResult> {
  assertCutroomProfilePath(input.legacyHome)
  const marker = markerOf(input)
  if (existsSync(marker))
    return {
      imported: [],
      activeEntryId: null,
      skipped: 'already_imported',
    }
  if (!input.legacyHome || input.legacyHome === input.stateRoot)
    return { imported: [], activeEntryId: null, skipped: 'legacy_missing' }
  const current = await readModelConfigForImport(input.stateRoot, input.sealer)
  if (current && current.models.length > 0)
    return {
      imported: [],
      activeEntryId: null,
      skipped: 'already_configured',
    }
  const legacy = await readModelConfigForImport(
    input.legacyHome,
    sealerFromSecretStore(
      new LocalSecretStore({
        keyPath: existsSync(localSecretKeyPath(input.legacyHome))
          ? localSecretKeyPath(input.legacyHome)
          : join(input.legacyHome, 'computer-use', 'secrets', 'local.key'),
      }),
    ),
  )
  if (!legacy)
    return { imported: [], activeEntryId: null, skipped: 'legacy_missing' }
  const groups = groupDeepSeek(legacy)
  if (groups.size === 0)
    return { imported: [], activeEntryId: null, skipped: 'no_deepseek_key' }

  const imported: string[] = []
  const byOldId = new Map<string, string>()
  for (const entries of groups.values()) {
    const connection = {
      provider: 'deepseek',
      protocol: entries[0]!.protocol,
      apiBase: entries[0]!.apiBase,
      apiKey: entries[0]!.apiKey,
    }
    const saved = await saveModelEntries(
      input.stateRoot,
      {
        connection,
        entries: entries.map(draftOf),
      },
      { sealer: input.sealer },
    )
    entries.forEach((entry, index) => {
      const id = saved.savedEntryIds[index]
      if (!id) return
      imported.push(id)
      byOldId.set(entry.entryId, id)
    })
  }

  if (imported.length === 0)
    return { imported: [], activeEntryId: null, skipped: 'no_deepseek_key' }

  const activeEntryId =
    (legacy.activeModelId ? byOldId.get(legacy.activeModelId) : undefined) ??
    imported[0]!
  await activateModelEntry(input.stateRoot, activeEntryId, {
    sealer: input.sealer,
  })
  writeMarker(marker, input.legacyHome, imported)
  return { imported, activeEntryId, skipped: null }
}
