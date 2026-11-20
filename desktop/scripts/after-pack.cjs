const {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} = require('node:fs')
const { builtinModules } = require('node:module')
const { join } = require('node:path')
const { extractFile, listPackage } = require('@electron/asar')
const { validateRuntimeManifest } = require('./before-pack.cjs')
const {
  validatePetPreloadSource,
  validatePreloadSource,
  validateRecoveryPreloadSource,
} = require('./audit-preload.cjs')
const {
  electronBinaryPath,
  flipPackagedFuses,
  sealMacApp,
  verifyMacHardening,
} = require('./harden-package.cjs')

/**
 * Entitlements of the ad-hoc seal (harden-package.cjs) of every public
 * build: Preview and, since REL-05, Stable, neither of which is signed.
 */
const PREVIEW_ENTITLEMENTS = {
  app: join(__dirname, '..', 'build', 'entitlements.preview.mac.plist'),
  electronHelper: join(
    __dirname,
    '..',
    'build',
    'entitlements.preview.mac.inherit.plist',
  ),
  dictation: join(
    __dirname,
    '..',
    'native',
    'macos',
    'scripts',
    'dictation-helper.entitlements',
  ),
}

const BUILD_ONLY_DEPENDENCIES = {}
function isAllowedNodeModuleEntry(entry) {
  return entry === '/node_modules'
}
function bareImportPackage(specifier) {
  if (/^(?:\.|\/|node:|data:|file:)/.test(specifier)) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
  if (name === 'electron' || builtinModules.includes(name)) return null
  return name
}

/**
 * Every package the main bundle loads at run time (its static imports and
 * literal dynamic imports) ships in app.asar, and so does every dependency
 * of a shipped package. Node resolves a bare import by walking up from
 * app.asar, so a package left out is found only when the app sits inside a
 * build checkout (desktop/dist next to node_modules) and the installed app
 * cannot start (REL-05: turndown).
 */
function runtimeImportProblems(asarPath, entries) {
  const listed = new Set(entries.map(normalizeArchiveEntry))
  const shipped = (name) => listed.has(`/node_modules/${name}/package.json`)
  const problems = []
  const imported = new Map()
  for (const entry of [...listed]
    .filter((item) => /^\/out\/main\/[^/]+\.js$/.test(item))
    .sort()) {
    const source = extractFile(asarPath, entry.slice(1)).toString('utf8')
    const specifiers = [
      ...source.matchAll(
        /^(?:import|export)\b[^\n;]*?\bfrom\s*["']([^"'\n]+)["'];?[ \t]*$/gm,
      ),
      ...source.matchAll(/^import\s*["']([^"'\n]+)["'];?[ \t]*$/gm),
      // A dynamic import, not a method named import (JXA's ObjC.import).
      ...source.matchAll(/(?<![.\w$])import\(\s*["']([^"'\n]+)["']\s*\)/g),
    ].map((match) => match[1])
    for (const specifier of specifiers) {
      const name = bareImportPackage(specifier)
      if (name && !imported.has(name)) imported.set(name, entry)
    }
  }
  for (const [name, entry] of imported)
    if (!shipped(name))
      problems.push(`${entry} imports ${name}, which app.asar does not ship`)
  for (const entry of [...listed].sort()) {
    const match = /^\/node_modules\/((?:@[^/]+\/)?[^/@]+)\/package\.json$/.exec(
      entry,
    )
    if (!match) continue
    const meta = JSON.parse(
      extractFile(asarPath, entry.slice(1)).toString('utf8'),
    )
    const buildOnly = BUILD_ONLY_DEPENDENCIES[match[1]] ?? []
    for (const dependency of Object.keys(meta.dependencies ?? {}))
      if (!buildOnly.includes(dependency) && !shipped(dependency))
        problems.push(
          `${match[1]} needs ${dependency}, which app.asar does not ship`,
        )
  }
  return problems
}

