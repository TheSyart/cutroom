/** Apply the editor and recovery window permission policy before a renderer loads. */
import type { Session, WebContents } from 'electron'

const hardenedSessions = new WeakSet<Session>()

export interface HardenOptions {
  allowPermission?(
    contents: WebContents | null,
    permission: string,
    origin: string,
    mediaTypes: readonly string[],
  ): boolean
}

function originOf(url: string | undefined): string {
  try {
    return url === undefined ? '' : new URL(url).origin
  } catch {
    return ''
  }
}

export function hardenSession(
  session: Session,
  options: HardenOptions = {},
): void {
  if (hardenedSessions.has(session)) return
  hardenedSessions.add(session)
  const allow = options.allowPermission
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (allow === undefined) return callback(false)
      const media = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const origin = originOf(details.requestingUrl)
      try {
        callback(allow(contents, permission, origin, media))
      } catch {
        callback(false)
      }
    },
  )
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (allow === undefined) return false
      const media =
        'mediaType' in details &&
        details.mediaType !== undefined &&
        details.mediaType !== 'unknown'
          ? [details.mediaType]
          : []
      try {
        return allow(contents, permission, originOf(requestingOrigin), media)
      } catch {
        return false
      }
    },
  )
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event) => event.preventDefault())
}
