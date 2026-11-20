import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { validateRuntimeManifest as validateInstalledRuntime } from '@emperor/core/host-capabilities'
import { APP_ID, APP_NAME } from '../shared/app-brand'
const require = createRequire(import.meta.url)
const desktopRoot = path.resolve(__dirname, '../..')
const repoRoot = path.resolve(desktopRoot, '..')
type PreloadAudit = {
  validatePreloadSource(s: string): void
  validateRecoveryPreloadSource(s: string): void
}

describe('Cutroom distribution', () => {
  it('uses the Cutroom display name while retaining the installed app identity', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    const renderer = fs.readFileSync(
      path.join(desktopRoot, 'src/renderer/index.html'),
      'utf8',
    )
    expect(APP_NAME).toBe('Cutroom')
    expect(APP_ID).toBe('com.video-edit-agent.desktop')
    expect(config).toContain(`productName: ${APP_NAME}\n`)
    expect(config).toContain(`appId: ${APP_ID}\n`)
    expect(renderer).toContain(`<title>${APP_NAME}</title>`)
  })

  it('says why dictation needs the microphone and speech recognition', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    expect(config).toMatch(
      /extendInfo:\r?\n\s+NSMicrophoneUsageDescription: \S/,
    )
    expect(config).toMatch(/\n\s+NSSpeechRecognitionUsageDescription: \S/)
    // Every public build (Preview and Stable, REL-05) is sealed ad hoc with
    // these: the app holds the microphone, its Electron helpers do not.
    const audioInput =
      /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/
    expect(
      fs.readFileSync(
        path.join(desktopRoot, 'build', 'entitlements.preview.mac.plist'),
        'utf8',
      ),
    ).toMatch(audioInput)
    expect(
      fs.readFileSync(
        path.join(
          desktopRoot,
          'build',
          'entitlements.preview.mac.inherit.plist',
        ),
        'utf8',
      ),
    ).not.toMatch(audioInput)
    const assemble = fs.readFileSync(
      path.join(
        desktopRoot,
        'native',
        'macos',
        'scripts',
        'assemble-dictation-app.sh',
      ),
      'utf8',
    )
    expect(assemble).toContain('com.video-edit-agent.desktop.dictation-helper')
    expect(assemble).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(assemble).toContain('<key>NSSpeechRecognitionUsageDescription</key>')
    expect(
      fs.readFileSync(
        path.join(desktopRoot, 'scripts', 'build-native-mac.mjs'),
        'utf8',
      ),
    ).toContain('assemble-dictation-app.sh')
  })

  it('lays out the DMG window on the brand background (UI-S12)', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    const dmg = config.slice(config.indexOf('\ndmg:'), config.indexOf('\nwin:'))
    expect(dmg).toContain('  background: build/background.tiff')
    expect(dmg).toMatch(/window:\r?\n\s+width: 660\r?\n\s+height: 400/)
    expect(dmg).toMatch(/- x: 165\r?\n\s+y: 185\r?\n\s+type: file/)
    expect(dmg).toMatch(
      /- x: 495\r?\n\s+y: 185\r?\n\s+type: link\r?\n\s+path: \/Applications/,
    )
    // One TIFF carries both scales, so Retina Finder windows stay sharp.
    const tiff = fs.readFileSync(
      path.join(desktopRoot, 'build', 'background.tiff'),
    )
    expect(tiff.subarray(0, 4).toString('latin1')).toMatch(/^(MM\0\*|II\*\0)$/)
    const info = spawnSync(
      'tiffutil',
      ['-info', path.join(desktopRoot, 'build', 'background.tiff')],
      {
        encoding: 'utf8',
      },
    )
    if (info.status === 0) {
      expect(info.stdout).toContain('Image Width: 660 Image Length: 400')
      expect(info.stdout).toContain('Image Width: 1320 Image Length: 800')
    }
  })

  it('uses the 1024px brand icon for the app bundle', () => {
    const icon = fs.readFileSync(path.join(desktopRoot, 'build', 'icon.png'))
    expect(icon.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(icon.readUInt32BE(16)).toBe(1024)
    expect(icon.readUInt32BE(20)).toBe(1024)
  })

  it('rejects ESM, Node builtins and oversized sandbox preload bundles', () => {
    const audit = require(
      path.join(desktopRoot, 'scripts', 'audit-preload.cjs'),
    ) as PreloadAudit
    expect(() =>
      audit.validatePreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).not.toThrow()
    expect(() =>
      audit.validatePreloadSource(
        'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/CommonJS/i)
    expect(() =>
      audit.validatePreloadSource(
        'const fs=require("node:fs"); const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/forbidden module/i)
    expect(() =>
      audit.validatePreloadSource(
        `const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {});${'x'.repeat(70 * 1024)}`,
      ),
    ).toThrow(/size/i)
    expect(() =>
      audit.validateRecoveryPreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorRecovery", {})',
      ),
    ).not.toThrow()
    expect(() =>
      audit.validateRecoveryPreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/emperorRecovery/i)
  })

  it('build_desktop_release does not require the Python backend bundle', () => {
    const script = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'build_desktop_release.sh'),
      'utf8',
    )

    expect(
      fs.existsSync(path.join(repoRoot, 'scripts', 'build_backend_bundle.sh')),
    ).toBe(false)
    expect(script).not.toContain('build_backend_bundle.sh')
    expect(script).not.toContain('PYTHON_BIN')
  })

  it('validates package resource contents and rejects modified runtime files', () => {
    const hooks = require('../../scripts/before-pack.cjs')
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-manifest-'))
    try {
      for (const mapping of hooks.SOURCE_MAPPINGS) {
        const target = path.join(temp, mapping.target)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.cpSync(path.join(repoRoot, mapping.source), target, {
          recursive: true,
          filter: (p) => !hooks.OS_METADATA_FILES.has(path.basename(p)),
        })
      }
      const manifest = hooks.createRuntimeManifest({
        repoRoot,
        appVersion: '0.2.1',
        outputPath: path.join(temp, 'runtime-manifest.json'),
      })
      expect(hooks.validateRuntimeManifest(temp, '0.2.1').runtimeRevision).toBe(
        manifest.runtimeRevision,
      )
      expect(
        validateInstalledRuntime(temp, { expectedAppVersion: '0.2.1' })
          .buildCommit,
      ).toBe(manifest.buildCommit)
      fs.appendFileSync(path.join(temp, 'README.md'), 'changed')
      expect(() => hooks.validateRuntimeManifest(temp, '0.2.1')).toThrow()
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
  it('ships only the dictation helper and no development SDKs', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    expect(config).toContain('Emperor Dictation Helper.app')
    for (const retired of [
      'node-pty',
      'claude-agent-sdk',
      'Computer Helper.app',
      'desktop-pet',
      'emperor-nm-host',
    ])
      expect(config).not.toContain(retired)
  })
})