function validatePackagedAppResources(
  resourcesRoot,
  platform = process.platform,
  arch = process.arch,
) {
  const asarPath = join(resourcesRoot, 'app.asar')
  assertRegularFile(asarPath, 'app.asar')
  const archiveEntries = listPackage(asarPath)
  const entries = archiveEntries.map(normalizeArchiveEntry)
  const required = [
    '/out/main/index.js',
    '/out/preload/index.cjs',
    '/out/preload/recovery.cjs',
    '/out/renderer/index.html',
    '/package.json',
  ]
  for (const entry of required) {
    if (!entries.includes(entry))
      throw new Error(`packaged app is missing required ASAR entry: ${entry}`)
  }
  for (const entry of entries) {
    if (
      ((entry === '/node_modules' || entry.startsWith('/node_modules/')) &&
        !isAllowedNodeModuleEntry(entry, platform, arch)) ||
      /(?:^|\/)(?:fixtures|tests|desktop-pet)(?:\/|$)/i.test(entry) ||
      /(?:\.py|requirements[^/]*\.txt)$/i.test(entry)
    )
      throw new Error(`packaged app contains forbidden ASAR entry: ${entry}`)
    if (
      entry !== '/package.json' &&
      entry !== '/out' &&
      !entry.startsWith('/out/') &&
      !isAllowedNodeModuleEntry(entry, platform, arch)
    )
      throw new Error(`packaged app contains unexpected ASAR entry: ${entry}`)
  }

  const packageJson = JSON.parse(
    extractFile(asarPath, 'package.json').toString('utf8'),
  )
  if (packageJson?.main !== 'out/main/index.js')
    throw new Error('packaged app main entry is invalid')
  validatePreloadSource(extractFile(asarPath, 'out/preload/index.cjs'))
  validateRecoveryPreloadSource(
    extractFile(asarPath, 'out/preload/recovery.cjs'),
  )
  assertNoDevelopmentPaths(asarPath, archiveEntries)
  const missingImports = runtimeImportProblems(asarPath, archiveEntries)
  if (missingImports.length)
    throw new Error(
      `packaged app cannot load its own imports:\n- ${missingImports.join('\n- ')}`,
    )
  if (platform === 'darwin') {
    const helpers = join(resourcesRoot, '..', 'Library', 'Helpers')
    const names = readdirSync(helpers)
    if (names.length !== 1 || names[0] !== 'Emperor Dictation Helper.app')
      throw new Error('unexpected native helper inventory')
    validateDictationHelper(join(helpers, names[0]))
  }
  for (const forbidden of [
    'backend',
    'node_modules',
    'desktop-pet',
    'browser-extension',
    'native/delegation-scan',
    'native/credential-auth',
  ]) {
    if (existsSync(join(resourcesRoot, forbidden)))
      throw new Error(`packaged resources contain forbidden path: ${forbidden}`)
  }
}

/** Editor dictation helper: its identity and the two usage strings. */
function validateDictationHelper(helper) {
  if (
    !existsSync(helper) ||
    !lstatSync(helper).isDirectory() ||
    lstatSync(helper).isSymbolicLink()
  )
    throw new Error('packaged dictation helper app is missing or unsafe')
  const info = join(helper, 'Contents', 'Info.plist')
  const executable = join(
    helper,
    'Contents',
    'MacOS',
    'emperor-dictation-helper',
  )
  assertRegularFile(info, 'dictation helper Info.plist')
  assertRegularFile(executable, 'dictation helper executable')
  const plist = readFileSync(info, 'utf8')
  if (
    !plist.includes(
      '<string>com.video-edit-agent.desktop.dictation-helper</string>',
    ) ||
    !plist.includes('<key>NSMicrophoneUsageDescription</key>') ||
    !plist.includes('<key>NSSpeechRecognitionUsageDescription</key>') ||
    (lstatSync(executable).mode & 0o111) === 0
  )
    throw new Error('packaged dictation helper identity is invalid')
  validateHelperIcon(helper, 'dictation helper')
}

/**
 * A helper names its icon in Info.plist and carries it in Resources (RV-07);
 * without it macOS shows a blank icon in the permission prompts and in
 * System Settings › Privacy & Security.
 */
