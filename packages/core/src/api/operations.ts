import { z } from 'zod'
import { analysisConfigSchema } from '../editing/analysis/config'

import type { CoreApi } from './core-api'
import {
  videoProjectImportInputSchema,
  videoProjectMetadataInputSchema,
  videoProjectMutateInputSchema,
  videoProjectOpenInputSchema,
  videoProjectRelinkInputSchema,
  videoProjectRemoveMissingAssetInputSchema,
  videoProjectRevisionInputSchema,
  videoProjectTranscribeInputSchema,
  videoProjectTranscriptInputSchema,
  videoProjectFramesInputSchema,
} from '../editing/types'
import { timelineSnapshotSchema } from '../editing/timeline-reference'
import { SessionRequiredError, type ViewScope } from '../harness/host/scope'
import {
  MAX_MESSAGE_REFERENCES,
  referencesFit,
} from '../harness/host/message-references'
import { SKILL_NAME, SKILL_NAME_MAX_LENGTH } from '../skills/name'
import { isDraftSessionId } from '../sessions/constants'

const dictSchema = z.record(z.string(), z.unknown())
const idSchema = z.string().trim().min(1)
const sessionLogIdSchema = idSchema
  .max(256)
  .refine(
    (value) =>
      /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(value) && !value.includes('..'),
    'invalid session id',
  )
const sessionHistorySchema = z
  .object({
    sessionId: sessionLogIdSchema,
    beforeSeq: z.number().int().nonnegative().optional(),
    maxMessages: z.number().int().min(1).max(500).optional(),
  })
  .strict()
const sessionRefSchema = z.object({ sessionId: sessionLogIdSchema }).strict()
const sessionEventSchema = z
  .object({
    sessionId: sessionLogIdSchema,
    seq: z.number().int().nonnegative(),
  })
  .strict()
const sessionWatchSchema = z
  .object({ sessionIds: z.array(sessionLogIdSchema).max(64) })
  .strict()
const skillNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+$/, 'invalid skill name')
const creatorSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(SKILL_NAME, 'invalid skill name')
/** Skill names of read/write ops; the service reports rule violations with reasons. */
const skillOpNameSchema = z.string().trim().min(1).max(128)
const skillScopeSchema = z.enum(['user', 'project'])
const skillSessionOptionsSchema = z
  .object({ sessionId: sessionLogIdSchema.nullable().optional() })
  .strict()
const skillContentSchema = z.string().max(1_048_576)
const skillCreateSchema = z
  .object({
    name: creatorSkillNameSchema,
    description: z.string().trim().min(1).max(1_024),
    resources: z
      .array(z.enum(['scripts', 'references', 'assets']))
      .max(3)
      .optional(),
  })
  .strict()
