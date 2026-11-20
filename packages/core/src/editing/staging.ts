import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

const idPattern = /^[a-f0-9-]{36}$/
const jobsPath = () =>
  join(
    process.env.CUTROOM_CACHE_DIR ||
      join(homedir(), 'Library', 'Caches', 'com.video-edit-agent.desktop'),
    'staging',
  )
const ownershipFile = '.cutroom-staging'
const recovered = new Map<string, Promise<void>>()

async function safeJobs(create = false) {
  const jobs = jobsPath()
  if (create) await mkdir(dirname(jobs), { mode: 0o700, recursive: true })
  if (!(await lstat(dirname(jobs))).isDirectory())
    throw new Error('媒体暂存索引目录无效。')
  if (create) await mkdir(jobs, { mode: 0o700, recursive: true })
  if (!(await lstat(jobs)).isDirectory())
    throw new Error('媒体暂存索引目录无效。')
  return await realpath(jobs)
}

function active(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function recover() {
  const jobs = await safeJobs()
  for (const entry of await readdir(jobs, { withFileTypes: true })) {
    if (!entry.isFile() || !idPattern.test(entry.name)) continue
    const ticket = join(jobs, entry.name)
    try {
      const { path, pid, token } = JSON.parse(await readFile(ticket, 'utf8'))
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        active(pid) ||
        !idPattern.test(token) ||
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        basename(path) !== '.cutroom-stage-' + entry.name
      )
        continue
      const dir = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (dir?.isDirectory() && (await realpath(path)) === path) {
        const mark = join(path, ownershipFile)
        if (
          await lstat(mark)
            .then((s) => s.isFile())
            .catch(() => false)
        ) {
          if ((await readFile(mark, 'utf8')) !== token) continue
          await rm(path, { recursive: true, force: true })
        } else await rmdir(path) // A crash between mkdir and writing the mark.
      } else if (
        dir ||
        !(await lstat(dirname(path)).catch(() => null))?.isDirectory()
      )
        continue
      await rm(ticket, { force: true })
    } catch {
      /* Keep unavailable volumes, busy files and unknown records for retry. */
    }
  }
}

export function recoverEditingStaging(): Promise<void> {
  const root = jobsPath()
  const pending = recovered.get(root) ?? recover().catch(() => {})
  recovered.set(root, pending)
  return pending
}

export async function createEditingStaging(parent: string) {
  const directory = await realpath(parent)
  const jobs = await safeJobs(true)
  const id = randomUUID()
  const token = randomUUID()
  const path = join(directory, '.cutroom-stage-' + id)
  const ticket = join(jobs, id)
  await writeFile(ticket, JSON.stringify({ path, pid: process.pid, token }), {
    flag: 'wx',
    mode: 0o600,
  })
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
    await writeFile(join(path, ownershipFile), token, {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (created) await rmdir(path).catch(() => {})
    await rm(ticket, { force: true })
    throw error
  }
  return {
    path,
    async close() {
      await rm(path, { recursive: true, force: true })
      await rm(ticket, { force: true })
    },
  }
}
