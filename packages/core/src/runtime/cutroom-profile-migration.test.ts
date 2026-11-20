import * as fs from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelApiKeyContext } from '../config/model-config'
import { AnalysisConfigStore } from '../editing/analysis/config'
import { LocalSecretStore } from '../security/local-secret-store'
import {
  createLocalKeySealer,
  localSecretKeyPath,
  sealerFromSecretStore,
} from '../security/secret-sealer'
import { migrateCutroomProfile } from './cutroom-profile-migration'
import {
  assertCutroomProfilePath,
  cutroomProfilePaths,
} from './cutroom-profile-paths'

let home: string, source: string, target: string
function file(root: string, name: string, content: string | Buffer) {
  const path = join(root, name)
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, content, { mode: 0o600 })
}
function oldKey() {
  return join(source, 'computer-use', 'secrets', 'local.key')
}
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'cutroom-profile-test-'))
  const paths = cutroomProfilePaths(home)
  source = paths.previous
  target = paths.current
  fs.mkdirSync(source, { recursive: true, mode: 0o700 })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('Cutroom macOS profile migration', () => {
  it('opens both sealed credentials with the copied key and retains editing state', async () => {
    const old = sealerFromSecretStore(
      new LocalSecretStore({ keyPath: oldKey() }),
    )
    const model = old.seal('fixture-model-key', modelApiKeyContext('local'))
    file(
      source,
      'model_config.json',
      JSON.stringify({ models: [{ entryId: 'local', apiKey: model }] }),
    )
    const asr = new AnalysisConfigStore(
      join(source, 'video-analysis.json'),
      old,
    )
    const whisper = 'media/whisper/ggml-small.bin'
    await asr.write({
      funAsrApiKey: 'fixture-asr-key',
      modelPath: join(source, whisper),
    })
    const payloads = {
      'sessions/a/events.jsonl': '{"message":"saved"}\n',
      'memory/attachments/2026-11/a.png': 'attachment',
      'memory/desktop/window.json': '{"x":100}',
      'tokens/tokens.jsonl': '{"tokens":1}\n',
      'skills/one/SKILL.md': 'saved skill',
      'workspace/剪辑参考.txt': '用户保存在默认工作目录的文件',
      'projects/index.json': '[{"path":"/external/video"}]',
      'precision-run.key': 'c3'.repeat(32),
      'electron-user-data/Local Storage/leveldb/000003.log':
        'video-edit-agent:recent-projects\0emperor.theme\0dark',
      [whisper]: Buffer.from([0, 255, 1, 0]),
    }
    for (const [name, value] of Object.entries(payloads))
      file(source, name, value)
    file(source, 'browser/Cookies', 'unused')
    const beforeConfig = fs.readFileSync(join(source, 'video-analysis.json'))
    migrateCutroomProfile(target, source)
    const migrated = createLocalKeySealer(target)
    expect(migrated.open(model, modelApiKeyContext('local'))).toBe(
      'fixture-model-key',
    )
    const snapshot = await new AnalysisConfigStore(
      join(target, 'video-analysis.json'),
      migrated,
    ).snapshot()
    expect(snapshot.openKey()).toBe('fixture-asr-key')
    expect(snapshot.config.modelPath).toBe(join(target, whisper))
    expect(fs.readFileSync(join(source, 'video-analysis.json'))).toEqual(
      beforeConfig,
    )
    expect(fs.readFileSync(localSecretKeyPath(target))).toEqual(
      fs.readFileSync(oldKey()),
    )
    expect(fs.statSync(localSecretKeyPath(target)).mode & 0o777).toBe(0o600)
    for (const name of Object.keys(payloads))
      expect(fs.readFileSync(join(target, name))).toEqual(
        fs.readFileSync(join(source, name)),
      )
    expect(fs.existsSync(join(target, 'computer-use'))).toBe(false)
    expect(fs.existsSync(join(target, 'browser'))).toBe(false)
    file(target, 'sessions/a/events.jsonl', 'new session data')
    migrateCutroomProfile(target, source)
    expect(
      fs.readFileSync(join(target, 'sessions/a/events.jsonl'), 'utf8'),
    ).toBe('new session data')
  })

  it('retries a failed snapshot after a missing old key becomes available', () => {
    const old = sealerFromSecretStore(
      new LocalSecretStore({ keyPath: oldKey() }),
    )
    file(
      source,
      'model_config.json',
      JSON.stringify({
        models: [
          { entryId: 'id', apiKey: old.seal('test', modelApiKeyContext('id')) },
        ],
      }),
    )
    fs.renameSync(oldKey(), oldKey() + '.saved')
    expect(() => migrateCutroomProfile(target, source)).toThrow()
    expect(fs.existsSync(target)).toBe(false)
    const stage = join(
      dirname(target),
      '.Cutroom.profile-migration-v1',
      'profile',
    )
    file(stage, 'partial-unverified-file', 'ignore this')
    fs.renameSync(oldKey() + '.saved', oldKey())
    migrateCutroomProfile(target, source)
    expect(fs.existsSync(join(target, 'partial-unverified-file'))).toBe(false)
    expect(fs.existsSync(dirname(stage))).toBe(false)
  })

  it('refuses user data collisions and does not claim an unmarked staging folder', () => {
    file(source, 'settings.json', 'old')
    file(target, 'settings.json', 'new')
    expect(() => migrateCutroomProfile(target, source)).toThrow('两个配置目录')
    expect(fs.readFileSync(join(target, 'settings.json'), 'utf8')).toBe('new')
    fs.rmSync(target, { recursive: true })
    const work = join(dirname(target), '.Cutroom.profile-migration-v1')
    file(work, 'keep.me', 'custom')
    expect(() => migrateCutroomProfile(target, source)).toThrow('其他数据')
    expect(fs.readFileSync(join(work, 'keep.me'), 'utf8')).toBe('custom')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('waits for the old SQLite writer even when a destination directory already exists', () => {
    fs.mkdirSync(target)
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite')
    const db = new DatabaseSync(
      join(dirname(source), '.Video Edit Agent.emperor-writer.sqlite'),
    )
    try {
      db.exec('BEGIN EXCLUSIVE')
      expect(() => migrateCutroomProfile(target, source)).toThrow(
        'already in use',
      )
      expect(fs.readdirSync(target)).toEqual([])
    } finally {
      db.close()
    }
    migrateCutroomProfile(target, source)
    expect(fs.existsSync(join(target, '.cutroom-profile-v1.json'))).toBe(true)
  })

  it('checks Chromium ownership and refuses links into an unrelated profile', () => {
    const chromium = join(source, 'electron-user-data')
    fs.mkdirSync(chromium)
    fs.symlinkSync(
      `${hostname()}-${process.pid}`,
      join(chromium, 'SingletonLock'),
    )
    expect(() => migrateCutroomProfile(target, source)).toThrow('仍在使用')
    fs.unlinkSync(join(chromium, 'SingletonLock'))
    file(home, '.emperor/secret', 'unchanged')
    fs.symlinkSync(join(home, '.emperor'), join(chromium, 'Local Storage'))
    expect(() => migrateCutroomProfile(target, source)).toThrow('符号链接')
    fs.symlinkSync(join(home, '.emperor'), join(home, 'alias'))
    expect(() =>
      assertCutroomProfilePath(join(home, 'alias', 'not-created'), [home]),
    ).toThrow('Emperor')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readdirSync(join(home, '.emperor'))).toEqual(['secret'])
  })

  it('upgrades only the local key within an explicitly selected trial profile', () => {
    const old = sealerFromSecretStore(
      new LocalSecretStore({ keyPath: oldKey() }),
    )
    const value = old.seal('saved token', 'test')
    migrateCutroomProfile(source, null)
    expect(createLocalKeySealer(source).open(value, 'test')).toBe('saved token')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(oldKey())).toBe(true)
  })
})
