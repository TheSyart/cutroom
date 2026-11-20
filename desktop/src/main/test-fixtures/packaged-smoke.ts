/**
 * What run-packaged-smoke.cjs adds as `package`: on macOS the seal
 * (harden-package.cjs verifyMacHardening), elsewhere the fuses alone.
 */
export interface PackagedSmokeSealFixture {
  codesignStrict?: boolean
  identifier?: string
  sealedCode?: number
  runtime?: Record<string, boolean>
  fuses: Record<string, boolean>
}

function sealFixture(platform: string): PackagedSmokeSealFixture {
  const fuses = {
    RunAsNode: false,
    EnableCookieEncryption: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: platform === 'darwin',
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  }
  if (platform !== 'darwin') return { fuses }
  return {
    codesignStrict: true,
    identifier: 'com.video-edit-agent.desktop',
    sealedCode: 20,
    runtime: {
      'Dictation Helper': true,
    },
    fuses,
  }
}

/** Complete, hand-written schema 2 fixture for the release consumers. */
export function packagedSmokeFixture(
  platform: string,
  arch: string,
  appVersion: string,
  commit: string,
) {
  return {
    schemaVersion: 3,
    appVersion,
    commit,
    platform,
    arch,
    exitCode: 0,
    stateRoot: '$TEMP/stateRoot',
    runtimeManifestHash: 'b'.repeat(64),
    runtimeRevision: 'c'.repeat(64),
    operations: {
      renderer: {
        appVersion,
        home: true,
        coreBridge: true,
        nodeGlobalsAbsent: true,
      },
      editing: { projectId: 'test-project', registered: 100 },
    },
    package: sealFixture(platform),
  }
}
