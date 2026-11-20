/** Shape of older diagnostic records. */
export interface CoreDesktopPetPayload {
  enabled: boolean
  autoStartWithWebui: boolean
  running: boolean
  pid: number | null
  lastError: string | null
  installCommand: string
  managedBy: string
  available: boolean
  [key: string]: unknown
}
