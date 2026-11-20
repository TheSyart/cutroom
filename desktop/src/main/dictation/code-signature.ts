import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
export interface SignatureSystem {
  execFile(
    file: string,
    args: readonly string[],
    options?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>
}
const nodeSystem: SignatureSystem = {
  execFile: (file, args, options) =>
    run(file, [...args], { ...options, encoding: 'utf8' }),
}
export function macosNativeArch(arch: string) {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64'
  throw new Error('Unsupported macOS dictation architecture')
}
export async function signedIdentity(
  path: string,
  system: SignatureSystem = nodeSystem,
) {
  try {
    await system.execFile(
      '/usr/bin/codesign',
      ['--verify', '--strict', '--', path],
      { timeout: 10_000 },
    )
    const { stderr } = await system.execFile(
      '/usr/bin/codesign',
      ['--display', '--verbose=4', '--', path],
      { timeout: 10_000 },
    )
    const identifier = /^Identifier=(.+)$/m.exec(stderr)?.[1]
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1] ?? null
    const cdHash = /^CDHash=([a-fA-F0-9]{40})$/m.exec(stderr)?.[1]
    const adHoc =
      /^CodeDirectory\b[^\n]*flags=0x[0-9a-f]+\([^\n]*\badhoc\b/m.test(stderr)
    const runtime =
      /^CodeDirectory\b[^\n]*flags=0x[0-9a-f]+\([^\n]*\bruntime\b/m.test(stderr)
    if (!identifier || !cdHash || (adHoc ? team !== null : team === null))
      throw new Error('Incomplete code signature')
    return { identifier, team, cdHash: cdHash.toLowerCase(), adHoc, runtime }
  } catch {
    throw new Error('Invalid app or dictation helper signature')
  }
}
