/** Cutroom's editing window may copy text. Dictation records through the native helper. */
export interface DefaultSessionPermissionOptions {
  /**
   * `contents` is the main window's webContents and shows Cutroom's own page
   * (app://bundle or the dev server). Checked on the page itself: the origin
   * Electron reports for app: comes out of Node's URL as "null".
   */
  isTrustedMainRenderer(contents: unknown): boolean
}

const MAIN_WINDOW_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
])

/** An `allowPermission` for session-hardening.ts' hardenSession. */
export function defaultSessionPermission(
  options: DefaultSessionPermissionOptions,
): (
  contents: unknown,
  permission: string,
  origin: string,
  mediaTypes: readonly string[],
) => boolean {
  return (contents, permission) =>
    MAIN_WINDOW_PERMISSIONS.has(permission) &&
    contents !== null &&
    contents !== undefined &&
    options.isTrustedMainRenderer(contents)
}
