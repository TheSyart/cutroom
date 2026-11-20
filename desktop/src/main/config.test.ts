import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { resolveConfig } from './config'

const throwingRead = (): string => {
  throw new Error('ENOENT')
}

describe('resolveConfig', () => {
  it('falls back to defaults when settings.json is unreadable', () => {
    const cfg = resolveConfig({ readFile: throwingRead })
    expect(cfg.configSource).toBe('default')
  })

  it('detects a readable settings.json', () => {
    const readFile = () =>
      JSON.stringify({ webui: { host: '0.0.0.0', port: 9100 } })
    const cfg = resolveConfig({ readFile })
    expect(cfg.configSource).toBe('file')
  })

  it('honors --root and EMPEROR_AGENT_ROOT for runtimeRoot only (settings.json lives under stateRoot)', () => {
    const readFile = throwingRead

    const explicit = resolveConfig({
      argv: ['--root', '/tmp/custom-root'],
      env: { EMPEROR_CONFIG_DIR: '/tmp/custom-state' },
      readFile,
    })
    expect(explicit.runtimeRoot).toBe('/tmp/custom-root')

    const envRoot = resolveConfig({
      env: {
        EMPEROR_AGENT_ROOT: '/tmp/env-root',
        EMPEROR_CONFIG_DIR: '/tmp/custom-state',
      },
      readFile,
    })
    expect(envRoot.runtimeRoot).toBe('/tmp/env-root')
  })

  it('uses packaged default root when no explicit root is provided', () => {
    const cfg = resolveConfig({
      defaultRoot:
        '/Users/me/Library/Application Support/Emperor Agent/runtime',
      env: { EMPEROR_CONFIG_DIR: '/tmp/emperor-config-test-state' },
      readFile: throwingRead,
    })

    expect(cfg.runtimeRoot).toBe(
      '/Users/me/Library/Application Support/Emperor Agent/runtime',
    )
    expect(cfg.runtimeRootSource).toBe('default')
  })

  it('keeps explicit runtime roots ahead of the packaged default root', () => {
    const readFile = throwingRead

    const explicit = resolveConfig({
      argv: ['--root', '/manual'],
      defaultRoot: '/runtime',
      readFile,
    })
    expect(explicit.runtimeRoot).toBe('/manual')
    expect(explicit.runtimeRootSource).toBe('explicit')

    const envRoot = resolveConfig({
      env: { EMPEROR_AGENT_ROOT: '/env' },
      defaultRoot: '/runtime',
      readFile,
    })
    expect(envRoot.runtimeRoot).toBe('/env')
    expect(envRoot.runtimeRootSource).toBe('env')
  })

  it('resolves stateRoot independently of runtimeRoot: EMPEROR_CONFIG_DIR overrides the default', () => {
    const readFile = throwingRead

    const withEnv = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      env: { EMPEROR_CONFIG_DIR: '/manual-state' },
      readFile,
    })
    expect(withEnv.runtimeRoot).toBe('/manual-runtime')
    expect(withEnv.stateRoot).toBe('/manual-state')
    expect(withEnv.stateRootSource).toBe('env')

    // Without either data-directory variable, stateRoot uses the independent
    // Video Edit Agent profile and must not enter Emperor's legacy migration.
    const withoutEnv = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      readFile,
    })
    expect(withoutEnv.stateRootSource).toBe('default')
    expect(withoutEnv.runtimeRoot).toBe('/manual-runtime')
  })

  it('forces packaged runtime resources ahead of argv and environment overrides', () => {
    const cfg = resolveConfig({
      argv: ['--root', '/untrusted-argv'],
      env: {
        EMPEROR_AGENT_ROOT: '/untrusted-env',
        EMPEROR_CONFIG_DIR: '/private-state',
      },
      forcedRuntimeRoot: '/signed/resources/runtime-defaults',
    })

    expect(cfg.runtimeRoot).toBe('/signed/resources/runtime-defaults')
    expect(cfg.runtimeRootSource).toBe('packaged')
    expect(cfg.stateRoot).toBe('/private-state')
  })

  it('reads settings.json from stateRoot, not runtimeRoot', () => {
    const seen: string[] = []
    const readFile = (p: string): string => {
      seen.push(p)
      return JSON.stringify({ webui: { host: '0.0.0.0', port: 9100 } })
    }

    const cfg = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      env: { EMPEROR_CONFIG_DIR: '/manual-state' },
      readFile,
    })

    expect(cfg.configSource).toBe('file')
    expect(seen).toEqual([path.join('/manual-state', 'settings.json')])
  })
})