const skillValidateSchema = z
  .object({
    name: skillOpNameSchema.optional(),
    content: skillContentSchema.optional(),
    sessionId: sessionLogIdSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.content !== undefined,
    'name or content is required',
  )
const skillDeleteOptionsSchema = z
  .object({
    sessionId: sessionLogIdSchema.nullable().optional(),
    scope: skillScopeSchema.nullable().optional(),
  })
  .strict()
const skillImportSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('content'),
      content: skillContentSchema.min(1),
      name: z.string().trim().max(128).nullable().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('folder'), path: z.string().min(1).max(4_096) })
    .strict(),
  z
    .object({ kind: z.literal('zip'), path: z.string().min(1).max(4_096) })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z.string().url().startsWith('https://').max(2_048),
    })
    .strict(),
])
const skillImportSchema = z
  .object({
    source: skillImportSourceSchema,
    scope: skillScopeSchema,
    sessionId: sessionLogIdSchema.nullable().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
const skillCopyToUserSchema = z
  .object({
    name: skillOpNameSchema,
    sessionId: sessionLogIdSchema.nullable().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
const nullableStringSchema = z.string().nullable().optional()
const numberLikeSchema = z.union([z.number(), z.string()]).nullable().optional()
const booleanLikeSchema = z
  .union([z.boolean(), z.string()])
  .nullable()
  .optional()

const modelProtocolSchema = z.enum(['openai', 'anthropic'])
const modelCapabilityOverridesSchema = z
  .object({
    toolCall: z.boolean().optional(),
    vision: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict()
const modelPricingSchema = z
  .object({
    inputUsdPerMillionTokens: z.number().finite().nonnegative(),
    outputUsdPerMillionTokens: z.number().finite().nonnegative(),
    cacheReadUsdPerMillionTokens: z.number().finite().nonnegative(),
    cacheWriteUsdPerMillionTokens: z.number().finite().nonnegative(),
  })
  .strict()
const modelExecutionPolicySchema = z
  .object({
    fallback: z
      .object({
        enabled: z.boolean(),
        entryId: idSchema.nullable(),
        triggerOn: z
          .array(z.enum(['rate_limit', 'transient']))
          .min(1)
          .max(2),
      })
      .strict(),
    cost: z
      .object({
        maxUsdPerAgentTurn: z.number().finite().positive().nullable(),
      })
      .strict(),
  })
  .strict()
/** Fields a user can lock against metadata refreshes (MOD-03). */
const modelMetadataFieldSchema = z.enum([
  'contextWindowTokens',
  'maxTokens',
  'pricing',
  'capabilities',
  'reasoningEffort',
  'displayName',
])
const modelEntrySaveSchema = z
  .object({
    entryId: idSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    protocol: modelProtocolSchema.optional(),
    modelId: z.string().trim().min(1).optional(),
    displayName: z.string().trim().optional(),
    apiBase: z.string().trim().min(1).optional(),
    apiKey: z.string().nullable().optional(),
    capabilityOverrides: modelCapabilityOverridesSchema.optional(),
    pricing: modelPricingSchema.nullable().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoningEffort: z.string().trim().nullable().optional(),
    // KRN-07: keep a DeepSeek entry on chat-completions; null clears it.
    transport: z.enum(['chat-completions']).nullable().optional(),
    credentialsFrom: idSchema.optional(),
    // MOD-05: the editor's temperature (null removes it) and the fields the
    // user changed, which metadata refreshes then leave alone.
    sampling: z
      .object({ temperature: z.number().min(0).max(2).nullable().optional() })
      .strict()
      .optional(),
    lockFields: z.array(modelMetadataFieldSchema).max(6).optional(),
  })
  .strict()
const modelEntryReplaceSchema = z
  .object({ entryId: idSchema, modelId: z.string().trim().min(1).max(200) })
  .strict()
const modelEntryIdSchema = z.object({ entryId: idSchema }).strict()
const modelReasoningEffortSchema = z
  .object({
    entryId: idSchema,
    reasoningEffort: z.string().trim().min(1).nullable(),
  })
  .strict()
// A draft connection from the add-model form (MOD-02, UI-29): the typed
// key wins; entryId / connectionId only lend a saved key to the same
// provider, protocol and API base.
const modelConnectionShape = {
  entryId: idSchema.optional(),
  connectionId: idSchema.optional(),
  provider: z.string().trim().min(1).optional(),
  protocol: modelProtocolSchema.optional(),
  apiBase: z.string().trim().optional(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  workspaceId: z.string().trim().max(63).optional(),
}
const modelDiscoverySchema = z
  .object({ ...modelConnectionShape, refresh: z.boolean().optional() })
  .strict()
const modelProbeSchema = z.object(modelConnectionShape).strict()
// MOD-03: the optional facts an entry carries (validated leniently again
// when the entry is normalized; unknown keys are refused here).
const modelEntryFactsShape = {
  limits: z
    .object({
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  detected: z
    .object({
      toolCall: z.boolean().optional(),
      vision: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      reasoningEfforts: z.array(z.string().trim().min(1)).optional(),
      defaultReasoningEffort: z.string().trim().min(1).optional(),
      reasoningControl: z
        .enum(['effort', 'toggle', 'budget', 'always'])
        .optional(),
      acceptsTemperature: z.boolean().optional(),
      modalities: z.array(z.string().trim().min(1)).optional(),
      kind: z
        .enum(['chat', 'embedding', 'rerank', 'image', 'audio', 'other'])
        .optional(),
    })
    .strict()
    .optional(),
  metadata: z
    .object({
      name: z.string().trim().optional(),
      source: z.enum([
        'vendor_api',
        'catalog',
        'family_rule',
        'fallback',
        'manual',
      ]),
      catalogKey: z.string().optional(),
      catalogVersion: z.string().optional(),
      checkedAt: z.string().optional(),
      userLocked: z.array(modelMetadataFieldSchema).optional(),
      pricingSource: z.enum(['catalog', 'vendor_api', 'manual']).optional(),
      lifecycle: z
        .object({
          status: z.enum(['active', 'deprecated', 'retired']).optional(),
          retiresAt: z.string().optional(),
          replacement: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  sampling: z
    .object({
      temperature: z.number().min(0).max(2).nullable().optional(),
      topP: z.number().min(0).max(1).nullable().optional(),
    })
    .strict()
    .optional(),
}
const modelEntriesSaveSchema = z
  .object({
    connection: z
      .object({
        provider: z.string().trim().min(1),
        protocol: modelProtocolSchema,
        apiBase: z.string().trim().min(1),
        apiKey: z.string().nullable().optional(),
      })
      .strict(),
    entries: z
      .array(
        z
          .object({
            entryId: idSchema.optional(),
            modelId: z.string().trim().min(1),
            displayName: z.string().trim().optional(),
            capabilityOverrides: modelCapabilityOverridesSchema.optional(),
            pricing: modelPricingSchema.nullable().optional(),
            contextWindowTokens: z.number().int().positive(),
            maxTokens: z.number().int().positive(),
            reasoningEffort: z.string().trim().nullable().optional(),
            ...modelEntryFactsShape,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    activateEntryId: idSchema.nullable().optional(),
  })
  .strict()
const modelConnectionUpdateSchema = z
  .object({
    connectionId: idSchema.optional(),
    entryId: idSchema.optional(),
    apiKey: z.string().nullable().optional(),
    apiBase: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.connectionId || value.entryId), {
    message: 'connectionId 或 entryId 必须提供一个',
  })
const modelMetadataRefreshSchema = z
  .object({
    entryIds: z.array(idSchema).min(1).max(200).optional(),
    connectionId: idSchema.optional(),
    apply: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.entryIds?.length || value.connectionId), {
    message: 'entryIds 或 connectionId 必须提供一个',
  })
const modelDefaultsSchema = z
  .object({
    provider: z.string().trim().min(1),
    protocol: modelProtocolSchema,
    apiBase: z.string().trim().optional(),
    modelId: z.string().trim().min(1),
  })
  .strict()
const modelRejectedKeySchema = z
  .object({ key: z.string().trim().min(1).max(200) })
  .strict()
const modelProfilePreviewSchema = z
  .object({
    provider: z.string().trim().min(1),
    protocol: modelProtocolSchema,
    modelId: z.string().trim().min(1),
    capabilityOverrides: modelCapabilityOverridesSchema.optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict()

const controlResumeSchema = z
  .object({
    clientMessageId: nullableStringSchema,
    turnId: nullableStringSchema,
    displayContent: nullableStringSchema,
    uiHidden: z.boolean().nullable().optional(),
    delivery: z.enum(['queue', 'interject']).nullable().optional(),
  })
  .strict()

const queuedPromptSessionSchema = z
  .object({ sessionId: z.string().trim().min(1) })
  .strict()

const manageQueuedPromptSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    promptId: z.string().trim().min(1),
    action: z.enum(['cancel', 'interject', 'send']),
  })
  .strict()

const commandInvocationSourceSchema = z.enum(['desktop', 'automation', 'acp'])
/** Chips in a message's text (E-track contract §2). */
const referenceFields = {
  id: z.string().min(1).max(160),
  label: z.string().max(80),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
}
const messageReferencesSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({ ...referenceFields, kind: z.literal('skill') }).strict(),
      z
        .object({
          ...referenceFields,
          kind: z.literal('timeline'),
          timeline: timelineSnapshotSchema,
        })
        .strict(),
    ]),
  )
  .max(MAX_MESSAGE_REFERENCES)

const commandInvokeSchema = z
  .object({
    sessionId: idSchema,
    commandId: idSchema,
    rawInput: z.string().trim().min(1).max(16_384),
    invocationId: idSchema,
    invocationSource: commandInvocationSourceSchema,
    attachments: z.array(idSchema).max(64).optional(),
    references: messageReferencesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.references === undefined ||
      referencesFit(value.rawInput, value.references),
    { message: 'references do not match the input', path: ['references'] },
  )
const workspaceRelativePathSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'invalid workspace path')
const workspaceFileReadSchema = z
  .object({
    sessionId: idSchema,
    relativePath: workspaceRelativePathSchema,
    turn: z.number().int().nonnegative().optional(),
  })
  .strict()
const filePreviewSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('project'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('turn'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
      turn: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      source: z.literal('reference'),
      sessionId: idSchema,
      referenceId: idSchema,
    })
    .strict(),
  z
    .object({ source: z.literal('attachment'), attachmentId: idSchema })
    .strict(),
])
const fileStatSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('project'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('reference'),
      sessionId: idSchema,
      referenceId: idSchema,
    })
    .strict(),
])
const referenceResolveSchema = z
  .object({
    sessionId: idSchema,
    delegationId: z
      .string()
      .regex(/^dlg-[a-zA-Z0-9-]+$/)
      .optional(),
    sourceMessageId: idSchema,
    href: z.string().trim().min(1).max(4_096),
    label: z.string().max(500),
  })
  .strict()

/** The three permission presets (`control.setPermissionMode`). */
const permissionPresetSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

const draftSessionSchema = z
  .object({
    mode: nullableStringSchema,
    project: z
      .object({
        project_id: nullableStringSchema,
        project_path: nullableStringSchema,
        project_name: nullableStringSchema,
      })
      .strict()
      .nullable()
      .optional(),
    // FIX-13: the draft's own plan mode and preset, set before its first turn.
    plan: z.boolean().optional(),
    preset: permissionPresetSchema.optional(),
  })
  .strict()

const chatSubmitSchema = z
  .object({
    content: z.string(),
    turnId: nullableStringSchema,
    displayContent: nullableStringSchema,
    clientMessageId: nullableStringSchema,
    sessionId: nullableStringSchema,
    uiHidden: z.boolean().nullable().optional(),
    clientDraftId: nullableStringSchema,
    draftSession: draftSessionSchema.nullable().optional(),
    attachments: z.array(z.string()).optional(),
    requestedSkills: z
      .array(
        z
          .object({
            name: skillNameSchema,
            source: z.string().optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    references: messageReferencesSchema.optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      value.references === undefined ||
      referencesFit(value.displayContent ?? value.content, value.references),
    { message: 'references do not match the content', path: ['references'] },
  )

/**
 * `commands.list` / `commands.complete` name a session, or a start-page draft
 * by its id (`draft:<uuid>`) with the mode and project its session will get,
 * as `chat.submit` carries them (FIX-14). The draft context
 * goes with a draft id only.
 */
const commandOwnerFits = (value: {
  sessionId: string
  draftSession?: unknown
}): boolean => value.draftSession == null || isDraftSessionId(value.sessionId)
const commandOwnerIssue = {
  message: 'draftSession goes with a draft session id',
  path: ['draftSession'],
}
const commandListSchema = z
  .object({
    sessionId: idSchema,
    draftSession: draftSessionSchema.nullable().optional(),
    includeUnavailable: z.boolean().optional(),
    invocationSource: commandInvocationSourceSchema.optional(),
  })
  .strict()
  .refine(commandOwnerFits, commandOwnerIssue)
const commandCompleteSchema = z
  .object({
    sessionId: idSchema,
    draftSession: draftSessionSchema.nullable().optional(),
    commandId: idSchema,
    rawArgs: z.string().max(8_192),
    cursor: z.number().int().min(0).max(8_192),
    invocationSource: commandInvocationSourceSchema,
  })
  .strict()
  .refine(commandOwnerFits, commandOwnerIssue)

const runtimeReplayOptionsSchema = z
  .object({
    sessionId: nullableStringSchema,
    afterSeq: numberLikeSchema,
    after_seq: numberLikeSchema,
    limit: numberLikeSchema,
    includeArchive: booleanLikeSchema,
    include_archive: booleanLikeSchema,
    compact: booleanLikeSchema,
    format: z.literal('projection').optional(),
  })
  .strict()

const sessionPatchSchema = z.union([
  z.string(),
  z
    .object({
      title: nullableStringSchema,
      archived: z.boolean().nullable().optional(),
    })
    .strict(),
])

type AnyArgsSchema = z.ZodType<unknown[]>

/**
 * What travels with a call besides its arguments (KRN-01): the session the
 * calling UI shows. The desktop passes it with every call; an operation
 * whose input names no session uses it, and one that needs a session gets
 * `SESSION_REQUIRED` when there is neither.
 */
export interface CoreOperationContext {
  readonly view?: ViewScope
}

export interface CoreOperationSpec<Schema extends AnyArgsSchema, Result> {
  readonly args: Schema
  readonly audience: 'main_renderer'
  readonly classification: 'application_operation'
  readonly invoke: (
    api: CoreApi,
    args: z.output<Schema>,
    context: CoreOperationContext,
  ) => Result
  readonly parseAndInvoke: (
    api: CoreApi,
    input: unknown,
    context: CoreOperationContext,
  ) => Result
}

function operation<Schema extends AnyArgsSchema, Result>(
  args: Schema,
  invoke: (
    api: CoreApi,
    args: z.output<Schema>,
    context: CoreOperationContext,
  ) => Result,
): CoreOperationSpec<Schema, Result> {
  return {
    args,
    audience: 'main_renderer',
    classification: 'application_operation',
    invoke,
    parseAndInvoke: (api, input, context) =>
      invoke(api, args.parse(input), context),
  }
}

/** The session an input names, else the one the caller shows (KRN-01). */
function sessionOf(
  sessionId: string | null | undefined,
  context: CoreOperationContext,
): string | null | undefined {
  return sessionId !== undefined ? sessionId : context.view?.sessionId
}

/** A named session, else the caller's (null: none in view); `SESSION_REQUIRED` with neither. */
function requiredSession(
  sessionId: string | null | undefined,
  context: CoreOperationContext,
  operation: string,
): string | null {
  const resolved = sessionOf(sessionId, context)
  if (resolved === undefined) throw new SessionRequiredError(operation)
  return resolved
}

/** The caller's view; `SESSION_REQUIRED` when the call carries none. */
function viewOf(context: CoreOperationContext, operation: string): ViewScope {
  if (context.view === undefined) throw new SessionRequiredError(operation)
  return context.view
}

/** An input with its session filled in from the caller's view when it names none. */
function withSession<T extends { sessionId?: string | null }>(
  input: T,
  context: CoreOperationContext,
  operation: string,
): T & { sessionId: string | null } {
  const sessionId = sessionOf(input.sessionId, context)
  if (sessionId === undefined) throw new SessionRequiredError(operation)
  return { ...input, sessionId }
}

export const CORE_OPERATION_REGISTRY = {
  'attachments.rawPath': operation(z.tuple([idSchema]), (api, [id]) =>
    api.attachments.rawPath(id),
  ),
  'attachments.save': operation(
    z.tuple([
      z
        .object({
          raw: z.instanceof(Uint8Array),
          name: z.string(),
          mime: z.string(),
        })
        .strict(),
    ]),
    (api, [input]) => api.attachments.save(input),
  ),
  bootstrap: operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [options]) => api.bootstrap(options),
  ),
  'chat.stopRuntime': operation(
    z.tuple([
      z
        .object({
          taskId: nullableStringSchema,
          kind: z
            .enum(['turn', 'scheduler', 'watchlist', 'job', 'subagent'])
            .nullable()
            .optional(),
          sessionId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.chat.stopRuntime(options),
  ),
  'chat.submit': operation(z.tuple([chatSubmitSchema]), (api, [input]) =>
    api.chat.submit(input),
  ),
  'chat.listQueuedPrompts': operation(
    z.tuple([queuedPromptSessionSchema]),
    (api, [input]) => api.chat.listQueuedPrompts(input),
  ),
  'chat.manageQueuedPrompt': operation(
    z.tuple([manageQueuedPromptSchema]),
    (api, [input]) => api.chat.manageQueuedPrompt(input),
  ),
  'commands.complete': operation(
    z.tuple([commandCompleteSchema]),
    (api, [input]) => api.commands.complete(input),
  ),
  'commands.invoke': operation(z.tuple([commandInvokeSchema]), (api, [input]) =>
    api.commands.invoke(input),
  ),
  'commands.list': operation(z.tuple([commandListSchema]), (api, [input]) =>
    api.commands.list(input),
  ),
  'config.get': operation(z.tuple([]), (api) => api.config.get()),
  'config.save': operation(
    z.tuple([
      z
        .union([
          z.string(),
          z.object({ content: z.unknown().optional() }).passthrough(),
        ])
        .optional(),
    ]),
    (api, [input], ctx) => api.config.save(input, viewOf(ctx, 'config.save')),
  ),
  'control.answerInteraction': operation(
    z.tuple([idSchema, dictSchema, controlResumeSchema.optional()]),
    (api, [id, answers, options]) =>
      api.control.answerInteraction(id, answers, options),
  ),
  'control.approvePlan': operation(
    z.tuple([idSchema, controlResumeSchema.optional()]),
    (api, [id, options]) => api.control.approvePlan(id, options),
  ),
  'control.cancelInteraction': operation(z.tuple([idSchema]), (api, [id]) =>
    api.control.cancelInteraction(id),
  ),
  'control.commentPlan': operation(
    z.tuple([idSchema, z.string(), controlResumeSchema.optional()]),
    (api, [id, comment, options]) =>
      api.control.commentPlan(id, comment, options),
  ),
  'control.get': operation(
    z.tuple([nullableStringSchema]),
    (api, [sessionId], ctx) =>
      api.control.get(requiredSession(sessionId, ctx, 'control.get')),
  ),
  'control.setPermissionMode': operation(
    z.tuple([permissionPresetSchema, nullableStringSchema]),
    (api, [preset, sessionId], ctx) =>
      api.control.setPermissionMode(
        preset,
        requiredSession(sessionId, ctx, 'control.setPermissionMode') ?? '',
      ),
  ),
  'control.setMode': operation(
    z.tuple([z.enum(['plan', 'default']), nullableStringSchema]),
    (api, [mode, sessionId], ctx) =>
      api.control.setMode(
        mode,
        requiredSession(sessionId, ctx, 'control.setMode') ?? '',
      ),
  ),
  'files.read': operation(z.tuple([workspaceFileReadSchema]), (api, [input]) =>
    api.files.read(input),
  ),
  'files.preview': operation(z.tuple([filePreviewSchema]), (api, [input]) =>
    api.files.preview(input),
  ),
  'files.mediaUrl': operation(z.tuple([filePreviewSchema]), (api, [input]) =>
    api.files.mediaUrl(input),
  ),
  'files.stat': operation(z.tuple([fileStatSchema]), (api, [input]) =>
    api.files.stat(input),
  ),
  'memory.compact': operation(
    z.tuple([
      z
        .object({
          force: z.boolean().optional(),
          sessionId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options], ctx) =>
      api.memory.compact(withSession(options ?? {}, ctx, 'memory.compact')),
  ),
  'memory.explainContext': operation(
    z.tuple([
      z
        .object({
          sessionId: nullableStringSchema,
          turnId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options], ctx) =>
      api.memory.explainContext(
        withSession(options ?? {}, ctx, 'memory.explainContext'),
      ),
  ),
  'memory.get': operation(z.tuple([]), (api, _args, ctx) =>
    api.memory.get(viewOf(ctx, 'memory.get')),
  ),
  'memory.getEpisode': operation(
    z.tuple([nullableStringSchema]),
    (api, [date]) => api.memory.getEpisode(date),
  ),
  'memory.getVersion': operation(z.tuple([idSchema]), (api, [id]) =>
    api.memory.getVersion(id),
  ),
  'memory.listVersions': operation(
    z.tuple([
      z
        .object({
          limit: z.number().int().nonnegative().optional(),
          target: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.memory.listVersions(options),
  ),
  'memory.restoreVersion': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.memory.restoreVersion(id, viewOf(ctx, 'memory.restoreVersion')),
  ),
  'memory.save': operation(z.tuple([z.string()]), (api, [content]) =>
    api.memory.save(content),
  ),
  'memory.saveEpisode': operation(
    z.tuple([z.string(), nullableStringSchema]),
    (api, [content, date]) => api.memory.saveEpisode(content, date),
  ),
  'memory.tokens': operation(z.tuple([]), (api, _args, ctx) =>
    api.memory.tokens(viewOf(ctx, 'memory.tokens')),
  ),
  'model.activate': operation(
    z.tuple([modelEntryIdSchema]),
    (api, [input], ctx) =>
      api.model.activate(input, viewOf(ctx, 'model.activate')),
  ),
  'model.deleteEntry': operation(
    z.tuple([modelEntryIdSchema]),
    (api, [input], ctx) =>
      api.model.deleteEntry(input, viewOf(ctx, 'model.deleteEntry')),
  ),
  'model.discoverModels': operation(
    z.tuple([modelDiscoverySchema]),
    (api, [input]) => api.model.discoverModels(input),
  ),
  'model.getConfig': operation(z.tuple([]), (api) => api.model.getConfig()),
  'model.probeConnection': operation(
    z.tuple([modelProbeSchema]),
    (api, [input]) => api.model.probeConnection(input),
  ),
  'model.resolveProfile': operation(
    z.tuple([modelProfilePreviewSchema]),
    (api, [input]) => api.model.resolveProfile(input),
  ),
  'model.saveEntry': operation(
    z.tuple([modelEntrySaveSchema]),
    (api, [input], ctx) =>
      api.model.saveEntry(input, viewOf(ctx, 'model.saveEntry')),
  ),
  'model.saveEntries': operation(
    z.tuple([modelEntriesSaveSchema]),
    (api, [input], ctx) =>
      api.model.saveEntries(input, viewOf(ctx, 'model.saveEntries')),
  ),
  'model.updateConnection': operation(
    z.tuple([modelConnectionUpdateSchema]),
    (api, [input], ctx) =>
      api.model.updateConnection(input, viewOf(ctx, 'model.updateConnection')),
  ),
  'model.refreshMetadata': operation(
    z.tuple([modelMetadataRefreshSchema]),
    (api, [input], ctx) =>
      api.model.refreshMetadata(input, viewOf(ctx, 'model.refreshMetadata')),
  ),
  'model.replaceEntry': operation(
    z.tuple([modelEntryReplaceSchema]),
    (api, [input], ctx) =>
      api.model.replaceEntry(input, viewOf(ctx, 'model.replaceEntry')),
  ),
  'model.lookupDefaults': operation(
    z.tuple([modelDefaultsSchema]),
    (api, [input]) => api.model.lookupDefaults(input),
  ),
  'model.discardRejected': operation(
    z.tuple([modelRejectedKeySchema]),
    (api, [input], ctx) =>
      api.model.discardRejected(input, viewOf(ctx, 'model.discardRejected')),
  ),
  'model.savePolicy': operation(
    z.tuple([modelExecutionPolicySchema]),
    (api, [input], ctx) =>
      api.model.savePolicy(input, viewOf(ctx, 'model.savePolicy')),
  ),
  'model.setReasoningEffort': operation(
    z.tuple([modelReasoningEffortSchema]),
    (api, [input], ctx) =>
      api.model.setReasoningEffort(
        input,
        viewOf(ctx, 'model.setReasoningEffort'),
      ),
  ),
  'model.test': operation(
    z.tuple([
      z
        .object({
          entryId: idSchema,
          kind: z.enum(['text', 'vision']).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.model.test(input),
  ),
  'projects.list': operation(z.tuple([]), (api) => api.projects.list()),
  'projects.resolve': operation(z.tuple([z.string()]), (api, [path]) =>
    api.projects.resolve(path),
  ),
  'runtime.replay': operation(
    z.tuple([runtimeReplayOptionsSchema.optional()]),
    (api, [options], ctx) =>
      api.runtime.replay(withSession(options ?? {}, ctx, 'runtime.replay')),
  ),
  'sessions.activate': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.activate(id),
  ),
  'sessions.children': operation(z.tuple([sessionRefSchema]), (api, [input]) =>
    api.sessions.children(input),
  ),
  'sessions.create': operation(
    z.tuple([
      z
        .object({
          title: z.string().optional(),
          mode: z.string().optional(),
          project: dictSchema.nullable().optional(),
          project_path: nullableStringSchema,
          plan: z.boolean().optional(),
          preset: permissionPresetSchema.optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.sessions.create(options),
  ),
  'sessions.delete': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.delete(id),
  ),
  'sessions.listDeleted': operation(z.tuple([]), (api) =>
    api.sessions.listDeleted(),
  ),
  'sessions.defaults': operation(z.tuple([]), (api) => api.sessions.defaults()),
  'sessions.setDefaults': operation(
    z.tuple([
      z
        .object({
          permission: z.enum([
            'read-only',
            'workspace-write',
            'danger-full-access',
          ]),
        })
        .strict(),
    ]),
    (api, [change], ctx) =>
      api.sessions.setDefaults(change, viewOf(ctx, 'sessions.setDefaults')),
  ),
  'sessions.restoreDeleted': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.restoreDeleted(id),
  ),
  'sessions.purgeDeleted': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.purgeDeleted(id),
  ),
  'sessions.event': operation(z.tuple([sessionEventSchema]), (api, [input]) =>
    api.sessions.event(input),
  ),
  'sessions.history': operation(
    z.tuple([sessionHistorySchema]),
    (api, [input]) => api.sessions.history(input),
  ),
  'sessions.lineage': operation(z.tuple([sessionRefSchema]), (api, [input]) =>
    api.sessions.lineage(input),
  ),
  'sessions.list': operation(
    z.tuple([
      z.object({ includeArchived: z.boolean().optional() }).strict().optional(),
    ]),
    (api, [options]) => api.sessions.list(options),
  ),
  'sessions.rename': operation(
    z.tuple([idSchema, sessionPatchSchema]),
    (api, [id, patch]) => api.sessions.rename(id, patch),
  ),
  'sessions.search': operation(
    z.tuple([
      z
        .object({
          query: z.string().max(200),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.sessions.search(input),
  ),
  'sessions.watch': operation(z.tuple([sessionWatchSchema]), (api, [input]) =>
    api.sessions.watch(input),
  ),
  'skills.copyToUser': operation(
    z.tuple([skillCopyToUserSchema]),
    (api, [input], ctx) =>
      api.skills.copyToUser(
        withSession(input, ctx, 'skills.copyToUser'),
        viewOf(ctx, 'skills.copyToUser'),
      ),
  ),
  'skills.create': operation(
    z.tuple([skillCreateSchema]),
    (api, [input], ctx) =>
      api.skills.create(input, viewOf(ctx, 'skills.create')),
  ),
  'skills.delete': operation(
    z.tuple([skillOpNameSchema, skillDeleteOptionsSchema.optional()]),
    (api, [name, options], ctx) =>
      api.skills.delete(
        name,
        withSession(options ?? {}, ctx, 'skills.delete'),
        viewOf(ctx, 'skills.delete'),
      ),
  ),
  'skills.get': operation(
    z.tuple([skillOpNameSchema, skillSessionOptionsSchema.optional()]),
    (api, [name, options], ctx) =>
      api.skills.get(name, withSession(options ?? {}, ctx, 'skills.get')),
  ),
  'skills.import': operation(
    z.tuple([skillImportSchema]),
    (api, [input], ctx) =>
      api.skills.import(
        withSession(input, ctx, 'skills.import'),
        viewOf(ctx, 'skills.import'),
      ),
  ),
  'skills.list': operation(
    z.tuple([skillSessionOptionsSchema.optional()]),
    (api, [options], ctx) =>
      api.skills.list(withSession(options ?? {}, ctx, 'skills.list')),
  ),
  'skills.save': operation(
    z.tuple([
      skillOpNameSchema,
      skillContentSchema,
      skillSessionOptionsSchema.optional(),
    ]),
    (api, [name, content, options], ctx) =>
      api.skills.save(
        name,
        content,
        withSession(options ?? {}, ctx, 'skills.save'),
        viewOf(ctx, 'skills.save'),
      ),
  ),
  'skills.tools': operation(z.tuple([]), (api, _args, ctx) =>
    api.skills.tools(viewOf(ctx, 'skills.tools')),
  ),
  'skills.validate': operation(
    z.tuple([skillValidateSchema]),
    (api, [input], ctx) =>
      api.skills.validate(withSession(input, ctx, 'skills.validate')),
  ),
  'storage.versions': operation(z.tuple([]), (api) => api.storage.versions()),
  'references.preview': operation(
    z.tuple([
      z.object({ sessionId: idSchema, referenceId: idSchema }).strict(),
    ]),
    (api, [input]) => api.references.preview(input),
  ),
  'references.siteIcon': operation(
    z.tuple([
      z.object({ sessionId: idSchema, referenceId: idSchema }).strict(),
    ]),
    (api, [input]) => api.references.siteIcon(input),
  ),
  'references.resolve': operation(
    z.tuple([referenceResolveSchema]),
    (api, [input]) => api.references.resolve(input),
  ),
  'references.image': operation(
    z.tuple([
      z
        .object({ sessionId: sessionLogIdSchema, referenceId: idSchema })
        .strict(),
    ]),
    (api, [input]) => api.references.image(input),
  ),
  'tools.readResult': operation(
    z.tuple([
      z
        .object({
          ref: idSchema,
          page: z.number().int().min(1).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.tools.readResult(input),
  ),
  'videoProject.open': operation(
    z.tuple([videoProjectOpenInputSchema]),
    async (api, [input]) => {
      const opened = await api.videoProject.open(input)
      if (!opened.readOnlyReason) {
        try {
          await api.videoProject.editRunStatus({ sessionId: opened.sessionId })
        } catch (cause) {
          const code = (cause as { code?: string }).code
          if (
            code &&
            [
              'edit_run_invalid',
              'edit_run_key_invalid',
              'edit_run_missing',
              'draft_project_mismatch',
            ].includes(code)
          )
            opened.editRunRecovery =
              '精剪草稿暂时无法验证。原记录已保留，请恢复对应的工程、会话和签名密钥后重新打开。'
        }
      }
      return opened
    },
  ),
  'videoProject.motionSettings': operation(
    z.tuple([z.object({ sessionId: z.string().min(1).max(256) }).strict()]),
    (api, [input]) => api.videoProject.motionSettings(input),
  ),
  'videoProject.setMotionEnabled': operation(
    z.tuple([
      z
        .object({ sessionId: z.string().min(1).max(256), enabled: z.boolean() })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.setMotionEnabled(input),
  ),
  'videoProject.leaveMotionWorkspace': operation(
    z.tuple([z.object({ sessionId: z.string().min(1).max(256) }).strict()]),
    (api, [input]) => api.videoProject.leaveMotionWorkspace(input),
  ),
  'videoProject.motionWork': operation(
    z.tuple([z.object({ sessionId: z.string().min(1).max(256) }).strict()]),
    (api, [input]) => api.videoProject.motionWork(input),
  ),
  'videoProject.mediaCacheUsage': operation(z.tuple([]), (api) =>
    api.videoProject.mediaCache.usage(),
  ),
  'videoProject.clearMediaCache': operation(z.tuple([]), (api) =>
    api.videoProject.mediaCache.usage(true),
  ),
  'videoProject.cacheMediaUrl': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          handle: z.string().regex(/^[a-f0-9]{32}$/),
        })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.cacheMediaUrl(input),
  ),
  'videoProject.cachePlayback': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          handle: z.string().regex(/^[a-f0-9]{32}$/),
          player: idSchema,
          active: z.boolean(),
        })
        .strict(),
    ]),
    (api, [input]) =>
      api.videoProject.mediaCache.playback(
        input.sessionId,
        input.handle,
        input.player,
        input.active,
      ),
  ),
  'videoProject.previewMedia': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          assetId: idSchema,
          kind: z.enum(['playback', 'poster']),
          posterTime: z.number().nonnegative().max(86400).optional(),
          posterEnd: z.number().nonnegative().max(86400).optional(),
          force: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.previewMedia(input),
  ),
  'videoProject.startEditRun': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          brief: z.string().trim().min(1).max(6000),
          mode: z.enum(['new', 'revision', 'revise_treatment']).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.startEditRun(input),
  ),
  'videoProject.editRunStatus': operation(
    z.tuple([z.object({ sessionId: idSchema }).strict()]),
    (api, [input]) => api.videoProject.editRunStatus(input),
  ),
  'videoProject.editRunDraft': operation(
    z.tuple([
      z
        .object({ sessionId: idSchema, runId: z.string().uuid().optional() })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.editRunDraft(input),
  ),
  'videoProject.editRunAction': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          runId: z.string().uuid().optional(),
          action: z.enum(['cancel', 'resume', 'restore', 'adopt']),
        })
        .strict(),
    ]),
    (api, [input]) => api.videoProject.editRunAction(input),
  ),
  'videoProject.importAssets': operation(
    z.tuple([videoProjectImportInputSchema]),
    (api, [input]) => api.videoProject.importAssets(input),
  ),
  'videoProject.relinkAsset': operation(
    z.tuple([videoProjectRelinkInputSchema]),
    (api, [input]) => api.videoProject.relinkAsset(input),
  ),
  'videoProject.removeMissingAsset': operation(
    z.tuple([videoProjectRemoveMissingAssetInputSchema]),
    (api, [input]) => api.videoProject.removeMissingAsset(input),
  ),
  'videoProject.updateAssetMetadata': operation(
    z.tuple([videoProjectMetadataInputSchema]),
    (api, [input]) => api.videoProject.updateAssetMetadata(input),
  ),
  'videoProject.mutate': operation(
    z.tuple([videoProjectMutateInputSchema]),
    (api, [input]) => api.videoProject.mutate(input),
  ),
  'videoProject.undo': operation(
    z.tuple([videoProjectRevisionInputSchema]),
    (api, [input]) => api.videoProject.undo(input),
  ),
  'videoProject.redo': operation(
    z.tuple([videoProjectRevisionInputSchema]),
    (api, [input]) => api.videoProject.redo(input),
  ),
  'videoProject.analysisStatus': operation(z.tuple([]), (api) =>
    api.videoProject.analysisStatus(),
  ),
  'videoProject.getAnalysisConfig': operation(z.tuple([]), (api) =>
    api.videoProject.getAnalysisConfig(),
  ),
  'videoProject.setAnalysisConfig': operation(
    z.tuple([analysisConfigSchema]),
    (api, [input]) => api.videoProject.setAnalysisConfig(input),
  ),
  'videoProject.transcribe': operation(
    z.tuple([videoProjectTranscribeInputSchema]),
    (api, [input]) => api.videoProject.transcribe(input),
  ),
  'videoProject.transcript': operation(
    z.tuple([videoProjectTranscriptInputSchema]),
    (api, [input]) => api.videoProject.transcript(input),
  ),
  'videoProject.inspectFrames': operation(
    z.tuple([videoProjectFramesInputSchema]),
    (api, [input]) => api.videoProject.inspectFrames(input),
  ),
} as const

export type CoreOperationKey = keyof typeof CORE_OPERATION_REGISTRY

export type CoreOperationArgs<Key extends CoreOperationKey> = z.output<
  (typeof CORE_OPERATION_REGISTRY)[Key]['args']
>

export type CoreOperationResult<Key extends CoreOperationKey> = Awaited<
  ReturnType<(typeof CORE_OPERATION_REGISTRY)[Key]['invoke']>
>

/** Historical renderer modules share wire types only. All dispatch uses CORE_OPERATION_REGISTRY. */
type RendererOperations = typeof CORE_OPERATION_REGISTRY &
  import('./legacy-renderer-operations').LegacyRendererOperations
export type RendererOperationKey = keyof RendererOperations
export type RendererOperationArgs<Key extends RendererOperationKey> = z.output<
  RendererOperations[Key]['args']
>
export type RendererOperationResult<Key extends RendererOperationKey> = Awaited<
  ReturnType<RendererOperations[Key]['invoke']>
>

export type CoreOperationMap = {
  [Key in CoreOperationKey]: {
    args: CoreOperationArgs<Key>
    result: CoreOperationResult<Key>
  }
}

const CORE_OPERATION_KEY_SET = new Set<string>(
  Object.keys(CORE_OPERATION_REGISTRY),
)

export function isCoreOperationKey(value: string): value is CoreOperationKey {
  return CORE_OPERATION_KEY_SET.has(value)
}

export function coreOperationKeys(): CoreOperationKey[] {
  return Object.keys(CORE_OPERATION_REGISTRY).sort() as CoreOperationKey[]
}

export interface CoreOperationDescriptor<Key extends CoreOperationKey> {
  readonly key: Key
  readonly handlerKey: Key
  readonly audience: 'main_renderer'
  readonly classification: 'application_operation'
  readonly inputSchema: (typeof CORE_OPERATION_REGISTRY)[Key]['args']
}

/**
 * Canonical IPC descriptors. Electron and renderer consumers derive their
 * allowlists from these registry-owned keys instead of a retired HTTP route
 * table.
 */
export function coreOperationDescriptors(): Array<
  CoreOperationDescriptor<CoreOperationKey>
> {
  return coreOperationKeys().map((key) => {
    const spec = CORE_OPERATION_REGISTRY[key]
    return Object.freeze({
      key,
      handlerKey: key,
      audience: spec.audience,
      classification: spec.classification,
      inputSchema: spec.args,
    }) as CoreOperationDescriptor<CoreOperationKey>
  })
}

export class CoreOperationArgumentsError extends Error {
  readonly code = 'invalid_core_arguments'
  readonly operation: CoreOperationKey

  constructor(operation: CoreOperationKey, cause?: unknown) {
    super(`Invalid arguments for ${operation}`, { cause })
    this.name = 'CoreOperationArgumentsError'
    this.operation = operation
  }

  toSafe(): { message: string; code: string } {
    return { message: this.message, code: this.code }
  }
}

export async function invokeCoreOperation<Key extends RendererOperationKey>(
  api: CoreApi,
  key: Key,
  input: unknown,
  context: CoreOperationContext = {},
): Promise<RendererOperationResult<Key>> {
  if (!isCoreOperationKey(key))
    throw new Error('Unknown Cutroom operation: ' + key)
  const spec = CORE_OPERATION_REGISTRY[key]
  try {
    return (await spec.parseAndInvoke(
      api,
      input,
      context,
    )) as RendererOperationResult<Key>
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CoreOperationArgumentsError(key, error)
    }
    throw error
  }
}

export interface CoreIpcSafeError {
  message: string
  code?: string
  action?: string
  errorId?: string
}

export interface CoreIpcErrorEnvelope {
  ok: false
  error: CoreIpcSafeError
}
