import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { modelApiKeyContext } from '../config/model-config'
import { FUN_ASR_KEY_CONTEXT } from '../editing/analysis/config'
import { withPreviousCutroomWriterLock } from './cutroom-writer-lock'
import { assertCutroomProfilePath } from './cutroom-profile-paths'
import { LocalSecretStore } from '../security/local-secret-store'
import {
  isSealedSecret,
  localSecretKeyPath,
  sealerFromSecretStore,
} from '../security/secret-sealer'

const RECEIPT = '.cutroom-profile-v1.json'
const KEY_RECEIPT = '.cutroom-local-key-v1'
const retained = [
  'installation.json',
  'settings.json',
  'emperor.local.json',
  'model_config.json',
  'video-analysis.json',
  'precision-run.key',
  'onboarding.json',
  'AGENTS.md',
  'sessions',
  'memory',
  'projects',
  'workspace',
  'tokens',
  'skills',
  'media',
  'electron-user-data/Local Storage',
  'electron-user-data/IndexedDB',
  'electron-user-data/Session Storage',
  'electron-user-data/Preferences',
  'electron-user-data/Local State',
]
const pathConfigs = new Set([
  'video-analysis.json',
  'projects/index.json',
  'skills/installed.v1.json',
])

function info(file: string) {
  return fs.lstatSync(file, { throwIfNoEntry: false })
}
function flush(file: string) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(file, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function digest(file: string) {
  const hash = createHash('sha256')
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  )
  const buffer = Buffer.allocUnsafe(
    Math.min(1024 * 1024, Math.max(1, fs.fstatSync(fd).size)),
  )
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!n) return hash.digest('hex')
      hash.update(buffer.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Never traverse a link in a selected data path, including its intermediate components. */
function plainPath(root: string, name: string): string {
  let file = root
  for (const component of name.split('/')) {
    file = join(file, component)
    if (info(file)?.isSymbolicLink())
      throw new Error(`迁移遇到符号链接，请先检查 ${file}`)
  }
  return file
}

function copyVerified(
  from: string,
  to: string,
  source: string,
  destination: string,
): void {
  const stat = fs.lstatSync(from)
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const name of fs.readdirSync(from))
      copyVerified(join(from, name), join(to, name), source, destination)
    flush(to)
    return
  }
  if (!stat.isFile()) throw new Error(`无法迁移特殊文件或符号链接 ${from}`)
  fs.mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  fs.copyFileSync(
    from,
    to,
    fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
  )
  fs.chmodSync(to, 0o600 | (stat.mode & 0o100))
  if (digest(from) !== digest(to)) throw new Error(`迁移校验失败 ${from}`)
  if (pathConfigs.has(relative(source, from))) {
    // These manifests store absolute references to user skills, projects and the Whisper model.
    // External media and project paths keep their original values.
    const original = fs.readFileSync(to, 'utf8')
    let changed = false
    const data: unknown = JSON.parse(original, (_key, value: unknown) => {
      if (
        typeof value === 'string' &&
        (value === source || value.startsWith(source + sep))
      ) {
        changed = true
        return destination + value.slice(source.length)
      }
      return value
    })
    if (changed) fs.writeFileSync(to, JSON.stringify(data, null, 2) + '\n')
  }
  flush(to)
}

/** Reuse the exact key for models and ASR. The source key is never changed. */
export function importCutroomLocalKey(source: string, target = source): void {
  if (source === target && info(join(target, KEY_RECEIPT))?.isFile()) return
  const old = plainPath(source, 'computer-use/secrets/local.key')
  const canonical = plainPath(source, 'secrets/local.key')
  const keys = [old, canonical].filter((file) => info(file))
  if (!keys.length || (source === target && !info(old))) return
  const destination = new LocalSecretStore({
    keyPath: localSecretKeyPath(target),
  })
  for (const file of keys) {
    const key = new LocalSecretStore({ keyPath: file }).exportKey()
    try {
      destination.installKey(key)
      const copy = destination.exportKey()
      try {
        if (!copy.equals(key)) throw new Error('旧版与新版的本机密钥冲突。')
      } finally {
        copy.fill(0)
      }
    } finally {
      key.fill(0)
    }
  }
  if (source === target)
    fs.writeFileSync(join(target, KEY_RECEIPT), '1\n', {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    })
}

