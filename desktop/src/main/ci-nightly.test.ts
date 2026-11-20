// REL-04 tests 3 and 4: the nightly runs every mode that needs no real
// model, keeps going after a failure, and a failure opens (dry-run) an issue.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const nightly = path.join(repoRoot, 'scripts', 'ci', 'nightly.mjs')
const opener = path.join(repoRoot, 'scripts', 'ci', 'open-failure-issue.mjs')

function node(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

const tempDir = (prefix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix))

interface PlannedStep {
  id: string
  command?: string[]
  cwd?: string
  skip?: string
  hook?: string
  retry?: string[]
  unavailableExitCode?: number
  unavailableReason?: string
}

describe('the nightly plan (REL-04 test 3)', () => {
  const plan = (): PlannedStep[] =>
    JSON.parse(node(nightly, ['--list', '--json']).stdout)

  it('tests editing, rendering, migration, logs and the installed app', () => {
    expect(plan().map((step) => step.id)).toEqual([
      'build',
      'e2e:editing',
      'e2e:motion',
      'migration',
      'kill9',
      'package',
    ])
  })
})

describe('the nightly runner', () => {
  function runPlan(steps: PlannedStep[], extra: string[] = []) {
    const dir = tempDir('emperor-nightly-')
    const planFile = path.join(dir, 'plan.json')
    fs.writeFileSync(planFile, JSON.stringify(steps))
    const report = path.join(dir, 'report')
    const result = node(
      nightly,
      ['--plan', planFile, '--report', report, ...extra],
      {
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'TheSyart/emperor-agent',
        GITHUB_RUN_ID: '42',
        GITHUB_SHA: 'd'.repeat(40),
      },
    )
    const summary = fs.existsSync(path.join(report, 'summary.json'))
      ? JSON.parse(fs.readFileSync(path.join(report, 'summary.json'), 'utf8'))
      : null
    return { result, summary, report }
  }

  it('keeps going after a failed step, then fails with a summary', () => {
    const { result, summary, report } = runPlan([
      { id: 'first', command: ['node', '-e', 'console.log("one")'] },
      {
        id: 'broken',
        command: ['node', '-e', 'console.error("boom"); process.exit(3)'],
      },
      { id: 'skipped', skip: 'needs a real model' },
      { id: 'last', command: ['node', '-e', 'console.log("three")'] },
    ])
    expect(result.status).toBe(1)
    expect(summary).toMatchObject({
      ok: false,
      commit: 'd'.repeat(40),
      runUrl: 'https://github.com/TheSyart/emperor-agent/actions/runs/42',
      steps: [
        { id: 'first', status: 'passed', exitCode: 0 },
        { id: 'broken', status: 'failed', exitCode: 3 },
        { id: 'skipped', status: 'skipped', reason: 'needs a real model' },
        { id: 'last', status: 'passed', exitCode: 0 },
      ],
    })
    expect(summary.steps[1].logTail).toContain('boom')
    expect(
      fs.readFileSync(path.join(report, 'logs', 'broken.log'), 'utf8'),
    ).toContain('boom')
    const markdown = fs.readFileSync(path.join(report, 'report.md'), 'utf8')
    expect(markdown).toContain('| broken | failed | 3 |')
    expect(markdown).toContain('| skipped | skipped | — | needs a real model |')
  })

  it('passes when every step passes or is skipped', () => {
    const { result, summary } = runPlan([
      { id: 'one', command: ['node', '-e', '0'] },
      { id: 'two', skip: 'no' },
    ])
    expect(result.status).toBe(0)
    expect(summary).toMatchObject({ ok: true })
  })

  it('records an explicitly unavailable runtime check as skipped, never passed', () => {
    const { result, summary } = runPlan([
      {
        id: 'package:probe',
        command: [
          'node',
          '-e',
          'console.log("independent OS control is unenforced");process.exit(77)',
        ],
        unavailableExitCode: 77,
        unavailableReason:
          'OS enforcement unavailable; verify on a SIP-enabled host',
      },
    ])
    expect(result.status).toBe(0)
    expect(summary.steps).toMatchObject([
      {
        id: 'package:probe',
        status: 'skipped',
        exitCode: 77,
        reason: 'OS enforcement unavailable; verify on a SIP-enabled host',
      },
    ])
    expect(summary.steps[0].logTail).toContain('independent OS control')
  })

  it('keeps unexpected nonzero results and real hardening failures red', () => {
    const { result, summary } = runPlan([
      { id: 'not-opted-in', command: ['node', '-e', 'process.exit(77)'] },
      {
        id: 'real-gap',
        command: ['node', '-e', 'process.exit(1)'],
        unavailableExitCode: 77,
      },
      { id: 'success', command: ['node', '-e', '0'], unavailableExitCode: 0 },
    ])
    expect(result.status).toBe(1)
    expect(
      summary.steps.map((step: { status: string }) => step.status),
    ).toEqual(['failed', 'failed', 'passed'])
  })

  it('runs only the steps asked for', () => {
    const { summary } = runPlan(
      [
        { id: 'one', command: ['node', '-e', '0'] },
        { id: 'two', command: ['node', '-e', 'process.exit(1)'] },
      ],
      ['--only', 'one'],
    )
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual([
      'one',
    ])
    expect(summary.ok).toBe(true)
  })

  it('retries a step once when it says how, and says it passed on retry', () => {
    const dir = tempDir('emperor-nightly-retry-')
    const marker = path.join(dir, 'tried')
    const flaky = `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('fps 41'); process.exit(1)`
    const { result, summary, report } = runPlan([
      {
        id: 'perf',
        command: ['node', '-e', flaky],
        retry: ['node', '-e', flaky],
      },
      {
        id: 'perf-broken',
        command: ['node', '-e', 'process.exit(1)'],
        retry: ['node', '-e', 'console.error("still slow"); process.exit(2)'],
      },
      { id: 'plain', command: ['node', '-e', 'process.exit(1)'] },
    ])
    expect(result.status).toBe(1)
    expect(summary.steps).toMatchObject([
      {
        id: 'perf',
        status: 'passed',
        exitCode: 0,
        retried: true,
        firstExitCode: 1,
      },
      {
        id: 'perf-broken',
        status: 'failed',
        exitCode: 2,
        retried: true,
        firstExitCode: 1,
      },
      { id: 'plain', status: 'failed', exitCode: 1 },
    ])
    expect(summary.steps[2].retried).toBeUndefined()
    expect(summary.steps[1].logTail).toContain('still slow')
    const log = fs.readFileSync(path.join(report, 'logs', 'perf.log'), 'utf8')
    expect(log).toContain('fps 41')
    expect(log).toContain('nightly: retrying')
    const markdown = fs.readFileSync(path.join(report, 'report.md'), 'utf8')
    expect(markdown).toMatch(/\| perf \| passed \| 0 \| passed on retry/)
  })

  it('runs the Electron modes without ELECTRON_RUN_AS_NODE', () => {
    const { summary } = runPlan([
      {
        id: 'env',
        command: [
          'node',
          '-e',
          'process.exit(process.env.ELECTRON_RUN_AS_NODE === undefined ? 0 : 9)',
        ],
      },
    ])
    expect(summary.steps[0]).toMatchObject({ status: 'passed' })
  })
})

