import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('root build contract', () => {
  it('runs the monorepo typecheck before producing the Desktop bundle', () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(__dirname, '..', '..', '..', 'package.json'),
        'utf8',
      ),
    ) as { scripts?: Record<string, string> }
    const build = packageJson.scripts?.build ?? ''

    expect(build).toMatch(/^npm run typecheck && /)
    expect(build).toContain('npm --prefix desktop run build')
  })

  it('bundles the desktop runtime without a plugin or terminal dependency', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    )
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('node-pty')
  })
})
