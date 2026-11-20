import {
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
import { EditingMediaCache } from './media-cache'
import { createEditingStaging, recoverEditingStaging } from './staging'

let root: string
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'cutroom-media-cache-test-')),
  )
  vi.stubEnv('CUTROOM_CACHE_DIR', join(root, 'cache'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('isolates copies with the same name and separate profiles, and skips active players and producers', async () => {
  const first = join(root, 'left', 'Project')
  const second = join(root, 'right', 'Project')
  await Promise.all([
    mkdir(first, { recursive: true }),
    mkdir(second, { recursive: true }),
  ])
  const live = new EditingMediaCache('primary')
  const trial = new EditingMediaCache('trial')
  const dirs = await Promise.all([
    live.directory(first, 'proxies'),
    live.directory(second, 'proxies'),
    trial.directory(first, 'proxies'),
  ])
  expect(new Set(dirs).size).toBe(3)
  const file = (dir: string, id: string) => join(dir, id.repeat(64) + '.mp4')
  const one = file(dirs[0]!, 'a')
  const two = file(dirs[1]!, 'b')
  const otherProfile = file(dirs[2]!, 'c')
  const future = file(dirs[0]!, 'e')
  await Promise.all([
    writeFile(one, 'one'),
    writeFile(two, 'two'),
    writeFile(otherProfile, 'protected'),
  ])
  await symlink(otherProfile, file(dirs[0]!, 'd'))
  const handle = live.handle({
    sessionId: 'left-session',
    projectId: 'project',
    assetId: 'movie',
    file: one,
    source: join(first, 'asset.mp4'),
    signature: 's',
  })
  expect(() => live.resolveHandle('right-session', handle)).toThrow()
  live.playback('left-session', handle, 'player', true)
  const done = live.begin(future)
  expect(await live.usage(true)).toMatchObject({
    removedFiles: 1,
    skipped: 2,
    files: 1,
    bytes: 3,
  })
  expect(await readFile(one, 'utf8')).toBe('one')
  live.playback('left-session', handle, 'player', false)
  done()
  expect(await live.usage(true)).toMatchObject({
    removedFiles: 1,
    skipped: 0,
    files: 0,
  })
  expect(await readFile(otherProfile, 'utf8')).toBe('protected')
})

it('recovers only owned crash staging, leaving a live job and unknown neighboring files alone', async () => {
  const ended = await createEditingStaging(root)
  const active = await createEditingStaging(root)
  const id = ended.path.split('.cutroom-stage-').at(-1)!
  const ticket = join(root, 'cache/staging', id)
  const record = JSON.parse(await readFile(ticket, 'utf8'))
  await writeFile(ticket, JSON.stringify({ ...record, pid: 2147483647 }))
  const file = join(ended.path, 'output.mp4')
  await writeFile(file, 'partial render')
  await writeFile(join(active.path, 'output.mp4'), 'live')
  await writeFile(join(root, 'render.mp4'), 'delivered')
  await recoverEditingStaging()
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(active.path, 'output.mp4'), 'utf8')).toBe('live')
  expect(await readFile(join(root, 'render.mp4'), 'utf8')).toBe('delivered')
  await active.close()
})
