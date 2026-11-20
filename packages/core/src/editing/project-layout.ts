import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { EmperorError } from '../errors'

export const PROJECT_PRIVATE_DIR = '.cutroom'
export const LEGACY_PROJECT_DIR = '.video-edit-agent'
const receipt = 'migrations/project-layout.v1.json'
const marker = 'cutroom-project-layout-v1'
const stageName = '.cutroom-migration-v1'
const stageOwner = 'Cutroom migration staging area v1\n'

async function info(path: string) {
  return lstat(path, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'ENOENT') throw cause
    return null
  })
}

function blocked(message: string): never {
  throw new EmperorError(message, 'project_migration_blocked')
}

export async function contentDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// A fingerprint is portable only after the bytes have been read from a stable file.
// Stat identity avoids re-hashing long movies while the same file remains unchanged.
const verifiedDigests = new Map<string, { stamp: string; digest: string }>()
export async function portableDigest(
  path: string,
): Promise<string | undefined> {
  const before = await info(path)
  if (!before?.isFile() || !before.size || (await realpath(path)) !== path)
    return
  const stamp = [
    before.dev,
    before.ino,
    before.size,
    before.mtimeNs,
    before.ctimeNs,
  ].join(':')
  const saved = verifiedDigests.get(path)
  if (saved?.stamp === stamp) return saved.digest
  const digest = await contentDigest(path)
  const after = await info(path)
  if (
    !after ||
    [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(
      ':',
    ) !== stamp
  )
    return
  if (verifiedDigests.size >= 2048)
    verifiedDigests.delete(verifiedDigests.keys().next().value!)
  verifiedDigests.set(path, { stamp, digest })
  return digest
}

type Entry = {
  source: string
  dest: string
  directory: boolean
  stamp: string
  mode: number
}

async function inventory(root: string) {
  const entries: Entry[] = []
  async function visit(source: string, dest: string) {
    const path = join(root, source)
    const value = await info(path)
    if (!value) return
    if (
      (!value.isDirectory() && !value.isFile()) ||
      (await realpath(path)) !== path
    )
      blocked('旧工程含有链接或特殊文件，请检查后重试。')
    entries.push({
      source,
      dest,
      directory: value.isDirectory(),
      stamp: [
        value.dev,
        value.ino,
        value.size,
        value.mtimeNs,
        value.ctimeNs,
      ].join(':'),
      mode: Number(value.mode) & 0o777,
    })
    if (value.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        const next = join(source, name)
        if (
          next === join(LEGACY_PROJECT_DIR, 'preview-cache') ||
          next === join(LEGACY_PROJECT_DIR, 'analysis', 'frames')
        )
          continue
        await visit(next, join(dest, name))
      }
    }
  }
  if (await info(join(root, LEGACY_PROJECT_DIR)))
    await visit(LEGACY_PROJECT_DIR, '')
  await visit('.emperor/skills', 'skills')
  const destinations = new Set<string>()
  for (const entry of entries) {
    if (destinations.has(entry.dest) || entry.dest === receipt)
      blocked('旧工程目录存在目标名称冲突，请检查后重试。')
    destinations.add(entry.dest)
  }
  return entries
}

async function readKey(stateRoot?: string) {
  if (!stateRoot) blocked('缺少原精剪签名密钥，请恢复原配置后重试。')
  const file = join(stateRoot, 'precision-run.key')
  if (!(await info(file))?.isFile())
    blocked('缺少原精剪签名密钥，请恢复原配置后重试。')
  const key = await readFile(file, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(key)) blocked('原精剪签名密钥格式无效。')
  return Buffer.from(key, 'hex')
}

function validMac(key: Buffer, data: string, signature: unknown) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
    return false
  return timingSafeEqual(
    createHmac('sha256', key).update(data).digest(),
    Buffer.from(signature, 'hex'),
  )
}

type ReviewProof = { fingerprint: string; digest: string; mac: string }
function proofBody(
  projectId: string,
  file: string,
  fingerprint: string,
  digest: string,
) {
  return JSON.stringify([marker, projectId, file, fingerprint, digest])
}

export async function matchesMigratedReview(
  root: string,
  projectId: string,
  file: string,
  fingerprint: string,
  key: Buffer,
) {
  const report = join(root, PROJECT_PRIVATE_DIR, receipt)
  try {
    if ((await realpath(report)) !== report) return false
    const proof: ReviewProof | undefined = JSON.parse(
      await readFile(report, 'utf8'),
    ).reviews?.[file]
    if (
      !proof ||
      proof.fingerprint !== fingerprint ||
      !validMac(
        key,
        proofBody(projectId, file, fingerprint, proof.digest),
        proof.mac,
      )
    )
      return false
    const path = join(root, file)
    return (
      (await realpath(path)) === path &&
      (await portableDigest(path)) === proof.digest
    )
  } catch {
    return false
  }
}

