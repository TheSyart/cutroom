import { accessSync, constants, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), 'bin'),
]

export function executable(path: string | undefined): string | null {
  if (!path) return null
  try {
    accessSync(path, constants.X_OK)
    return path
  } catch {
    return null
  }
}

function readable(path: string | undefined): string | null {
  if (!path) return null
  try {
    accessSync(path, constants.R_OK)
    return path
  } catch {
    return null
  }
}

export function findExecutable(
  name: string,
  configured?: string,
): string | null {
  const direct = executable(configured)
  if (direct) return direct
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...CANDIDATES,
  ]
  for (const dir of dirs) {
    const found = executable(join(dir, name))
    if (found) return found
  }
  return null
}

const MODEL_NAMES = [
  'ggml-small-q5_1.bin',
  'ggml-small.bin',
  'ggml-base.bin',
  'ggml-medium-q5_0.bin',
  'ggml-medium.bin',
]

export function findWhisperModel(
  stateRoot: string,
  configured?: string,
): string | null {
  const direct = readable(configured)
  if (direct) return direct
  const dirs = [
    join(stateRoot, 'media', 'whisper'),
    join(homedir(), '.cache', 'whisper'),
    join(homedir(), 'Library', 'Application Support', 'whisper.cpp'),
  ]
  for (const dir of dirs) {
    try {
      for (const name of MODEL_NAMES) {
        const found = readable(join(dir, name))
        if (found) return found
      }
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.bin') && name.startsWith('ggml-')) {
          const found = readable(join(dir, name))
          if (found) return found
        }
      }
    } catch {
      // Missing directory: try the next known location.
    }
  }
  return null
}
