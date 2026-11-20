import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
describe('trusted renderer policy wiring', () => {
  it('reads ELECTRON_RENDERER_URL only through the packaged-aware helper (SEC-04)', () => {
    expect(source).not.toContain('process.env.ELECTRON_RENDERER_URL')
    expect(source).toMatch(
      /developmentUrl: developmentRendererUrl\(\{\s*isPackaged: app\.isPackaged,/,
    )
    expect(source).toMatch(
      /mainWindow\.loadURL\(\s*mainRendererUrl\(\{ isPackaged: app\.isPackaged, env: process\.env \}\),?\s*\)/,
    )
  })

  it('guards navigation, redirects, frames and popups', () => {
    expect(source).toContain("contents.on('will-navigate'")
    expect(source).toContain("contents.on('will-frame-navigate'")
    expect(source).toContain("contents.on('will-redirect'")
    expect(source).toContain('contents.setWindowOpenHandler')
  })

  it('authorizes Core IPC and every desktop channel, named by contract constants', () => {
    expect(source).toContain('authorizeIpc: (event) =>')
    // No channel name is a string literal in main (MAIN-27).
    expect(source).not.toMatch(/ipcMain\.(?:handle|on)\('emperor:/)

    for (const channel of [
      'SELECT_DIRECTORY_CHANNEL',
      'MOTION_FRAME_CHANNEL',
      'VIDEO_EXPORT_CHANNEL',
      'VIDEO_EXPORT_CANCEL_CHANNEL',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `ipcMain\\.handle\\(\\s*${channel},[\\s\\S]{0,180}trustedRendererPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
    }
    for (const register of [
      'registerOpenPathIpc',
      'registerRemoteImageIpc',
      'registerDiagnosticsBundleIpc',
      'registerDictationIpc',
      'registerEditorNativeIpc',
      // REL-05: the renderer's app version comes from app.getVersion().
      'registerAppVersionIpc',
      // BUG-05: 「用默认应用打开」 for a granted video.
      'registerWorkspaceMediaIpc',
    ])
      expect(source).toMatch(
        new RegExp(
          `${register}\\(\\{\\s*ipcMain(?:\\s*:\\s*startupIpc)?,\\s*authorize: \\(event\\) => trustedRendererPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
  })
})
