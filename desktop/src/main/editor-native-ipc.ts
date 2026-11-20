import {
  EXTERNAL_OPEN_CHANNEL,
  LINK_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  type FileDialogFilter,
} from '../shared/ipc-contract'

export function registerEditorNativeIpc(input: {
  ipcMain: {
    handle(
      channel: string,
      listener: (event: unknown, payload?: unknown) => unknown,
    ): void
  }
  authorize(event: unknown): void
  references: {
    revealPath(input: { sessionId: string; referenceId: string }): string
  }
  showItemInFolder(path: string): void
  openExternal(url: string): Promise<unknown>
  openLink(url: string): Promise<'system' | 'refused'>
  skills: {
    folderPath(input: {
      scope: 'user' | 'project'
      sessionId: string | null
    }): string
  }
  openPath(path: string): Promise<string>
  selectFile(options: {
    title?: string
    filters: FileDialogFilter[]
    multiple?: boolean
  }): Promise<string | string[] | null>
}) {
  const { authorize, skills, openPath, selectFile } = input
  if (skills && openPath)
    input.ipcMain.handle(SKILLS_OPEN_FOLDER_CHANNEL, async (event, payload) => {
      authorize(event)
      const request = skillFolderRequest(payload)
      let path: string
      try {
        path = skills.folderPath(request)
      } catch (error) {
        return { ok: false, ...safeError(error) }
      }
      const error = await openPath(path)
      return error ? { ok: false, error, path } : { ok: true, path }
    })
  if (selectFile)
    input.ipcMain.handle(SELECT_FILE_CHANNEL, async (event, payload) => {
      authorize(event)
      return await selectFile(fileDialogOptions(payload))
    })

  input.ipcMain.handle(REFERENCE_REVEAL_CHANNEL, (event, payload) => {
    authorize(event)
    const reference = referenceIdentity(payload)
    const path = input.references.revealPath(reference)
    input.showItemInFolder(path)
    return { ok: true }
  })
  input.ipcMain.handle(EXTERNAL_OPEN_CHANNEL, async (event, payload) => {
    authorize(event)
    const url = eligibleExternalUrl(payload)
    await input.openExternal(url)
    return { ok: true }
  })
  const openLink = input.openLink
  if (openLink)
    input.ipcMain.handle(LINK_OPEN_CHANNEL, async (event, payload) => {
      authorize(event)
      const url = typeof payload === 'string' ? payload.slice(0, 4096) : ''
      const opened = await openLink(url)
      return { ok: opened !== 'refused', opened }
    })
}

function referenceIdentity(value: unknown): {
  sessionId: string
  referenceId: string
} {
  const record = objectRecord(value)
  return {
    sessionId: requiredIdentity(record.sessionId, 'session'),
    referenceId: requiredIdentity(record.referenceId, 'reference'),
  }
}

function skillFolderRequest(value: unknown): {
  scope: 'user' | 'project'
  sessionId: string | null
} {
  const record = objectRecord(value)
  if (record.scope !== 'user' && record.scope !== 'project')
    throw new Error('invalid Skills folder scope')
  return {
    scope: record.scope,
    sessionId:
      record.sessionId === undefined || record.sessionId === null
        ? null
        : requiredIdentity(record.sessionId, 'session'),
  }
}

function fileDialogOptions(value: unknown): {
  title?: string
  filters: FileDialogFilter[]
  multiple?: boolean
} {
  const record =
    value === undefined || value === null ? {} : objectRecord(value)
  const title =
    typeof record.title === 'string' ? record.title.trim().slice(0, 120) : ''
  const rawFilters = Array.isArray(record.filters) ? record.filters : []
  if (rawFilters.length > 8) throw new Error('invalid file dialog filters')
  const filters = rawFilters.map((item) => {
    const filter = objectRecord(item)
    const name = typeof filter.name === 'string' ? filter.name.trim() : ''
    const extensions = Array.isArray(filter.extensions) ? filter.extensions : []
    if (
      !name ||
      name.length > 64 ||
      extensions.length === 0 ||
      extensions.length > 16 ||
      !extensions.every(
        (ext) =>
          typeof ext === 'string' && /^(?:\*|[A-Za-z0-9]{1,16})$/.test(ext),
      )
    )
      throw new Error('invalid file dialog filters')
    return { name, extensions: extensions as string[] }
  })
  if (record.multiple !== undefined && typeof record.multiple !== 'boolean')
    throw new Error('invalid file dialog multiple option')
  return {
    ...(title ? { title } : {}),
    filters,
    ...(record.multiple === true ? { multiple: true } : {}),
  }
}

/** Message and code of a Core domain error (`toSafe()`), else a generic one. */
function safeError(error: unknown): { error: string; code?: string } {
  const toSafe =
    error && typeof error === 'object'
      ? (error as { toSafe?: unknown }).toSafe
      : undefined
  if (typeof toSafe === 'function') {
    const payload = toSafe.call(error) as {
      message?: unknown
      code?: unknown
    } | null
    if (payload && typeof payload.message === 'string' && payload.message)
      return {
        error: payload.message,
        ...(typeof payload.code === 'string' && payload.code
          ? { code: payload.code }
          : {}),
      }
  }
  return { error: 'Skills folder is unavailable' }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid capability input')
  return value as Record<string, unknown>
}

function requiredIdentity(value: unknown, kind: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 256)
    throw new Error(`invalid ${kind} identity`)
  return result
}

/**
 * What the renderer may hand to the system: a non-local http(s) address, or
 * a mailto: / tel: link from a reply (SEC-05). Other schemes (sms:,
 * facetime:, x-apple.systempreferences: …) are refused.
 */
function eligibleExternalUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  if (/^(?:mailto|tel):/i.test(raw)) {
    // eslint-disable-next-line no-control-regex
    if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw))
      throw new Error('invalid external url')
    return raw
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid external url')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback =
    host === 'localhost' || host === '::1' || host.startsWith('127.')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    loopback
  )
    throw new Error('invalid external url')
  return url.toString()
}
