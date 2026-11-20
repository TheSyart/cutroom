#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { verifyMacHardening } = require('./harden-package.cjs')

async function main() {
  const index = process.argv.indexOf('--app')
  const target = index > 0 ? process.argv[index + 1] : undefined
  const architecture = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
  const bundle = resolve(
    target ?? join(__dirname, '..', 'dist', architecture, 'Cutroom.app'),
  )
  const executable = bundle.endsWith('.app')
    ? join(bundle, 'Contents/MacOS/Cutroom')
    : bundle
  const seal = await verifyMacHardening(resolve(executable, '../../..'))
  const state = mkdtempSync(join(tmpdir(), 'cutroom-package-'))
  const receipt = join(state, 'receipt.json')
  const env = { ...process.env, CUTROOM_DATA_DIR: state }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(
    executable,
    ['--emperor-packaged-smoke', '--emperor-smoke-receipt', receipt],
    {
      env,
      timeout: 75000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      'Cutroom smoke failed; logs: ' +
        state +
        '\n' +
        (result.error || result.stderr).toString().slice(-1500),
    )
  const record = JSON.parse(readFileSync(receipt, 'utf8'))
  if (
    !record.home ||
    !record.version ||
    !record.projectId ||
    !(record.operations > 0)
  )
    throw new Error('Incomplete Cutroom smoke receipt in ' + state)
  const bytes = readFileSync(
    resolve(
      executable,
      '../../Resources/runtime-defaults/runtime-manifest.json',
    ),
  )
  const manifest = JSON.parse(bytes)
  const report = {
    schemaVersion: 3,
    appVersion: record.version,
    platform: process.platform,
    arch: process.arch,
    commit: manifest.buildCommit,
    exitCode: 0,
    runtimeRevision: manifest.runtimeRevision,
    runtimeManifestHash: createHash('sha256').update(bytes).digest('hex'),
    operations: {
      renderer: {
        appVersion: record.version,
        home: record.home,
        coreBridge: record.coreBridge,
        nodeGlobalsAbsent: record.nodeGlobalsAbsent,
      },
      editing: { projectId: record.projectId, registered: record.operations },
    },
    package: seal,
  }
  const { assertPackagedSmokeReceipt } =
    await import('../../scripts/packaged-smoke-contract.mjs')
  assertPackagedSmokeReceipt(report, {
    appVersion: manifest.appVersion,
    platform: process.platform,
    arch: process.arch,
    commit: manifest.buildCommit,
  })
  const output = resolve(__dirname, '..', 'dist', 'packaged-smoke')
  mkdirSync(output, { recursive: true })
  const file = join(output, process.platform + '-' + process.arch + '.json')
  const temporary = file + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  })
  renameSync(temporary, file)
  console.log(JSON.stringify({ receipt: file, ...report }, null, 2))
  rmSync(state, { recursive: true, force: true })
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
