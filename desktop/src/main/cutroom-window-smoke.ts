import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '@emperor/core/api'
import { coreOperationKeys } from '@emperor/core/api'

/** Runs only in the packaged smoke's disposable profile. Exercise the shipped UI and its IPC. */
export async function verifyCutroomWindow(
  win: BrowserWindow,
  core: CoreApi,
  stateRoot: string,
  receipt: string,
) {
  if ((await realpath(dirname(receipt))) !== (await realpath(stateRoot)))
    throw new Error('测试回执必须位于临时配置目录')
  const projectPath = join(stateRoot, '剪辑验收')
  await mkdir(projectPath, { recursive: true })
  const project = await core.videoProject.open({
    projectPath,
    initialize: true,
  })
  const result = await win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (query) => {
      const end = Date.now() + 20000
      while (Date.now() < end) {
        const el = document.querySelector(query)
        if (el) return el
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      throw Error('Cutroom UI timed out: ' + query + ' ' + document.body.innerText.slice(0, 220))
    }
    await waitFor('[data-testid="new-project"]')
    const bridge = window.emperor
    const version = await bridge.appVersion()
    const retired = ['openPet','browserOpen','terminalSubscribe','captureScreenshot','vaultUnlock']
    if (retired.some(key => key in bridge)) throw Error('retired preload bridge')
    const nodeGlobalsAbsent = typeof window.require === 'undefined' && typeof window.process === 'undefined'
    if (!nodeGlobalsAbsent) throw Error('Node globals visible in renderer')
    return {version, home: true, coreBridge: typeof bridge.invokeCore === 'function' && bridge.sandboxed === true, nodeGlobalsAbsent}
  })()`)
  const keys = coreOperationKeys()
  const retired =
    /^(git|terminal[s]?|mcp|scheduler|computerUse|executors|delegations|desktopPet|pullRequests|browser)\./
  if (keys.some((key) => retired.test(key)))
    throw new Error('退役接口仍然在正式包注册')
  await writeFile(
    receipt,
    JSON.stringify(
      {
        ...result,
        operations: keys.length,
        projectId: project.project.projectId,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  )
}