async function verifyRuns(
  root: string,
  tree: string,
  entries: Entry[],
  projectId: string,
  stateRoot?: string,
) {
  const runs = entries.filter(({ dest }) =>
    /^precision\/[^/]+\/run\.json$/.test(dest),
  )
  const reviews: Record<string, ReviewProof> = {}
  const unverifiedHistory: string[] = []
  let latest: string | undefined
  if (entries.some((e) => e.dest === 'precision/latest.json')) {
    latest = JSON.parse(
      await readFile(join(tree, 'precision/latest.json'), 'utf8'),
    )
    if (
      typeof latest !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(latest) ||
      !runs.some((r) => r.dest === 'precision/' + latest + '/run.json')
    )
      blocked('精剪任务索引不完整，请恢复原工程后重试。')
  }
  if (!runs.length) return { reviews, unverifiedHistory }
  const key = await readKey(stateRoot)
  for (const { dest } of runs) {
    let run
    try {
      const record = JSON.parse(await readFile(join(tree, dest), 'utf8'))
      if (
        typeof record.body !== 'string' ||
        !validMac(key, record.body, record.signature)
      )
        blocked('精剪记录无法用原密钥验证，请恢复原密钥或有效工程备份。')
      run = JSON.parse(record.body)
      if (run.runId !== dest.split('/')[1] || run.base?.projectId !== projectId)
        blocked('精剪记录与工程 ID 不匹配。')
    } catch (error) {
      if (!latest || dest === 'precision/' + latest + '/run.json') throw error
      // Foreign historical records are portable evidence. Only the verified current pointer can resume work.
      unverifiedHistory.push(dest)
      continue
    }
    if (
      !run.review?.fingerprint ||
      !Number.isSafeInteger(run.review.generation)
    )
      continue
    const name = join(dirname(dest), 'review-' + run.review.generation + '.mp4')
    const legacy = join(LEGACY_PROJECT_DIR, name)
    const original = await info(join(root, legacy))
    if (
      !original?.isFile() ||
      run.review.fingerprint !==
        JSON.stringify([
          legacy,
          String(original.size),
          String(original.mtimeNs),
          String(original.ino),
        ])
    )
      continue
    const file = join(PROJECT_PRIVATE_DIR, name)
    const digest = await contentDigest(join(tree, name))
    const fingerprint = run.review.fingerprint
    reviews[file] = {
      fingerprint,
      digest,
      mac: createHmac('sha256', key)
        .update(proofBody(projectId, file, fingerprint, digest))
        .digest('hex'),
    }
  }
  return { reviews, unverifiedHistory }
}

async function upgradeTranscripts(
  root: string,
  tree: string,
  entries: Entry[],
  assets: readonly { id: string; path: string }[],
) {
  const byId = new Map(assets.map((asset) => [asset.id, asset.path]))
  const hashes = new Map<string, string>()
  for (const entry of entries.filter(
    (e) =>
      !e.directory &&
      e.dest.startsWith('analysis/transcripts/') &&
      e.dest.endsWith('.json'),
  )) {
    const file = join(tree, entry.dest)
    let record
    try {
      record = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (
      record?.version !== 1 ||
      typeof record.signature !== 'string' ||
      record.contentSha256
    )
      continue
    const relativePath = byId.get(record.assetId)
    if (!relativePath) continue
    const path = resolve(root, relativePath)
    if (
      !path.startsWith(root + sep) ||
      (await realpath(path).catch(() => '')) !== path
    )
      continue
    const value = await lstat(path)
    if (
      !value.isFile() ||
      record.signature !==
        [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(
          ':',
        )
    )
      continue
    let digest = hashes.get(path)
    if (!digest) {
      digest = await contentDigest(path)
      const after = await lstat(path)
      if (after.ctimeMs !== value.ctimeMs || after.ino !== value.ino)
        blocked('转写素材在迁移中发生了变化。')
      hashes.set(path, digest)
    }
    await writeFile(
      file,
      JSON.stringify({ ...record, contentSha256: digest, peaks: [] }) + '\n',
      'utf8',
    )
  }
}

async function migrate(
  root: string,
  projectId: string,
  assets: readonly { id: string; path: string }[],
  stateRoot?: string,
) {
  const target = join(root, PROJECT_PRIVATE_DIR)
  const work = join(root, stageName)
  const tag = join(work, 'owner')
  const tree = join(work, 'data')
  try {
    await mkdir(work, { mode: 0o700 })
    await writeFile(tag, stageOwner, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await info(work))?.isDirectory() || (await realpath(work)) !== work)
      blocked('迁移暂存目录已被占用，请检查后重试。')
    if (!(await info(tag)) && !(await readdir(work)).length)
      await writeFile(tag, stageOwner, { flag: 'wx', mode: 0o600 })
    if (
      !(await info(tag))?.isFile() ||
      (await readFile(tag, 'utf8')) !== stageOwner
    )
      blocked('迁移暂存目录已被占用，请检查后重试。')
  }
  try {
    await rm(tree, { force: true, recursive: true })
    await mkdir(tree, { mode: 0o700 })
    const entries = await inventory(root)
    for (const entry of entries) {
      const destination = join(tree, entry.dest)
      if (entry.directory) {
        await mkdir(destination, { mode: 0o700, recursive: true })
        continue
      }
      const source = join(root, entry.source)
      await copyFile(
        source,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      )
      await chmod(destination, entry.mode)
      if ((await contentDigest(source)) !== (await contentDigest(destination)))
        blocked('工程迁移副本校验失败，请重试。')
    }
    const workspace = join(tree, 'workspace.json')
    if (await info(workspace)) {
      const meta = JSON.parse(await readFile(workspace, 'utf8'))
      if (
        meta.projectId !== projectId ||
        typeof meta.chatSessionId !== 'string' ||
        !meta.chatSessionId
      )
        blocked('旧工作区绑定无效，请从备份恢复后重试。')
    }
    await upgradeTranscripts(root, tree, entries, assets)
    const verified = await verifyRuns(root, tree, entries, projectId, stateRoot)
    if (JSON.stringify(entries) !== JSON.stringify(await inventory(root)))
      blocked('旧工程正在变化，请关闭占用它的程序后重试。')
    await mkdir(dirname(join(tree, receipt)), { recursive: true, mode: 0o700 })
    await writeFile(
      join(tree, receipt),
      JSON.stringify({
        format: marker,
        projectId,
        files: entries.filter((e) => !e.directory).length,
        ...verified,
      }),
      { flag: 'wx', mode: 0o600 },
    )
    if (await info(target))
      blocked('目标 .cutroom 已存在，请检查目录冲突后重试。')
    await rename(tree, target)
  } finally {
    await rm(tree, { recursive: true, force: true }).catch(() => {})
    await rm(tag, { force: true }).catch(() => {})
    await rmdir(work).catch(() => {})
  }
}

/** The lock lives outside the project, is shared by profiles, and releases on process death. */
async function lockedMigration(root: string, operation: () => Promise<void>) {
  const base = join(
    await realpath(tmpdir()),
    'cutroom-project-locks-' + (process.getuid?.() ?? 'local'),
  )
  await mkdir(base, { mode: 0o700, recursive: true })
  if (!(await lstat(base)).isDirectory() || (await realpath(base)) !== base)
    blocked('工程迁移锁目录无效。')
  const path = join(
    base,
    createHash('sha256').update(root).digest('hex') + '.sqlite',
  )
  const fd = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  )
  await fd.close()
  const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    await operation()
  } finally {
    db.close()
  }
}