function verifyMigratedSecrets(staged: string): void {
  const sealer = sealerFromSecretStore(
    new LocalSecretStore({ keyPath: localSecretKeyPath(staged) }),
  )
  const models = join(staged, 'model_config.json')
  if (info(models)) {
    const config = JSON.parse(fs.readFileSync(models, 'utf8'))
    if (Array.isArray(config?.models))
      for (const entry of config.models) {
        if (isSealedSecret(entry?.apiKey))
          sealer.open(entry.apiKey, modelApiKeyContext(entry.entryId))
      }
  }
  const asr = join(staged, 'video-analysis.json')
  if (info(asr)) {
    const config = JSON.parse(fs.readFileSync(asr, 'utf8'))
    if (isSealedSecret(config?.sealedFunAsrKey))
      sealer.open(config.sealedFunAsrKey, FUN_ASR_KEY_CONTEXT)
  }
}

function assertChromiumClosed(source: string): void {
  const lock = plainPath(source, 'electron-user-data') + '/SingletonLock'
  const stat = info(lock)
  if (!stat) return
  const match =
    stat.isSymbolicLink() && /^(.*)-(\d+)$/.exec(fs.readlinkSync(lock))
  if (match && match[1] === hostname()) {
    try {
      process.kill(Number(match[2]), 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  throw new Error(
    `旧版 Cutroom 的浏览器配置仍在使用。请退出旧版后重新打开。\n${source}`,
  )
}

function record(source: string, destination: string) {
  return JSON.stringify({ version: 1, source, destination }) + '\n'
}
function hasRecord(path: string, expected: string) {
  return info(path)?.isFile() && fs.readFileSync(path, 'utf8') === expected
}

/** The caller holds the destination lock. Reserve the legacy writer while taking its snapshot. */
export function migrateCutroomProfile(
  destination: string,
  source: string | null,
): void {
  assertCutroomProfilePath(destination)
  if (!source) {
    importCutroomLocalKey(destination)
    return
  }
  assertCutroomProfilePath(source)
  if (info(source)?.isSymbolicLink() || info(destination)?.isSymbolicLink())
    throw new Error(
      '默认的 Cutroom 配置目录是符号链接。请检查数据目录后重新打开。',
    )
  if (!info(source)) {
    importCutroomLocalKey(destination)
    return
  }
  const receipt = record(source, destination)
  if (hasRecord(join(destination, RECEIPT), receipt)) {
    // The rename is the commit point. Recover the tiny receipt container if a process
    // exited between that commit and the two cleanup operations.
    const work = stagingArea(destination)
    if (info(work)?.isDirectory()) {
      const contents = fs.readdirSync(work)
      if (
        contents.length === 1 &&
        contents[0] === 'owner.json' &&
        hasRecord(join(work, 'owner.json'), receipt)
      )
        fs.unlinkSync(join(work, 'owner.json'))
      if (!fs.readdirSync(work).length) fs.rmdirSync(work)
    }
    return
  }
  if (info(destination) && fs.readdirSync(destination).length)
    throw new Error(
      `两个配置目录都已有数据。请备份并将其中一个目录移至其他位置后重新打开。\n${source}\n${destination}`,
    )
  withPreviousCutroomWriterLock(source, () =>
    stageAndPublish(destination, source, receipt),
  )
}

function stagingArea(destination: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.profile-migration-v1`,
  )
}

function stageAndPublish(
  destination: string,
  source: string,
  receipt: string,
): void {
  assertChromiumClosed(source)
  const work = stagingArea(destination)
  const receiptFile = join(work, 'owner.json')
  const stage = join(work, 'profile')
  if (!info(work)) fs.mkdirSync(work, { mode: 0o700 })
  if (!fs.lstatSync(work).isDirectory())
    throw new Error(`迁移暂存路径冲突 ${work}`)
  const contents = fs.readdirSync(work)
  if (!contents.length)
    fs.writeFileSync(receiptFile, receipt, {
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
  else if (
    !hasRecord(receiptFile, receipt) ||
    contents.some((name) => name !== 'profile' && name !== 'owner.json')
  )
    throw new Error(`迁移暂存目录包含其他数据 ${work}`)
  // A crash can leave a partial snapshot here. Only discard our own identified stage.
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { mode: 0o700 })
  flush(work)
  for (const name of retained) {
    const from = plainPath(source, name)
    if (info(from)) copyVerified(from, join(stage, name), source, destination)
  }
  importCutroomLocalKey(source, stage)
  verifyMigratedSecrets(stage)
  fs.writeFileSync(join(stage, RECEIPT), receipt, {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  })
  flush(stage)
  assertChromiumClosed(source)
  // rename never overwrites a nonempty destination. Both directories share a filesystem.
  fs.renameSync(stage, destination)
  flush(dirname(destination))
  fs.unlinkSync(receiptFile)
  fs.rmdirSync(work)
}