describe('Video Edit Agent independent profile', () => {
  it('uses a default state root outside Emperor Home', () => {
    const cfg = resolveConfig({ env: {}, readFile: throwingRead })
    expect(cfg.stateRoot).toBe(
      path.join(homedir(), 'Library', 'Application Support', 'Cutroom'),
    )
    expect(cfg.stateRoot).not.toBe(path.join(homedir(), '.emperor'))
    expect(cfg.stateRootSource).toBe('default')
  })

  it('prefers VIDEO_EDIT_AGENT_DATA_DIR and resolves it to an absolute path', () => {
    const cfg = resolveConfig({
      env: {
        VIDEO_EDIT_AGENT_DATA_DIR: 'relative-video-state',
        EMPEROR_CONFIG_DIR: '/tmp/legacy-state',
      },
      readFile: throwingRead,
    })
    expect(cfg.stateRoot).toBe(path.resolve('relative-video-state'))
    expect(cfg.stateRootSource).toBe('env')
  })

  it('keeps EMPEROR_CONFIG_DIR as an isolated-test fallback', () => {
    const cfg = resolveConfig({
      env: { EMPEROR_CONFIG_DIR: '/tmp/legacy-state' },
      readFile: throwingRead,
    })
    expect(cfg.stateRoot).toBe('/tmp/legacy-state')
    expect(cfg.stateRootSource).toBe('env')
  })

  it('prefers VIDEO_EDIT_AGENT_ROOT over the legacy runtime variable', () => {
    const cfg = resolveConfig({
      env: {
        VIDEO_EDIT_AGENT_ROOT: '/video-runtime',
        EMPEROR_AGENT_ROOT: '/legacy-runtime',
        VIDEO_EDIT_AGENT_DATA_DIR: '/video-state',
      },
      readFile: throwingRead,
    })
    expect(cfg.runtimeRoot).toBe('/video-runtime')
    expect(cfg.runtimeRootSource).toBe('env')
  })

  it('keeps --root ahead of both runtime environment variables', () => {
    const cfg = resolveConfig({
      argv: ['--root', '/explicit-runtime'],
      env: {
        VIDEO_EDIT_AGENT_ROOT: '/video-runtime',
        EMPEROR_AGENT_ROOT: '/legacy-runtime',
      },
      readFile: throwingRead,
    })
    expect(cfg.runtimeRoot).toBe('/explicit-runtime')
    expect(cfg.runtimeRootSource).toBe('explicit')
  })

  it('reads settings from the new state root rather than the runtime root', () => {
    const seen: string[] = []
    const cfg = resolveConfig({
      env: {
        VIDEO_EDIT_AGENT_ROOT: '/video-runtime',
        VIDEO_EDIT_AGENT_DATA_DIR: '/video-state',
      },
      readFile: (file) => {
        seen.push(file)
        return '{broken'
      },
    })
    expect(cfg.runtimeRoot).toBe('/video-runtime')
    expect(cfg.stateRoot).toBe('/video-state')
    expect(cfg.configSource).toBe('default')
    expect(seen).toEqual([path.join('/video-state', 'settings.json')])
  })
})

describe('Cutroom profile overrides', () => {
  it('prefers Cutroom variables to both compatibility aliases', () => {
    const cfg = resolveConfig({
      env: {
        CUTROOM_DATA_DIR: '/tmp/new-state',
        CUTROOM_ROOT: '/new-runtime',
        VIDEO_EDIT_AGENT_DATA_DIR: '/tmp/old-state',
        VIDEO_EDIT_AGENT_ROOT: '/old-runtime',
        EMPEROR_CONFIG_DIR: '/tmp/older-state',
        EMPEROR_AGENT_ROOT: '/older-runtime',
      },
      readFile: throwingRead,
    })
    expect(cfg.stateRoot).toBe('/tmp/new-state')
    expect(cfg.runtimeRoot).toBe('/new-runtime')
  })
  it('rejects upstream profile overrides before reading any settings', () => {
    let read = false
    expect(() =>
      resolveConfig({
        env: { EMPEROR_CONFIG_DIR: path.join(homedir(), '.emperor', 'child') },
        readFile: () => {
          read = true
          return '{}'
        },
      }),
    ).toThrow('Emperor')
    expect(read).toBe(false)
  })
})
