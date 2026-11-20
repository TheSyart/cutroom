import { SchedulerMisfirePolicy } from './models'

export interface SchedulerStatusPayload {
  running: boolean
  misfirePolicy: SchedulerMisfirePolicy
  jobs: number
  enabled: number
  nextRunAtMs: number | null
  lastError: string | null
  /** Why the last start failed (KRN-10); null once a start succeeds. */
  startError: string | null
  /** Job entries set aside in `jobs.rejected.json` by this process. */
  rejectedJobs: number
  active: number
  queued: number
  maxConcurrentRuns: number
  maxPerOwner: number
  maxQueuedRuns: number
  shutdownPolicy: 'cancel-and-interrupt'
}
