import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { packagedFuses } = require('../desktop/scripts/harden-package.cjs')

export function assertPackagedSmokeReceipt(receipt, identity) {
  if (
    receipt?.schemaVersion !== 3 ||
    receipt.exitCode !== 0 ||
    !['appVersion', 'platform', 'arch', 'commit'].every(
      (k) => receipt[k] === identity[k],
    ) ||
    !/^(?:local|[a-f0-9]{40})$/.test(receipt.commit) ||
    ![receipt.runtimeRevision, receipt.runtimeManifestHash].every((h) =>
      /^[a-f0-9]{64}$/.test(h),
    )
  )
    throw new Error('Invalid packaged smoke identity')
  const { renderer, editing } = receipt.operations ?? {}
  if (
    !renderer?.home ||
    renderer.appVersion !== receipt.appVersion ||
    renderer.coreBridge !== true ||
    renderer.nodeGlobalsAbsent !== true ||
    !editing?.projectId ||
    !Number.isSafeInteger(editing.registered) ||
    editing.registered < 1
  )
    throw new Error('Incomplete packaged smoke renderer or editor check')
  const seal = receipt.package
  const fuses = packagedFuses(receipt.platform)
  if (!Object.entries(fuses).every(([k, v]) => seal?.fuses?.[k] === v))
    throw new Error('Invalid packaged smoke fuses')
  if (
    receipt.platform === 'darwin' &&
    (seal?.identifier !== 'com.video-edit-agent.desktop' ||
      seal.codesignStrict !== true ||
      seal.runtime?.['Dictation Helper'] !== true ||
      !(seal.sealedCode > 0))
  )
    throw new Error('Invalid packaged smoke signature')
}
