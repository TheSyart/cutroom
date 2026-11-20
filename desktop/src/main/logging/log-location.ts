/**
 * Where main.log, core.log and Crashpad's minidumps go (REL-01). Cutroom's
 * default macOS logs live in ~/Library/Logs/Cutroom. Isolated runs keep
 * their logs inside the explicitly selected profile.
 */
import * as path from 'node:path'

export interface LogLocation {
  dir: string
  mainLog: string
  coreLog: string
  crashDumps: string
  /** `default`: the user's log folder; `state-root`: inside the home. */
  source: 'default' | 'state-root'
}

export function resolveLogLocation(input: {
  stateRoot: string
  stateRootSource: string
  homeDir: string
  platform: NodeJS.Platform
  /** `app.getPath('logs')`, used off macOS. */
  systemLogs?: string
}): LogLocation {
  const inHome = input.stateRootSource !== 'default'
  const dir = inHome
    ? path.join(input.stateRoot, 'logs')
    : input.platform === 'darwin' || !input.systemLogs
      ? path.join(input.homeDir, 'Library', 'Logs', 'Cutroom')
      : input.systemLogs
  return {
    dir,
    mainLog: path.join(dir, 'main.log'),
    coreLog: path.join(dir, 'core.log'),
    crashDumps: path.join(dir, 'Crashpad'),
    source: inHome ? 'state-root' : 'default',
  }
}
