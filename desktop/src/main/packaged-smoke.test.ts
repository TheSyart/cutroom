import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PACKAGED_SMOKE_REFUSED_EXIT,
  packagedSmokeLaunch,
  systemTempRoots,
} from './packaged-smoke'

describe('packaged smoke launch guard (SEC-04, MAIN-28)', () => {
  const smoke = (receipt = path.join(os.tmpdir(), 'emperor-smoke.json')) => [
    'Cutroom',
    '--emperor-packaged-smoke',
    '--emperor-smoke-receipt',
    receipt,
  ]
  const realHome = os.userInfo().homedir

  it('exits 64 (EX_USAGE) when it refuses', () => {
    expect(PACKAGED_SMOKE_REFUSED_EXIT).toBe(64)
  })

  it('does nothing without the smoke flag', () => {
    expect(
      packagedSmokeLaunch(['Cutroom'], {
        stateRoot: path.join(realHome, '.emperor'),
      }),
    ).toEqual({ kind: 'none' })
  })

  it('runs with a state root inside the system temp directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      const receipt = path.join(root, 'receipt.json')
      expect(
        packagedSmokeLaunch(smoke(receipt), {
          stateRoot: path.join(root, 'state'),
        }),
      ).toEqual({ kind: 'run', receiptPath: receipt, scenario: 'fresh' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('7. refuses the real ~/.emperor and any state root outside temp', () => {
    for (const stateRoot of [
      path.join(realHome, '.emperor'),
      path.join(realHome, 'Documents', 'emperor-smoke'),
      '/opt/emperor-state',
    ]) {
      const launch = packagedSmokeLaunch(smoke(), { stateRoot })
      expect(launch).toMatchObject({ kind: 'refuse' })
      expect(
        fs.existsSync(path.join(stateRoot, 'packaged-smoke-workspace')),
      ).toBe(false)
    }
  })

  it('refuses a temp path that leads out of temp through a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      fs.symlinkSync(realHome, path.join(root, 'home'))
      expect(
        packagedSmokeLaunch(smoke(), {
          stateRoot: path.join(root, 'home', '.emperor'),
        }),
      ).toMatchObject({ kind: 'refuse' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses the temp directory itself, the real home inside temp, and a bad receipt', () => {
    const tempRoot = systemTempRoots(process.platform)[0]!
    expect(packagedSmokeLaunch(smoke(), { stateRoot: tempRoot })).toMatchObject(
      { kind: 'refuse' },
    )
    // Even a home under temp: its own ~/.emperor is never a smoke target.
    expect(
      packagedSmokeLaunch(smoke(), {
        stateRoot: path.join(tempRoot, 'someone', '.emperor'),
        userHome: path.join(tempRoot, 'someone'),
      }),
    ).toMatchObject({ kind: 'refuse' })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      for (const argv of [
        ['Cutroom', '--emperor-packaged-smoke'],
        smoke('relative.json'),
      ])
        expect(
          packagedSmokeLaunch(argv, { stateRoot: path.join(root, 'state') }),
        ).toMatchObject({ kind: 'refuse' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('knows the system temp directories of each platform', () => {
    expect(systemTempRoots('darwin')).toEqual([
      '/private/tmp',
      '/private/var/folders',
    ])
    expect(systemTempRoots('linux')).toEqual(['/tmp', '/var/tmp', '/dev/shm'])
  })
})
