import { spawnSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Native build directories use Mach-O architecture names, as the Swift
// scripts and `uname -m` do. Keep in sync with macosNativeArch() in
// src/main/dictation/code-signature.ts.
const MACOS_NATIVE_ARCH = { arm64: 'arm64', x64: 'x86_64' }

if (process.platform === 'darwin') {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const arch = MACOS_NATIVE_ARCH[process.arch]
  if (!arch)
    throw new Error(`Unsupported macOS native architecture: ${process.arch}`)
  const assembleDictation = resolve(
    desktop,
    'native/macos/scripts/assemble-dictation-app.sh',
  )
  const dictationBuild = spawnSync('bash', [assembleDictation, arch], {
    stdio: 'inherit',
  })
  if (dictationBuild.status !== 0)
    throw new Error('macOS dictation helper build failed')
  const dictation = resolve(desktop, 'out/native/Emperor Dictation Helper.app')
  // out/native is generated staging. Drop helpers left by older builds.
  rmSync(dirname(dictation), { recursive: true, force: true })
  cpSync(
    resolve(desktop, `native/macos/build/${arch}/Emperor Dictation Helper.app`),
    dictation,
    { recursive: true },
  )
}
