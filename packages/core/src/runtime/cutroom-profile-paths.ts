import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export function cutroomProfilePaths(home = homedir()) {
  const parent = join(home, 'Library', 'Application Support')
  return {
    current: join(parent, 'Cutroom'),
    previous: join(parent, 'Video Edit Agent'),
  }
}

/** Resolve aliases even if the final directory or a symlink target is still absent. */
export function canonicalProfilePath(input: string, links = 0): string {
  if (links >= 40) throw new Error('Too many profile directory symlinks')
  let current = resolve(input)
  const suffix: string[] = []
  for (;;) {
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink())
      return join(
        canonicalProfilePath(
          resolve(dirname(current), readlinkSync(current)),
          links + 1,
        ),
        ...suffix,
      )
    if (info) return join(realpathSync.native(current), ...suffix)
    suffix.unshift(basename(current))
    current = dirname(current)
  }
}

/** Never accept the live upstream profile (or an ancestor) as a Cutroom data directory. */
export function assertCutroomProfilePath(
  input: string,
  homes = [homedir(), userInfo().homedir],
): void {
  const folded = (p: string) =>
    process.platform === 'darwin' || process.platform === 'win32'
      ? p.toLowerCase()
      : p
  const within = (child: string, parent: string) =>
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  const protectedNames = [
    '.emperor',
    '.emperor-agent',
    'Library/Application Support/Emperor Agent',
    'Library/Logs/Emperor Agent',
  ]
  const check = (candidate: string, profile: string) => {
    if (
      within(folded(candidate), folded(profile)) ||
      within(folded(profile), folded(candidate))
    )
      throw new Error(
        'Cutroom 数据目录必须与原 Emperor 数据目录分开。请检查数据目录环境变量或符号链接。',
      )
  }
  const roots = [...new Set(homes)]
  for (const home of roots)
    for (const name of protectedNames) check(resolve(input), join(home, name))
  const candidate = canonicalProfilePath(input)
  for (const home of roots) {
    const root = canonicalProfilePath(home)
    for (const name of protectedNames) check(candidate, join(root, name))
  }
}