describe('a failed nightly opens an issue (REL-04 test 4, dry-run)', () => {
  function report(ok: boolean) {
    const dir = tempDir('emperor-nightly-report-')
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        ok,
        startedAt: '2026-10-21T18:00:00.000Z',
        finishedAt: '2026-10-21T19:10:00.000Z',
        commit: 'e'.repeat(40),
        runUrl: 'https://github.com/TheSyart/emperor-agent/actions/runs/42',
        steps: [
          { id: 'visual', status: 'passed', exitCode: 0, ms: 1000 },
          {
            id: 'e2e:settings',
            status: 'failed',
            exitCode: 1,
            ms: 2000,
            logTail: '✗ [settings] opens 设置 › 语音 — timeout',
          },
          { id: 'e2e:real', status: 'skipped', reason: 'needs a real model' },
        ],
      }),
    )
    return dir
  }
  const issues = (value: unknown) => {
    const file = path.join(tempDir('emperor-issues-'), 'issues.json')
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }

  it('plans a new issue naming the failed steps and the run', () => {
    const result = node(opener, [
      '--report',
      report(false),
      '--dry-run',
      '--issues-json',
      issues([]),
    ])
    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan).toMatchObject({
      action: 'create',
      title: '夜间门禁失败 · 2026-10-21 · eeeeeee',
      labels: ['nightly-failure', 'release-blocker'],
      gh: [
        'issue',
        'create',
        '--title',
        '夜间门禁失败 · 2026-10-21 · eeeeeee',
        '--label',
        'nightly-failure',
        '--label',
        'release-blocker',
        '--body-file',
        '-',
      ],
    })
    expect(plan.body).toContain('e2e:settings')
    expect(plan.body).toContain('opens 设置 › 语音 — timeout')
    expect(plan.body).toContain(
      'https://github.com/TheSyart/emperor-agent/actions/runs/42',
    )
    expect(plan.body).toContain('发布')
    expect(plan.body).not.toContain('| visual |')
  })

  it('comments on the open failure issue instead of opening another', () => {
    const result = node(opener, [
      '--report',
      report(false),
      '--dry-run',
      '--issues-json',
      issues([{ number: 12, title: '夜间门禁失败 · 2026-10-20 · fffffff' }]),
    ])
    const plan = JSON.parse(result.stdout)
    expect(plan).toMatchObject({
      action: 'comment',
      issue: 12,
      gh: ['issue', 'comment', '12', '--body-file', '-'],
    })
  })

  it('closes the open failure issue once the nightly is green again', () => {
    const result = node(opener, [
      '--report',
      report(true),
      '--dry-run',
      '--issues-json',
      issues([{ number: 12, title: '夜间门禁失败 · 2026-10-20 · fffffff' }]),
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: 'close',
      issue: 12,
      gh: [
        'issue',
        'close',
        '12',
        '--comment',
        expect.stringContaining('eeeeeee'),
      ],
    })
  })

  it('does nothing for a green nightly with no open issue', () => {
    const result = node(opener, [
      '--report',
      report(true),
      '--dry-run',
      '--issues-json',
      issues([]),
    ])
    expect(JSON.parse(result.stdout)).toEqual({ action: 'none' })
  })

  it('never calls gh in a dry run', () => {
    const bin = tempDir('emperor-fake-gh-')
    const marker = path.join(bin, 'called')
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\ntouch "${marker}"\nexit 0\n`,
      { mode: 0o755 },
    )
    node(opener, ['--report', report(false), '--dry-run'], {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    })
    expect(fs.existsSync(marker)).toBe(false)
  })
})
