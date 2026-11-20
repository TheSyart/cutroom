import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareProjectLayout } from './project-layout'

vi.mock('node:fs/promises', async (actual) => {
  const fs = await actual<typeof import('node:fs/promises')>()
  return { ...fs, copyFile: vi.fn(fs.copyFile) }
})

let root: string
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'cutroom-migration-fault-')),
  )
  await mkdir(join(root, '.video-edit-agent'))
  await writeFile(
    join(root, '.video-edit-agent/workspace.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId: 'project',
      chatSessionId: 'session',
    }),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('leaves the original intact on disk-full and commits only after a verified retry', async () => {
  const source = join(root, '.video-edit-agent/workspace.json')
  const original = await readFile(source)
  vi.mocked(copyFile).mockRejectedValueOnce(
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
  )
  await expect(prepareProjectLayout(root, 'project', [])).rejects.toThrow(
    /ENOSPC/,
  )
  expect(await readFile(source)).toEqual(original)
  await expect(lstat(join(root, '.cutroom'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await prepareProjectLayout(root, 'project', [])
  expect(await readFile(join(root, '.cutroom/workspace.json'))).toEqual(
    original,
  )
})

it('refuses a symlink inside a project skill, without copying data outside the project', async () => {
  await mkdir(join(root, '.emperor/skills/example'), { recursive: true })
  await symlink(
    join(root, '.video-edit-agent/workspace.json'),
    join(root, '.emperor/skills/example/SKILL.md'),
  )
  await expect(prepareProjectLayout(root, 'project', [])).rejects.toThrow(
    /链接/,
  )
  await expect(lstat(join(root, '.cutroom'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('excludes concurrent migrations and retries after the active copy commits', async () => {
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const copying = new Promise<void>((resolve) => {
    started = resolve
  })
  vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
    started()
    await held
    await fs.copyFile(...args)
  })
  const first = prepareProjectLayout(root, 'project', [])
  await copying
  try {
    await expect(
      prepareProjectLayout(root, 'project', []),
    ).rejects.toMatchObject({ code: 'project_migration_blocked' })
  } finally {
    release()
  }
  await first
  await expect(
    prepareProjectLayout(root, 'project', []),
  ).resolves.toBeUndefined()
})
