import { type LocalConfigDiagnostics } from '../../config/local-config'

import type { CoreDesktopPetPayload } from './desktop-pet-service'
import type { HistoricalMcpSnapshot as MCPClientSnapshot } from '../legacy-renderer-operations'
import type { SubagentRecord } from '../../harness/subagent/manager'
import type { EffectiveConfigSnapshot } from '../../config/resolver'
import { type OptionalCapabilityPortfolioEntry } from '../../capabilities/portfolio'
import type { UpdateDiagnostics } from '../../updates/types'
type Dict = Record<string, unknown>
export interface RuntimeStats {
  version: number
  path: string
  bytes: number
  events: number
  latestSeq: number
  latestTs: number | null
  activeTurnEvents: number
  activeTurns: number
  archiveFiles: number
  archiveBytes: number
  archives: unknown[]
  lastArchiveAt: number | null
  hotLimitEvents: number
  hotLimitBytes: number
  needsRotation: boolean
}
export type ActiveTaskKind = 'turn' | 'scheduler' | 'team' | 'watchlist'
export interface ActiveTaskInfo {
  id: string
  kind: ActiveTaskKind
  label: string
  started_at: number
  turn_id: string | null
  job_id: string | null
  session_id: string | null
  cancelled: boolean
}
export interface CoreDiagnosticsPayload {
  root: string
  paths: Dict
  modelConfig: Dict
  localConfig: LocalConfigDiagnostics
  legacyStateMigration: Dict
  projectLegacyPrivateData: Dict | null
  scheduler: Dict
  runtime: RuntimeStats
  workspacePolicy: Dict
  sandbox: Dict
  processRuntime: Dict
  subagents: SubagentRecord[]
  kernel: Dict
  effectiveConfig: EffectiveConfigSnapshot | Dict
  commandCatalog: Dict
  mcp: MCPClientSnapshot
  promptSnapshots: Dict
  activeTasks: ActiveTaskInfo[]
  desktopPet: CoreDesktopPetPayload
  environment: Dict
  dependencies: Dict
  optionalCapabilities: OptionalCapabilityPortfolioEntry[]
  externalToolConfig: Dict
  computerUse: Dict
  updates: UpdateDiagnostics | null
}
