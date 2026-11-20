export type { MessageReference } from '../harness/host/message-references'
export { motionSceneSchema, motionObjectSchema } from '../editing/motion'
export { CoreApi } from '../api/core-api'
export const renderVideoProject: typeof import('../editing/export').renderVideoProject =
  async (...args) =>
    (await import('../editing/export')).renderVideoProject(...args)
export type { CoreApiCreateOptions } from '../api/core-api'
export { coreOperationKeys, invokeCoreOperation } from '../api/operations'
export type {
  CoreIpcErrorEnvelope,
  RendererOperationArgs as CoreOperationArgs,
  CoreOperationContext,
  RendererOperationKey as CoreOperationKey,
  RendererOperationResult as CoreOperationResult,
} from '../api/operations'
export type { ViewScope } from '../harness/host/scope'
export { EnvironmentError } from '../environment/errors'
// BUG-10: main checks again right before 用默认应用打开.
export { isOpenableFile } from '../workspace/open-policy'
export type {
  CommandCompletion,
  CommandDescriptor,
  CommandInvocationResult,
  CommandSurface,
} from '../commands/types'
export type { MemoryScope } from '../memory/patch'
export type {
  ModelFacts,
  ModelFactsSource,
  ModelKind,
  ReasoningControl,
} from '../model/metadata/lookup'
export type {
  ConnectionFix,
  DiscoveredFactField,
  DiscoveredModel,
  DiscoveryErrorCode,
  ParserId,
  ProbeErrorCode,
  ProbeResult,
} from '../model/discovery'
export type {
  ModelConnectionInput,
  ModelDefaultsInput,
  ModelDiscoveryInput,
  ModelDiscoveryPayload,
  ModelEntriesSaveInput,
  ModelEntryLifecycle,
  ModelEntryReplaceInput,
  ModelMetadataChange,
  ModelMetadataDiff,
  ModelMetadataRefreshInput,
  RejectedModelEntryPayload,
} from '../api/services/model-service'
export type { ModelTestRecord } from '../api/services/model-test-log'
export type {
  ModelEntryDetected,
  ModelEntryLimits,
  ModelEntryMetadata,
  ModelEntrySampling,
  ModelMetadataField,
} from '../config/model-config'
export type {
  CompactionDecision,
  DiscardedItem,
} from '../memory/compaction-models'
export type {
  GitFileStatus,
  GitRemoteInfo,
  GitRemoteProvider,
  GitStatusResult,
} from '../workspace/git'
export type { GitWorktreeSummary } from '../workspace/git-worktrees'
export type { PullRequestSummary } from '../workspace/git-pull-requests'
export type {
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssueListFilter,
  GitHubIssueListItem,
  GitHubIssueListResult,
  GitHubLabel,
  GitHubRunDetail,
  GitHubRunJob,
  GitHubRunListItem,
  GitHubRunListResult,
  PullRequestBrowserStatus,
  PullRequestBrowserUnavailableReason,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestListFilter,
  PullRequestListItem,
  PullRequestListResult,
  PullRequestReviewDecision,
} from '../workspace/pull-request-browser'
export type {
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
} from '../workspace/files'
export type { WorkspaceSnapshot } from '../workspace/snapshot'
export type {
  FilePreviewInput,
  FilePreviewResult,
  FileStatInput,
  FileStatResult,
} from '../workspace/file-preview'
export type { TerminalEvent, TerminalSummary } from '../workspace/terminal'
export type {
  CoreHookAuditRecordPayload,
  CoreHookMatchItemPayload,
  CoreHooksAuditPayload,
  CoreHooksConfigPayload,
  CoreHooksMatchPayload,
  CoreHooksMetadataPayload,
  CoreHooksTestRunPayload,
  CoreHooksValidationPayload,
} from '../api/services/hooks-service'
export type {
  InvalidSkillPayload,
  SkillDeletePayload,
  SkillDetailPayload,
  SkillImportPayload,
  SkillInfoPayload,
  SkillListPayload,
  SkillValidationPayload,
} from '../api/services/skill-service'
export type {
  SkillImportFailure,
  SkillImportFailureCode,
  SkillImportSource,
  ImportedSkill,
} from '../skills/import'
export type { CoreTaskRecord } from '../api/core-api'
export { sanitizeForWire } from '../session-log/history'
export type { RawSessionTap } from '../harness/host/host'
export type {
  SessionHistoryPage,
  WireSessionEvent,
} from '../session-log/history'
export type {
  SessionLineage,
  SubagentChildView,
} from '../harness/host/session-views'

export type { ReferencePreview } from '../workspace/reference-preview'
export type { ReferenceSiteIcon } from '../workspace/reference-site-icon'

export {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
  delegationNeedsExit,
} from '../runtime/agent-view'
export type { AgentView, AgentBackend, AgentPhase } from '../runtime/agent-view'