function validateHelperIcon(helper, label) {
  const plist = readFileSync(join(helper, 'Contents', 'Info.plist'), 'utf8')
  const name = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(
    plist,
  )?.[1]
  if (!name || name.includes('/') || name.startsWith('.'))
    throw new Error(`packaged ${label} icon is not named in Info.plist`)
  const icon = join(
    helper,
    'Contents',
    'Resources',
    name.endsWith('.icns') ? name : `${name}.icns`,
  )
  assertRegularFile(icon, `${label} icon`)
  if (readFileSync(icon).subarray(0, 4).toString('latin1') !== 'icns')
    throw new Error(`packaged ${label} icon is not an icns file`)
}

function assertNoDevelopmentPaths(asarPath, archiveEntries) {
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+\//,
    /\/home\/[A-Za-z0-9._-]+\//,
    /[A-Za-z]:\\Users\\[^\\]+\\/,
  ]
  for (const archiveEntry of archiveEntries) {
    const entry = normalizeArchiveEntry(archiveEntry)
    if (
      !entry.startsWith('/out/') ||
      !/\.(?:cjs|css|html|js|json|mjs)$/.test(entry)
    )
      continue
    const content = extractFile(asarPath, archiveEntry.replace(/^[/\\]/, ''))
    if (content.byteLength > 8 * 1024 * 1024)
      throw new Error(
        `packaged ASAR text entry exceeds inspection limit: ${entry}`,
      )
    const text = content.toString('utf8')
    if (patterns.some((pattern) => pattern.test(text)))
      throw new Error(
        `packaged ASAR contains a development-machine path: ${entry}`,
      )
  }
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/\\/g, '/')
}

function assertRegularFile(path, label) {
  if (!existsSync(path))
    throw new Error(`packaged resource is missing: ${label}`)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`packaged resource must be a regular file: ${label}`)
}

async function afterPack(context) {
  const appInfo = context.packager.appInfo
  const macResources = join(
    context.appOutDir,
    `${appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  )
  const resourcesRoot = existsSync(macResources)
    ? macResources
    : join(context.appOutDir, 'resources')
  validateRuntimeManifest(
    join(resourcesRoot, 'runtime-defaults'),
    appInfo.version,
  )
  const platform = context.electronPlatformName || process.platform
  const arch = electronBuilderArch(context.arch)
  validatePackagedAppResources(resourcesRoot, platform, arch)
  // SEC-04: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, no app
  // outside app.asar, and on macOS an asar whose header hash must match
  // Info.plist. Flipped before any signature: it rewrites Electron's binary.
  await flipPackagedFuses(
    electronBinaryPath({
      appOutDir: context.appOutDir,
      platform,
      productFilename: appInfo.productFilename,
      executableName: context.packager.executableName,
    }),
    platform,
  )
  // Public builds (Preview and Stable, electron-builder.preview.cjs and
  // electron-builder.release.cjs) have no developer certificate. Seal the
  // bundle ad hoc, every piece of code with the hardened runtime, so the
  // main executable has a stable bundle identifier, the helper can bind a
  // local peer to this exact build's cdhash, and no DYLD_* variable loads
  // foreign code into a process that holds Emperor's TCC grants. Gatekeeper
  // still treats the build as unidentified, and every changed build needs
  // TCC re-authorization.
  if (
    platform === 'darwin' &&
    context.packager.config?.mac?.identity === null
  ) {
    const app = join(context.appOutDir, `${appInfo.productFilename}.app`)
    sealMacApp(app, PREVIEW_ENTITLEMENTS)
    require('./after-sign.cjs').validateMacPackage(app, arch)
    await verifyMacHardening(app)
  }
}

function electronBuilderArch(value) {
  if (typeof value === 'string' && value) return value
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[value] || process.arch
}

module.exports = afterPack
module.exports.validatePackagedAppResources = validatePackagedAppResources
module.exports.isAllowedNodeModuleEntry = isAllowedNodeModuleEntry
module.exports.runtimeImportProblems = runtimeImportProblems
module.exports.PREVIEW_ENTITLEMENTS = PREVIEW_ENTITLEMENTS
