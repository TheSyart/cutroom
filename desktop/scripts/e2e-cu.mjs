#!/usr/bin/env node
// Cutroom Electron acceptance runner [--mode=editing|motion|renderer-security]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = (
  process.argv.find((arg) => arg.startsWith('--mode=')) ?? '--mode=editing'
).slice(7)
const supported = ['editing', 'motion', 'renderer-security']
if (!supported.includes(mode))
  throw new Error('Unsupported Cutroom Electron test: ' + mode)
const entry = 'tests/electron/' + mode + '/run.ts'
const bundle = join(desktop, 'out-e2e', mode + '.cjs')
await build({
  entryPoints: [join(desktop, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  external: ['electron', 'playwright-core'],
  sourcemap: 'inline',
  logLevel: 'warning',
})

const home = mkdtempSync(join(tmpdir(), 'cutroom-e2e-'))
const env = { ...process.env, EMPEROR_CONFIG_DIR: home }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(process.execPath, [bundle], {
  cwd: desktop,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
})
const results = []
let buffer = ''
let done = false
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.startsWith('E2E-RESULT ')) {
      const result = JSON.parse(line.slice('E2E-RESULT '.length))
      results.push(result)
      const mark = result.ok ? '✓' : '✗'
      console.log(
        `${mark} [${result.suite}] ${result.name} (${result.ms}ms)${result.ok ? (result.detail === undefined ? '' : ` ${JSON.stringify(result.detail)}`) : ` — ${result.error ?? JSON.stringify(result.detail)}`}`,
      )
    } else if (line === 'E2E-DONE') done = true
  }
})
const timeout = setTimeout(() => {
  console.error('e2e: timed out after 10 minutes')
  child.kill('SIGKILL')
}, 10 * 60_000)
const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
clearTimeout(timeout)
rmSync(home, { recursive: true, force: true })
const failed = results.filter((result) => !result.ok)
console.log(
  `\n${results.length - failed.length}/${results.length} passed (${mode})${done ? '' : ' — harness did not finish'}`,
)
process.exit(failed.length === 0 && done && code === 0 ? 0 : 1)
