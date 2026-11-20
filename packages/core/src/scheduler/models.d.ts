export declare enum SchedulerMisfirePolicy {
  SKIP = 'skip',
  LATEST = 'latest',
  CATCH_UP_ONE = 'catch-up-one',
}
export declare enum SchedulerRunTrigger {
  TIMER = 'timer',
  MANUAL = 'manual',
  MISFIRE = 'misfire',
}
export type SchedulerRunPhase = 'queued' | 'running'
export interface SchedulerSchedulePayload {
  kind: 'at' | 'every' | 'cron'
  atMs: number | null
  everyMs: number | null
  expr: string | null
  tz: string | null
  [key: string]: unknown
}
export interface SchedulerJobPayload {
  kind: 'agent_turn' | 'team_wake' | 'system_event'
  message: string
  target: string | null
  projectId: string | null
  deliver: boolean
  meta: Record<string, unknown>
  [key: string]: unknown
}
export interface SchedulerRunRecordPayload {
  runId: string | null
  taskId: string | null
  runAtMs: number
  scheduledForMs: number
  trigger: SchedulerRunTrigger
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  status: string
  durationMs: number
  error: string | null
  /** The turn's error code (`AUTH`, `RATE_LIMIT`, …) when it failed. */
  errorCode?: string | null
  [key: string]: unknown
}
export interface SchedulerPendingMisfirePayload {
  policy: SchedulerMisfirePolicy
  scheduledForMs: number
  detectedAtMs: number
  missedCount: number
  countCapped: boolean
}
export interface SchedulerActiveRunPayload {
  runId: string
  taskId: string
  phase: SchedulerRunPhase
  trigger: SchedulerRunTrigger
  scheduledForMs: number
  enqueuedAtMs: number
  startedAtMs: number | null
  ownerKeyDigest: string
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  resumeNextRunAtMs: number | null
}
export interface SchedulerJobStatePayload {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: string | null
  lastError: string | null
  runHistory: SchedulerRunRecordPayload[]
  pendingMisfire: SchedulerPendingMisfirePayload | null
  activeRun: SchedulerActiveRunPayload | null
  [key: string]: unknown
}
export interface SchedulerJobViewPayload {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedulePayload
  payload: SchedulerJobPayload
  state: SchedulerJobStatePayload
  createdAtMs: number
  updatedAtMs: number
  deleteAfterRun: boolean
  misfirePolicy: SchedulerMisfirePolicy
  protected: boolean
  purpose: string | null
  [key: string]: unknown
}
export type SchedulerPublicActiveRunPayload = Omit<
  SchedulerActiveRunPayload,
  'ownerKeyDigest' | 'resumeNextRunAtMs'
