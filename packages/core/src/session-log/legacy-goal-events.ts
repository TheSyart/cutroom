/** Historical session-log payloads, retained to render existing conversations. */

/** Stable goal identity across its durable revisions. */
export type GoalId = string

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Durable continuation phase. Activation is process-local and separate. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Full durable state written by every non-clear goal mutation. */
export interface GoalSnapshot extends GoalRef {
  readonly objective: string
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/** Goal state-changing verbs recorded in the durable change. */
export type GoalOperation =
  'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'

/** Full-snapshot goal mutation committed by a durable `goal/change` event. */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current goal is cleared. */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** Durable reservation of one continuation round for one inbox message. */
export interface GoalRoundReservation {
  readonly goalId: GoalId
  readonly revision: number
  /** Positive round number this message admits when it enters a step. */
  readonly round: number
  /** Id of the queued `<goal_round>` context message. */
  readonly messageId: string
}

declare module './types' {
  interface SessionEventMap {
    /** Complete post-mutation goal state or clear tombstone. */
    'goal/change': GoalChangeMeta
    /** Reservation linking a queued goal-round message to its goal round. */
    'goal/round': GoalRoundReservation
  }
}
