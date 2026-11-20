// REL-03 on CoreApi: files a newer Emperor wrote are read-only here — read
// as well as this build can, never rewritten, never quarantined — and
// `storage.versions` names them for 设置 › 高级 › 存储 (card test 2).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp } from './test-helpers'

import { NEWER_FILE_MESSAGE } from '../store/persistence'

const VIEW = { sessionId: null }
const apis: CoreApi[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
})

async function open(stateRoot: string, appVersion?: string): Promise<CoreApi> {
  const { api } = await makeApi({
    root: dirname(stateRoot),
    stateRoot,
    extra: appVersion ? { appVersion } : {},
  })
  apis.push(api)
  return api
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

/** Rewrite `file` as a newer Emperor would: a higher version, a new key. */
function bump(home: string, file: string, key: string, version: number): void {
  const path = join(home, file)
  const value = json(path)
  writeFileSync(
    path,
    `${JSON.stringify({ ...value, [key]: version, futureOnly: { kept: true } }, null, 2)}\n`,
  )
}

function snapshot(home: string, files: string[]) {
  return Object.fromEntries(
    files.map((file) => {
      const path = join(home, file)
      return [
        file,
        { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs },
      ]
    }),
  )
}

/** Siblings an isolation would have left (`*.corrupt-*`, `index.corrupt-*`). */
function quarantined(home: string, files: string[]): string[] {
  return files.flatMap((file) =>
    readdirSync(dirname(join(home, file))).filter((name) =>
      name.includes('corrupt'),
    ),
  )
}

describe('settings.json from a newer Emperor (2)', () => {
  it('is read but never rewritten, and the settings page is told', async () => {
    const root = tmp('emperor-rel03-settings-')
    const home = join(root, 'home')
    const first = await open(home)
    await first.sessions.setDefaults({ permission: 'read-only' }, VIEW)
    await first.close()
    apis.splice(0)

    bump(home, 'settings.json', 'version', 99)
    const before = snapshot(home, ['settings.json'])

    const api = await open(home)
    // What this build understands is still read.
    expect(api.sessions.defaults().permission).toBe('read-only')
    await expect(
      api.sessions.setDefaults({ permission: 'workspace-write' }, VIEW),
    ).rejects.toThrow(NEWER_FILE_MESSAGE)

    expect(snapshot(home, ['settings.json'])).toEqual(before)
    expect(quarantined(home, ['settings.json'])).toEqual([])

    const report = await invokeCoreOperation(api, 'storage.versions', [])
    expect(report.files).toContainEqual(
      expect.objectContaining({
        path: 'settings.json',
        state: 'newer',
        version: 99,
        supported: 1,
      }),
    )
  })
})

describe('storage.versions', () => {
  it('reports the run before this one and a downgrade (3)', async () => {
    const root = tmp('emperor-rel03-downgrade-')
    const home = join(root, 'home')
    await (await open(home, '0.3.0')).close()
    apis.splice(0)
    const api = await open(home, '0.2.0')
    // makeApi bootstraps the home itself (emperorHomePrepared: false).
    const report = await invokeCoreOperation(api, 'storage.versions', [])
    expect(report).toMatchObject({
      appVersion: '0.2.0',
      previousRunVersion: '0.3.0',
      downgradedFrom: '0.3.0',
      dataVersion: 1,
      supportedDataVersion: 1,
    })
    expect(report.files.every((file) => file.state === 'ok')).toBe(true)
  })
})