>
export interface SchedulerPublicJobStatePayload {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: string | null
  lastError: string | null
  runHistory: SchedulerRunRecordPayload[]
  pendingMisfire: SchedulerPendingMisfirePayload | null
  activeRun: SchedulerPublicActiveRunPayload | null
  [key: string]: unknown
}
export interface SchedulerPublicJobViewPayload {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedulePayload
  payload: SchedulerJobPayload
  state: SchedulerPublicJobStatePayload
  createdAtMs: number
  updatedAtMs: number
  deleteAfterRun: boolean
  misfirePolicy: SchedulerMisfirePolicy
  protected: boolean
  purpose: string | null
  [key: string]: unknown
}
export declare class SchedulerSchedule {
  kind: 'at' | 'every' | 'cron'
  at_ms: number | null
  every_ms: number | null
  expr: string | null
  tz: string | null
  constructor(opts: {
    kind: 'at' | 'every' | 'cron'
    at_ms?: number | null
    every_ms?: number | null
    expr?: string | null
    tz?: string | null
  })
  static fromDict(raw: Record<string, any>): SchedulerSchedule
  toDict(): SchedulerSchedulePayload
}
export declare class SchedulerPayload {
  kind: 'agent_turn' | 'team_wake' | 'system_event'
  message: string
  target: string | null
  project_id: string | null
  deliver: boolean
  meta: Record<string, unknown>
  constructor(opts?: {
    kind?: 'agent_turn' | 'team_wake' | 'system_event'
    message?: string
    target?: string | null
    project_id?: string | null
    deliver?: boolean
    meta?: Record<string, unknown>
  })
  static fromDict(raw: Record<string, any>): SchedulerPayload
  toDict(): SchedulerJobPayload
}
export declare class SchedulerPendingMisfire {
  policy: SchedulerMisfirePolicy
  scheduled_for_ms: number
  detected_at_ms: number
  missed_count: number
  count_capped: boolean
  constructor(opts: {
    policy: SchedulerMisfirePolicy
    scheduled_for_ms: number
    detected_at_ms: number
    missed_count: number
    count_capped: boolean
  })
  static fromDict(raw: Record<string, any>): SchedulerPendingMisfire
  toDict(): SchedulerPendingMisfirePayload
}
export declare class SchedulerActiveRun {
  run_id: string
  task_id: string
  phase: SchedulerRunPhase
  trigger: SchedulerRunTrigger
  scheduled_for_ms: number
  enqueued_at_ms: number
  started_at_ms: number | null
  owner_key_digest: string
  misfire_policy: SchedulerMisfirePolicy
  missed_count: number
  count_capped: boolean
  resume_next_run_at_ms: number | null
  constructor(opts: {
    run_id: string
    task_id: string
    phase: SchedulerRunPhase
    trigger: SchedulerRunTrigger
    scheduled_for_ms: number
    enqueued_at_ms: number
    started_at_ms: number | null
    owner_key_digest: string
    misfire_policy: SchedulerMisfirePolicy
    missed_count: number
    count_capped: boolean
    resume_next_run_at_ms: number | null
  })
  static fromDict(raw: Record<string, any>): SchedulerActiveRun
  toDict(): SchedulerActiveRunPayload
}
export declare class SchedulerRunRecord {
  run_id: string | null
  task_id: string | null
  run_at_ms: number
  scheduled_for_ms: number
  trigger: SchedulerRunTrigger
  misfire_policy: SchedulerMisfirePolicy
  missed_count: number
  count_capped: boolean
  status: string
  duration_ms: number
  error: string | null
  error_code: string | null
  constructor(opts: {
    run_id?: string | null
    task_id?: string | null
    run_at_ms: number
    scheduled_for_ms?: number
    trigger?: SchedulerRunTrigger
    misfire_policy?: SchedulerMisfirePolicy
    missed_count?: number
    count_capped?: boolean
    status: string
    duration_ms?: number
    error?: string | null
    error_code?: string | null
  })
  static fromDict(raw: Record<string, any>): SchedulerRunRecord
  toDict(): SchedulerRunRecordPayload
}
export declare class SchedulerJobState {
  next_run_at_ms: number | null
  last_run_at_ms: number | null
  last_status: string | null
  last_error: string | null
  run_history: SchedulerRunRecord[]
  pending_misfire: SchedulerPendingMisfire | null
  active_run: SchedulerActiveRun | null
  constructor(raw?: Partial<SchedulerJobState>)
  static fromDict(raw: Record<string, any>): SchedulerJobState
  toDict(): SchedulerJobStatePayload
  recordRun(opts: {
    runId?: string | null
    taskId?: string | null
    runAtMs: number
    scheduledForMs?: number
    trigger?: SchedulerRunTrigger
    misfirePolicy?: SchedulerMisfirePolicy
    missedCount?: number
    countCapped?: boolean
    status: string
    durationMs?: number
    error?: string | null
    errorCode?: string | null
  }): void
}
export declare class SchedulerJob {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedule
  payload: SchedulerPayload
  state: SchedulerJobState
  created_at_ms: number
  updated_at_ms: number
  delete_after_run: boolean
  misfire_policy: SchedulerMisfirePolicy
  protected: boolean
  purpose: string | null
  constructor(opts: {
    id: string
    name: string
    enabled?: boolean
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    state?: SchedulerJobState
    created_at_ms?: number
    updated_at_ms?: number
    delete_after_run?: boolean
    misfire_policy?: SchedulerMisfirePolicy
    protected?: boolean
    purpose?: string | null
  })
  static create(opts: {
    name: string
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    jobId?: string | null
    deleteAfterRun?: boolean
    misfirePolicy?: SchedulerMisfirePolicy
    protected?: boolean
    purpose?: string | null
    now?: number
  }): SchedulerJob
  static fromDict(raw: Record<string, any>): SchedulerJob
  toDict(): SchedulerJobViewPayload
}