export async function prepareProjectLayout(
  root: string,
  projectId: string,
  assets: readonly { id: string; path: string }[],
  stateRoot?: string,
) {
  const target = join(root, PROJECT_PRIVATE_DIR)
  let historyWarning: string | undefined
  async function committed() {
    const current = await info(target)
    if (!current) return false
    if (!current.isDirectory()) blocked('工程私有目录 .cutroom 不是普通目录。')
    const report = join(target, receipt)
    if (await info(report)) {
      if ((await realpath(report)) !== report) blocked('工程迁移记录路径无效。')
      const data = JSON.parse(await readFile(report, 'utf8'))
      if (data.format === marker && data.projectId === projectId) {
        if (
          Array.isArray(data.unverifiedHistory) &&
          data.unverifiedHistory.length
        )
          historyWarning =
            data.unverifiedHistory.length +
            ' 条历史精剪记录无法用当前密钥验证，已保留原件。历史恢复需对应的工程与原签名密钥。'
        return true
      }
      blocked('工程迁移记录与当前工程不匹配。')
    }
    blocked('新旧工程数据同时存在。请保留两份目录并核对冲突后重试。')
  }
  try {
    for (const path of [root, target]) {
      const entry = await info(path)
      if (!entry) continue
      if (process.platform !== 'win32' && !(Number(entry.mode) & 0o222))
        blocked('这个工程位于只读目录。可只读查看，恢复写入权限后重新打开。')
      await access(path, constants.W_OK)
    }
    const legacy = await info(join(root, LEGACY_PROJECT_DIR))
    const skills = await info(join(root, '.emperor', 'skills'))
    if (!legacy && !skills) {
      const existing = await info(target)
      if (existing && !existing.isDirectory())
        blocked('工程私有目录 .cutroom 无效。')
      return
    }
    if (await committed()) return historyWarning
    await lockedMigration(root, async () => {
      if (!(await committed()))
        await migrate(root, projectId, assets, stateRoot)
    })
    await committed()
    return historyWarning
  } catch (error) {
    if (error instanceof EmperorError) throw error
    const reason =
      (error as NodeJS.ErrnoException).code ??
      (error instanceof Error ? error.message : String(error))
    blocked(
      '工程私有数据暂时无法写入或迁移（' +
        reason +
        '）。可只读查看，修复后重新打开。',
    )
  }
}

export async function readPrivateMetadata(root: string, legacy = false) {
  const path = resolve(
    root,
    legacy ? LEGACY_PROJECT_DIR : PROJECT_PRIVATE_DIR,
    'workspace.json',
  )
  if (!(await info(path))) return null
  if (
    (await realpath(path)) !== path ||
    !(await lstat(path)).isFile() ||
    !relative(root, path).includes(sep)
  )
    blocked('工程绑定文件必须是工程内的普通文件。')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
