#!/usr/bin/env node
// The macOS nightly (REL-04, MAIN-29); nightly.yml runs it, and so can you:
//
//   node scripts/ci/nightly.mjs                    every step, report in desktop/dist/nightly-report
//   node scripts/ci/nightly.mjs --list [--json]    the steps, and why some are skipped
//   node scripts/ci/nightly.mjs --only e2e:editing,kill9 [--report <dir>]
//   node scripts/ci/nightly.mjs --skip package
//
// Every step runs even when an earlier one failed; the exit code is 1 when
// any failed. The report directory contains summary.json, report.md and the
// full output for each step in logs/<id>.log.
// scripts/ci/open-failure-issue.mjs turns a failed summary into an issue.
// Editing and motion use local fixtures so nightly runs need no model credentials.
import { spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MINUTE = 60_000

export function nightlyPlan() {
  return [
    {
      id: 'build',
      title: 'Build Cutroom',
      command: ['npm', 'run', 'build'],
      timeoutMs: 20 * MINUTE,
    },
    ...['editing', 'motion'].map((mode) => ({
      id: 'e2e:' + mode,
      title: 'Electron ' + mode,
      command: ['node', 'scripts/e2e-cu.mjs', '--mode=' + mode],
      cwd: 'desktop',
      timeoutMs: 15 * MINUTE,
    })),
    {
      id: 'migration',
      title: 'Open previous Cutroom data',
      command: ['node', 'desktop/tests/electron/migration-smoke/run.mjs'],
      timeoutMs: 5 * MINUTE,
    },
    {
      id: 'kill9',
      title: 'Session log recovery',
      command: ['node', 'scripts/session-log-kill9.mjs', '--runs', '20'],
      timeoutMs: 15 * MINUTE,
    },
    {
      id: 'package',
      title: 'Verify the installed application',
      command: ['npm', '--prefix', 'desktop', 'run', 'package:verify'],
      timeoutMs: 30 * MINUTE,
    },
  ]
}

function parseArgs(argv) {
  const options = {
    list: false,
    json: false,
    only: null,
    skip: [],
    report: null,
    plan: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--list') options.list = true
    else if (arg === '--json') options.json = true
    else if (arg === '--only') options.only = value().split(',').filter(Boolean)
    else if (arg === '--skip') options.skip = value().split(',').filter(Boolean)
    else if (arg === '--report') options.report = resolve(value())
    else if (arg === '--plan') options.plan = resolve(value())
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

function tail(text, max = 4000) {
  return text.length <= max ? text : text.slice(text.length - max)
}

/**
 * Runs the step; one that fails and names a `retry` command runs that once
 * (its output appended to the same log).
 */
async function runStep(step, logPath) {
  const first = await runCommand(step, step.command, logPath, false)
  if (first.exitCode === 0 || !step.retry) return first
  const retry = await runCommand(step, step.retry, logPath, true)
  return {
    ...retry,
    ms: first.ms + retry.ms,
    retried: true,
    firstExitCode: first.exitCode,
  }
}

function runCommand(step, commandLine, logPath, append) {
  return new Promise((done) => {
    const started = Date.now()
    const log = createWriteStream(logPath, { flags: append ? 'a' : 'w' })
    if (append)
      log.write(
        `\nnightly: retrying once (only this step retries): ${commandLine.join(' ')}\n`,
      )
    const env = { ...process.env, FORCE_COLOR: '0' }
    // Electron must run as Electron (desktop-electron-e2e: the inherited
    // ELECTRON_RUN_AS_NODE of a Claude Code or Electron shell breaks it).
    delete env.ELECTRON_RUN_AS_NODE
    const [command, ...args] = commandLine
    const child = spawn(command, args, {
      cwd: step.cwd ? join(repoRoot, step.cwd) : repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const take = (chunk) => {
      const text = chunk.toString('utf8')
      output = tail(output + text, 64_000)
      log.write(text)
      process.stdout.write(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        child.kill('SIGKILL')
      },
      step.timeoutMs ?? 30 * MINUTE,
    )
    const finish = (exitCode, error) => {
      clearTimeout(timer)
      if (error) take(Buffer.from(`\n${error}\n`))
      if (timedOut)
        take(
          Buffer.from(
            `\nnightly: timed out after ${Math.round((step.timeoutMs ?? 30 * MINUTE) / MINUTE)} minutes\n`,
          ),
        )
      log.end()
      done({
        exitCode,
        ms: Date.now() - started,
        logTail: tail(output, 4000),
      })
    }
    child.once('error', (error) => finish(127, String(error)))
    child.once('exit', (code, signal) =>
      finish(code ?? (signal ? 128 : 1), null),
    )
  })
}

function markdown(summary) {
  const rows = summary.steps.map((step) => {
    const seconds =
      step.ms === undefined ? '—' : `${Math.round(step.ms / 1000)} s`
    const exit = step.exitCode === undefined ? '—' : String(step.exitCode)
    const log = 'logs/' + step.id.replace(/[^\w.-]/g, '_') + '.log'
    const note =
      step.reason ??
      (step.status === 'failed'
        ? `${step.retried ? 'failed again on retry; ' : ''}see ${log}`
        : step.retried
          ? `passed on retry (first exit ${step.firstExitCode}); see ${log}`
          : '')
    return `| ${step.id} | ${step.status} | ${exit} | ${note} | ${seconds} |`
  })
  return [
    `# Nightly ${summary.ok ? 'passed' : 'failed'} · ${summary.commit}`,
    '',
    summary.runUrl ? `Run: ${summary.runUrl}` : 'Run: local',
    '',
    '| step | status | exit | note | time |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  // `git rev-parse`, not .git/HEAD: in a worktree .git is a file.
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const commit = (result.stdout || '').trim()
  return /^[0-9a-f]{40}$/.test(commit) ? commit : 'local'
}

async function main(argv) {
  const options = parseArgs(argv)
  let plan = options.plan
    ? JSON.parse(readFileSync(options.plan, 'utf8'))
    : nightlyPlan()
  if (options.list) {
    if (options.json) console.log(JSON.stringify(plan, null, 2))
    else
      for (const step of plan)
        console.log(
          `${step.id.padEnd(22)} ${step.skip ? `skipped: ${step.skip}` : (step.command ?? []).join(' ')}`,
        )
    return 0
  }
  const known = new Set(plan.map((step) => step.id))
  for (const id of [...(options.only ?? []), ...options.skip])
    if (!known.has(id)) throw new Error(`unknown nightly step: ${id}`)
  if (options.only) plan = plan.filter((step) => options.only.includes(step.id))
  plan = plan.filter((step) => !options.skip.includes(step.id))

  const report =
    options.report ?? join(repoRoot, 'desktop', 'dist', 'nightly-report')
  mkdirSync(join(report, 'logs'), { recursive: true })
  const server = process.env.GITHUB_SERVER_URL
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const summary = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    commit: gitCommit(),
    runUrl:
      server && repository && runId
        ? `${server}/${repository}/actions/runs/${runId}`
        : null,
    partial: Boolean(options.only || options.skip.length),
    ok: false,
    steps: [],
  }
  for (const step of plan) {
    if (step.skip || !step.command) {
      console.log(`\n== ${step.id}: skipped (${step.skip ?? 'no command'})`)
      summary.steps.push({
        id: step.id,
        title: step.title,
        status: 'skipped',
        reason: step.skip ?? 'no command',
      })
      continue
    }
    console.log(`\n== ${step.id}: ${step.command.join(' ')}`)
    const logPath = join(
      report,
      'logs',
      `${step.id.replace(/[^\w.-]/g, '_')}.log`,
    )
    const result = await runStep(step, logPath)
    const unavailable =
      Number.isInteger(step.unavailableExitCode) &&
      step.unavailableExitCode !== 0 &&
      step.unavailableExitCode === result.exitCode
    summary.steps.push({
      id: step.id,
      title: step.title,
      status: unavailable
        ? 'skipped'
        : result.exitCode === 0
          ? 'passed'
          : 'failed',
      ...(unavailable
        ? { reason: step.unavailableReason ?? 'check unavailable on this host' }
        : {}),
      exitCode: result.exitCode,
      ms: result.ms,
      ...(result.retried
        ? { retried: true, firstExitCode: result.firstExitCode }
        : {}),
      ...(result.exitCode === 0 ? {} : { logTail: result.logTail }),
    })
    writeFileSync(
      join(report, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
  }
  summary.finishedAt = new Date().toISOString()
  summary.ok = summary.steps.every((step) => step.status !== 'failed')
  writeFileSync(
    join(report, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  writeFileSync(join(report, 'report.md'), markdown(summary))
  const failed = summary.steps.filter((step) => step.status === 'failed')
  console.log(
    `\nnightly ${summary.ok ? 'passed' : 'failed'}: ${summary.steps.filter((s) => s.status === 'passed').length} passed, ${failed.length} failed, ${summary.steps.filter((s) => s.status === 'skipped').length} skipped${failed.length ? ` (${failed.map((s) => s.id).join(', ')})` : ''}`,
  )
  console.log(`report: ${join(report, 'report.md')}`)
  return summary.ok ? 0 : 1
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(
        `nightly: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 2
    },
  )
