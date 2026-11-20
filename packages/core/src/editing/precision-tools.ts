import { z } from 'zod'
import { imageDimensions } from '../attachments/image-dimensions'
import type { AttachmentStore } from '../attachments/store'
import type { Agent } from '../harness/agent/agent'
import type { ApprovalService } from '../harness/approval/service'
import {
  defineTool,
  ToolError,
  type ToolRunContext,
} from '../harness/tools/definition'
import type { ContentBlock } from '../llm/types'
import { messageText } from '../llm/message'
import type { PlanReviewOutcome } from '../harness/plan/plan-mode'
import type { VideoAnalysisService } from './analysis/service'
import { buildSubtitleCues, type TranscriptSegment } from './analysis/captions'
import { readVideoSequence } from './analysis/video-sequence'
import { readDraftFrames } from './draft-review'
import {
  draftDeliverySchema,
  editTreatmentSchema,
  type EditRecipient,
  type EditRunService,
} from './edit-run'
import type { SavedEditingBrief } from './editing-brief'
import { sourceNoteInputSchema, sourceNoteQuerySchema } from './source-notes'
import { agentEditCommandSchema } from './agent-edit-commands'
import { clipTimelineDuration, resolveCaptionStyle } from './timeline'
import { queryTimeline, timelineQueryFields } from './timeline-query'

export interface PrecisionToolOptions {
  runs: EditRunService
  analysis: VideoAnalysisService
  start(
    sessionId: string,
    brief: string,
    mode: 'new' | 'revise_treatment',
  ): ReturnType<EditRunService['create']>
  reviewPlan(
    agent: Agent,
    context: ToolRunContext,
    plan: string,
  ): Promise<PlanReviewOutcome> | undefined
  approval: Pick<ApprovalService, 'request'>
  attachments: AttachmentStore
  recipient(agent: Agent): EditRecipient | null
}

const second = z.number().finite().nonnegative().max(86400)
const id = z.string().trim().min(1).max(128)
const previewTimes = z.array(second).min(1).max(6)
const generation = z.number().int().nonnegative()
const videoPage = {
  start: second.default(0),
  end: second.optional(),
  fps: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(2),
  speech: z.boolean().default(true),
}
const unit = z.number().finite().min(0).max(1)
const region = z
  .object({ x: unit, y: unit, width: unit, height: unit })
  .strict()
  .refine(
    (r) =>
      r.width > 0 && r.height > 0 && r.x + r.width <= 1 && r.y + r.height <= 1,
  )

function setup(deps: PrecisionToolOptions, context: ToolRunContext) {
  const agent = context.agent
  if (!agent)
    throw new ToolError('缺少工作区会话。', 'workspace_session_required')
  const recipient = deps.recipient(agent)
  if (!recipient)
    throw new ToolError(
      '当前模型无法查看视觉证据。',
      'edit_run_vision_required',
    )
  return {
    agent,
    sessionId: agent.id,
    recipient,
    scope: recipient.scope,
    signal: context.signal,
  }
}

function imageResult(
  attachments: AttachmentStore,
  scope: string,
  label: string,
  frames: readonly { time: number; bytes: Buffer }[],
  comment: Record<string, unknown>,
): { content: ContentBlock[] } {
  if (!frames.length)
    throw new ToolError('指定时间没有可读取的画面。', 'frames_unavailable')
  const content: ContentBlock[] = [
    {
      type: 'text',
      text: JSON.stringify({
        ...comment,
        framesInOrder: frames.map((frame) => frame.time),
      }),
    },
  ]
  for (const frame of frames) {
    const stored = attachments.save({
      raw: frame.bytes,
      name: `${label}-${frame.time.toFixed(3)}.jpg`,
      mime: 'image/jpeg',
    })
    const size = imageDimensions(frame.bytes)
    content.push({
      type: 'image',
      recipientScope: scope,
      attachment: {
        attachmentId: stored.id,
        mediaType: stored.mime,
        bytes: stored.size,
        ...(size ?? {}),
      },
    })
  }
  return { content }
}

function approvalReason(
  treatment: z.infer<typeof editTreatmentSchema>,
  scopeLabel: string,
  projectBrief?: SavedEditingBrief,
): string {
  return [
    '执行这次自主精剪。精剪稿经本机试渲染与回看后，一次性交付到编辑器。',
    `思路：${treatment.summary}`,
    ...(treatment.sections?.length
      ? [`段落安排：${treatment.sections.join(' → ')}`]
      : []),
    ...(treatment.mustKeep.length
      ? [`必须保留：${treatment.mustKeep.join('、')}`]
      : []),
    `节奏：${treatment.pacing}`,
    `画面：${treatment.picture}`,
    treatment.captionPolicy === 'locked'
      ? '字幕：保持现有样式，复检字号、对比度、安全区和遮挡。'
      : '字幕：自动选择和复检字号、文字颜色、位置、背景和描边，遵守指定的样式要求。',
    ...(treatment.speechAnchors?.length
      ? [
          `保留原声复检点：${treatment.speechAnchors.map(({ text }) => text).join(' / ')}`,
        ]
      : []),
    ...(projectBrief
      ? [
          `这次确认会写入 editing-brief.md 第 ${projectBrief.revision} 版。\n\n${projectBrief.markdown}`,
        ]
      : []),
    `模型：${scopeLabel}`,
  ].join('\n')
}

export function createPrecisionTools(deps: PrecisionToolOptions) {
  const start = defineTool({
    name: 'video_start_precision_edit',
    category: 'editing',
    description:
      'Hand the current user request to the full editing workflow in this same conversation. Choose this for whole-film editorial judgment, continuous source review, a treatment and a reviewed draft. For a local cut, caption or motion edit use direct tools. Call alone. Use revise_treatment for user feedback on a declined treatment.',
    input: z
      .object({ mode: z.enum(['new', 'revise_treatment']).default('new') })
      .strict(),
    execute: async ({ mode }, context) => {
      const { agent, sessionId, signal } = setup(deps, context)
      let messageId: string | undefined
      let brief = ''
      for (let index = agent.session.events.length - 1; index >= 0; index--) {
        const event = agent.session.events[index]!
        if (
          !messageId &&
          event.type === 'user/message' &&
          event.data.source.kind === 'user'
        ) {
          messageId = event.data.id
          brief = messageText(event.data)
        } else if (
          event.type === 'host/user-meta' &&
          event.data.messageId === messageId
        ) {
          brief = event.data.displayContent || brief
          break
        }
      }
      if (!messageId)
        throw new ToolError(
          '没有可交接的用户消息。',
          'edit_run_message_missing',
        )
      // The same session keeps the original image blocks, attachment text, skills and reference snapshots.
      signal.throwIfAborted()
      const status = await deps.start(sessionId, brief, mode)
      context.concludeTurn()
      return JSON.stringify({ runId: status.runId, state: status.state })
    },
  })
  const analyze = defineTool({
    name: 'video_analyze_workspace',
    description:
      'Inspect a precision edit. Call with {} for source, output and unresolved file inventory, the saved editingBrief, and draft version. Filter draft timeline with timelineStart/End, trackIds, sourceAssetIds or clipIds. Each clip has separate sourceRange and timelineRange. Select assetId and source start/end for measured audio, transcript evidence IDs and screen changes. Use includeTokens for precise cut boundaries.',
    category: 'editing',
    input: z
      .object({
        assetId: id.optional(),
        start: second.optional(),
        end: second.optional(),
        assetOffset: z.number().int().min(0).max(2000).default(0),
        ...timelineQueryFields,
        includeTokens: z.boolean().default(false),
        referencePath: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      const snapshot = await deps.runs.source(sessionId, scope)
      if (args.referencePath) {
        return JSON.stringify(
          await deps.runs.reference(sessionId, scope, args.referencePath),
        )
      }
      if (!args.assetId) {
        const { project, missingAssetIds } = snapshot
        return JSON.stringify({
          name: project.name,
          revision: project.revision,
          runId: snapshot.runId,
          generation: snapshot.generation,
          coverage: snapshot.coverage,
          editingBrief: snapshot.editingBrief,
          inventory: snapshot.inventory && {
            sourceAssetIds:
              snapshot.sourceAssetIds ??
              project.assets.map((asset) => asset.id),
            ...snapshot.inventory,
          },
          transcriptionProvider: snapshot.transcriptionProvider,
          ...queryTimeline(project, args),
          assets: project.assets.slice(args.assetOffset, args.assetOffset + 80),
          canvas: project.canvas,
          captionStyle: resolveCaptionStyle(project.captionStyle),
          totalAssets: project.assets.length,
          missingAssetIds,
          referenceFiles: await deps.runs.references(sessionId, scope),
        })
      }
      const asset = snapshot.project.assets.find(
        (item) => item.id === args.assetId,
      )
      if (!asset)
        throw new ToolError('找不到指定工作区素材。', 'asset_not_found')
      if (snapshot.missingAssetIds?.includes(asset.id))
        throw new ToolError('素材已离线。', 'asset_missing')
      const evidence = await deps.analysis
        .inspectEvidence(snapshot, asset, {
          signal,
          start: args.start,
          end: args.end,
          expectedProvider: snapshot.transcriptionProvider,
        })
        .catch(async (cause: unknown) => {
          if (
            cause instanceof Error &&
            (cause as { code?: string }).code === 'fun_asr_account_unavailable'
          )
            await deps.runs.pauseForTranscription(sessionId, cause.message)
          throw cause
        })
      const hasTranscript = evidence.events.some(
        (event) => event.kind === 'transcript',
      )
      if (hasTranscript) await deps.runs.noteSourceSpeech(sessionId, scope)
      const sourceEvidence = await deps.runs.recordSourceEvidence(
        sessionId,
        scope,
        snapshot.runId,
        asset.id,
        [
          { kind: 'audio', start: evidence.start, end: evidence.end },
          ...(hasTranscript
            ? [
                {
                  kind: 'transcript' as const,
                  start: evidence.start,
                  end: evidence.end,
                },
              ]
            : []),
        ],
        signal,
      )
      return JSON.stringify({
        ...evidence,
        sourceEvidence,
        events: evidence.events.filter((event) =>
          args.includeTokens
            ? event.kind !== 'energy'
            : event.kind !== 'token' && event.kind !== 'energy',
        ),
        // Keep signal context alongside measured speech and scene boundaries.
        energySample: evidence.events
          .filter((event) => event.kind === 'energy')
          .filter((_, index) => index % 10 === 0)
          .slice(0, 30),
      })
    },
  })

  const video = defineTool({
    name: 'video_read_video',
    description:
      'Watch chronological, timestamped contact sheets from a source or the latest rendered draft. 2 fps over up to 8 seconds per page, plus detected changes. Follow nextStart until null; source and rendered draft coverage is checked before proposal and delivery. Use 4 or 8 fps on short action and cut details. For local repairs set start and end around the repair with surrounding context. Use video_read_evidence for individual frames or small screen text.',
    category: 'editing',
    input: z
      .object({
        from: z.enum(['source', 'draft']),
        assetId: id.optional(),
        ...videoPage,
      })
      .strict()
      .refine((args) => (args.from === 'source') === Boolean(args.assetId), {
        message: '只有查看源片时需要填写素材 ID。',
      }),
    isConcurrencySafe: () => false,
    execute: async (args, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      const target = await deps.runs.visualTarget(
        sessionId,
        scope,
        args.from === 'source'
          ? { from: 'source', assetId: args.assetId! }
          : { from: 'draft' },
      )
      const requestedEnd = args.end ?? target.duration
      const rangeEnd =
        requestedEnd >= target.duration - 0.001 ? target.duration : requestedEnd
      if (rangeEnd <= args.start)
        throw new ToolError(
          '查看范围须位于视频时长内。',
          'evidence_range_invalid',
        )
      const end = Math.min(rangeEnd, args.start + 16 / args.fps)
      const page = await readVideoSequence({
        ffmpegPath: target.ffmpegPath,
        path: target.mediaPath,
        start: args.start,
        end,
        fps: args.fps,
        signal,
      })
      const noFrames = page.sheets.length === 0
      const timedSpeech = args.speech
        ? await deps.analysis
            .transcribe(
              target.projectPath,
              {
                id:
                  target.assetId ??
                  `draft-${target.runId}-${target.generation}`,
                path: target.relativePath,
                kind: 'video',
                displayName: '连续画面',
                duration: target.duration,
                width: null,
                height: null,
              },
              {
                signal,
                preferTokens: true,
                expectedProvider: target.transcriptionProvider,
              },
            )
            .then((result) => ({
              segments: result.segments.filter(
                (item) => item.end > page.start && item.start < page.end,
              ),
            }))
            .catch((cause: unknown) => {
              signal?.throwIfAborted()
              return {
                unavailable:
                  cause instanceof Error ? cause.message : String(cause),
              }
            })
        : undefined
      signal?.throwIfAborted()
      const info = {
        timebase:
          args.from === 'source' ? 'source_seconds' : 'timeline_seconds',
        assetId: target.assetId,
        generation: target.generation,
        fps: args.fps,
        page: { start: page.start, end: page.end },
        nextStart: page.end < rangeEnd ? page.end : null,
        rangeEnd,
        noFrames,
        sheets: page.sheets.map(({ columns, rows, times }) => ({
          columns,
          rows,
          times,
        })),
        timedSpeech,
      }
      const result = noFrames
        ? { content: [{ type: 'text', text: '' } as ContentBlock] }
        : imageResult(
            deps.attachments,
            scope,
            target.assetId ?? 'draft-sequence',
            page.sheets,
            info,
          )
      const coverage = await deps.runs.recordVisualCoverage(
        sessionId,
        scope,
        target,
        page.start,
        page.end,
        args.start,
        rangeEnd,
        {
          signal,
          noFrames,
          heardSpeech: Boolean(
            timedSpeech &&
            'segments' in timedSpeech &&
            timedSpeech.segments.length,
          ),
        },
      )
      const sourceEvidence =
        target.assetId &&
        (await deps.runs.recordSourceEvidence(
          sessionId,
          scope,
          target.runId,
          target.assetId,
          [
            ...(!noFrames
              ? [{ kind: 'frame' as const, start: page.start, end: page.end }]
              : []),
            ...(timedSpeech &&
            'segments' in timedSpeech &&
            timedSpeech.segments.length
              ? [
                  {
                    kind: 'transcript' as const,
                    start: page.start,
                    end: page.end,
                  },
                ]
              : []),
          ],
          signal,
        ))
      const metadata = result.content[0]
      if (metadata?.type === 'text')
        metadata.text = JSON.stringify({ ...info, coverage, sourceEvidence })
      return result
    },
  })

  const evidence = defineTool({
    name: 'video_read_evidence',
    description:
      'Read up to 6 actual ordered frames from source or latest rendered draft. Optional source region selects a detail; fullResolution requests native pixels. Read draft review targets before finishing.',
    category: 'editing',
    input: z
      .object({
        from: z.enum(['source', 'draft']),
        assetId: id.optional(),
        times: previewTimes,
        region: region.optional(),
        speech: z.boolean().default(false),
        fullResolution: z.boolean().default(false),
      })
      .strict()
      .refine(
        (args) =>
          args.from === 'source'
            ? Boolean(args.assetId) && !args.speech
            : !args.assetId && !args.region,
        {
          message: '源片支持素材和裁剪区，草稿支持成片转写。',
        },
      ),
    isConcurrencySafe: () => false,
    execute: async (args, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      if (args.from === 'source') {
        const snapshot = await deps.runs.source(sessionId, scope)
        const asset = snapshot.project.assets.find(
          (item) => item.id === args.assetId,
        )
        if (!asset || snapshot.missingAssetIds?.includes(asset.id))
          throw new ToolError('素材不可用。', 'asset_missing')
        const frames = await deps.analysis.frames(
          snapshot.projectPath,
          asset,
          args.times,
          signal,
          args.region,
          args.fullResolution,
        )
        const result = imageResult(deps.attachments, scope, asset.id, frames, {
          timebase: 'source_seconds',
          assetId: asset.id,
          assetName: asset.displayName,
          region: args.region,
        })
        const sourceEvidence = await deps.runs.recordSourceEvidence(
          sessionId,
          scope,
          snapshot.runId,
          asset.id,
          frames.map(({ time }) => ({ kind: 'frame', start: time, end: time })),
          signal,
        )
        const metadata = result.content[0]
        if (metadata?.type === 'text')
          metadata.text = JSON.stringify({
            ...JSON.parse(metadata.text),
            sourceEvidence,
          })
        return result
      }
      const {
        path,
        ffmpegPath,
        generation,
        duration,
        projectPath,
        relativePath,
        runId,
        transcriptionProvider,
      } = await deps.runs.reviewedPath(sessionId, scope)
      if (args.times.some((time) => time >= duration))
        throw new ToolError('取证时间超出草稿范围。', 'evidence_range_invalid')
      const frames = await readDraftFrames(
        path,
        ffmpegPath,
        args.times,
        signal,
        args.fullResolution,
      )
      const renderedSpeech = args.speech
        ? await deps.analysis
            .transcribe(
              projectPath,
              {
                id: `draft-${runId}-${generation}`,
                kind: 'video',
                path: relativePath,
                displayName: '精剪预览',
                duration,
                width: null,
                height: null,
              },
              { signal, expectedProvider: transcriptionProvider },
            )
            .then((transcript) => ({
              segments: transcript.segments.filter((segment) =>
                args.times.some(
                  (time) => segment.start < time + 3 && segment.end > time - 3,
                ),
              ),
            }))
            .catch((cause: unknown) => {
              signal?.throwIfAborted()
              return {
                unavailable:
                  cause instanceof Error ? cause.message : String(cause),
              }
            })
        : undefined
      const result = imageResult(deps.attachments, scope, 'draft', frames, {
        timebase: 'timeline_seconds',
        generation,
        renderedSpeech,
      })
      signal?.throwIfAborted()
      await deps.runs.recordReviewFrames(
        sessionId,
        scope,
        frames.map((frame) => frame.time),
        generation,
      )
      return result
    },
  })

  const propose = defineTool({
    name: 'video_propose_treatment',
    description:
      'After examining source evidence, present one editorial treatment for the user to approve. captionPolicy defaults to auto. Use locked when asked to keep the existing caption style. Record any specific new style requirements in mustKeep. Supply projectBrief for initial reusable project guidance or if the user asks to change long-term guidance. Omit projectBrief for temporary changes to an already documented project. Approval covers the proposed Markdown and all compatible draft work.',
    category: 'editing',
    input: editTreatmentSchema,
    isConcurrencySafe: () => false,
    execute: async (treatment, context) => {
      const { agent, sessionId, scope, recipient, signal } = setup(
        deps,
        context,
      )
      const proposal = await deps.runs.propose(sessionId, scope, {
        ...treatment,
        captionPolicy: treatment.captionPolicy ?? 'auto',
      })
      const reason = approvalReason(
        treatment,
        recipient.label,
        proposal.editingBriefChange,
      )
      const review = deps.reviewPlan(
        agent,
        context,
        `# 精剪方案

${reason}`,
      )
      let approved: boolean
      if (review) {
        const result = await review
        if (result.kind === 'keep-planning') {
          await deps.runs.reviseProposal(
            sessionId,
            proposal.runId,
            result.feedback ?? '',
          )
          return JSON.stringify({
            approved: false,
            feedback: result.feedback,
            instruction: '根据反馈调整剪辑思路，再提交审阅。',
          })
        }
        approved = result.kind === 'approved'
        if (result.kind === 'cancelled' && !signal.aborted)
          context.concludeTurn('plan-dismissed')
      } else {
        approved =
          (await deps.approval.request({
            agent,
            toolName: 'video_propose_treatment',
            callId: context.callId,
            reason,
            risk: 'edit',
            signal,
          })) === 'allowed-once'
      }
      const status = await deps.runs.decide(
        sessionId,
        proposal.runId,
        approved ? 'allowed-once' : 'rejected',
      )
      return JSON.stringify({ approved: status.state === 'rough_cut', status })
    },
  })

  const stage = defineTool({
    name: 'video_stage_edit',
    description:
      'Apply a validated batch to the approved draft generation from video_analyze_workspace, video_preview_edit or the preceding stage. Use real clip IDs, source in/out, split, move, transforms, fades and rippleDeleteRange for a linked timeline cut. Rebuild affected captions where retimeSubtitles reports ranges. In a separate call with commands:[] and captionAssetIds, generate editable captions from retained speech. setCaptionStyle controls fontSize (1080p pixels), color, position, backgroundColor, backgroundOpacity (0–1), outlineColor, and outlineWidth (1080p pixels). Read the current style before changing only selected fields.',
    category: 'editing',
    input: z
      .object({
        phase: z.enum(['rough_cut', 'fine_cut', 'repairing']),
        generation,
        commands: z.array(agentEditCommandSchema).max(200),
        captionAssetIds: z.array(id).min(1).max(40).optional(),
      })
      .strict()
      .refine((input) =>
        input.captionAssetIds
          ? !input.commands.length
          : input.commands.length > 0,
      ),
    isConcurrencySafe: () => false,
    execute: async (
      { phase, generation, commands, captionAssetIds },
      context,
    ) => {
      const { sessionId, scope, signal } = setup(deps, context)
      if (captionAssetIds) {
        const snapshot = await deps.runs.source(sessionId, scope)
        const ids = new Set(captionAssetIds)
        const clips = snapshot.project.clips.filter(
          (clip) => ids.has(clip.assetId) && !clip.muted && clip.volume > 0,
        )
        if (!clips.length)
          throw new ToolError(
            '找不到这些素材的有效讲解片段。',
            'caption_source_missing',
          )
        const transcripts = new Map<string, TranscriptSegment[]>()
        for (const asset of snapshot.project.assets) {
          if (!ids.has(asset.id) || asset.kind === 'image') continue
          const transcript = await deps.analysis.transcribe(
            snapshot.projectPath,
            asset,
            {
              signal,
              preferTokens: true,
              expectedProvider: snapshot.transcriptionProvider,
            },
          )
          transcripts.set(
            asset.id,
            transcript.segments.filter((segment) =>
              clips.some(
                (clip) =>
                  clip.assetId === asset.id &&
                  clip.sourceIn <= segment.start + 0.06 &&
                  clip.sourceOut >= segment.end - 0.06,
              ),
            ),
          )
        }
        const cues = buildSubtitleCues({ clips }, transcripts)
        if (!cues.length)
          throw new ToolError(
            '保留范围内没有完整的转写句子。可根据实际词级证据补写字幕。',
            'caption_evidence_missing',
          )
        const replaceIds = snapshot.project.subtitles
          .filter((cue) =>
            clips.some(
              (clip) =>
                cue.start < clip.timelineStart + clipTimelineDuration(clip) &&
                cue.end > clip.timelineStart,
            ),
          )
          .map((cue) => cue.id)
        return JSON.stringify(
          await deps.runs.stage(
            sessionId,
            scope,
            phase,
            [{ type: 'replaceSubtitles', cues, replaceIds }],
            signal,
            generation,
          ),
        )
      }
      return JSON.stringify(
        await deps.runs.stage(
          sessionId,
          scope,
          phase,
          commands,
          signal,
          generation,
        ),
      )
    },
  })

  const preview = defineTool({
    name: 'video_preview_edit',
    description:
      'Try a batch on the approved draft without writing. Returns affected tracks, clips, subtitles, and before/after duration. Created IDs are provisional. Use the returned generation to apply your preferred option with video_stage_edit.',
    category: 'editing',
    input: z
      .object({
        generation,
        commands: z.array(agentEditCommandSchema).min(1).max(200),
      })
      .strict(),
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const { sessionId, scope } = setup(deps, context)
      return JSON.stringify(
        await deps.runs.preview(
          sessionId,
          scope,
          args.commands,
          args.generation,
        ),
      )
    },
  })

  const review = defineTool({
    name: 'video_review_draft',
    description:
      'Render the whole current draft and transcribe the rendered audio through the selected provider. Reports sound issues in TIMELINE seconds and audits a rendered frame for each caption cue. A speech_repeat/speech_false_start issue includes a suggested remove interval; confirm raw source timing and fix audio/video, then sync captions and rerender. A speech_missing issue identifies a protected SOURCE anchor to restore. Fix errors before delivery. Read targets and captions.targets using video_read_evidence (up to six per call). At caption targets check whether captions cover faces, gestures, or important screen detail. Fix by changing permitted style or line wrapping and rerender. Report exact unresolved times if constrained by approved style.',
    category: 'editing',
    input: z.object({}).strict(),
    isConcurrencySafe: () => false,
    execute: async (_, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      return JSON.stringify(await deps.runs.review(sessionId, scope, signal))
    },
  })

  const finish = defineTool({
    name: 'video_finish_draft',
    description:
      'Deliver the editable draft after complete render and model review. Provide a factual summary, timeline bookmarks, and checkedTimes for render review targets. For every captions.targets time provide captionChecks with the exact time and result clear or blocked after visually reading that rendered frame. Include the affected subject in note for blocked checks; the tool will keep the task in repair. The independent draft stays available to adopt if the live project changed mid-run.',
    category: 'editing',
    input: draftDeliverySchema,
    isConcurrencySafe: () => false,
    execute: async (delivery, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      return JSON.stringify(
        await deps.runs.finish(sessionId, scope, delivery, signal),
      )
    },
  })

  const readNotes = defineTool({
    name: 'video_read_source_notes',
    description:
      'Read source-notes.json in source seconds by asset or range. Current notes include evidence locations; pendingReview means the source or related take changed.',
    category: 'editing',
    input: sourceNoteQuerySchema,
    isConcurrencySafe: () => true,
    execute: async (query, context) => {
      const { sessionId, scope } = setup(deps, context)
      return JSON.stringify(
        await deps.runs.readSourceNotes(sessionId, scope, query),
      )
    },
  })

  const recordNotes = defineTool({
    name: 'video_record_source_notes',
    description:
      'Save timed observations before proposing an edit. Use original asset IDs and SOURCE seconds (0–0 for still images). Use sourceEvidence IDs from the video/analyze/evidence tools for each observed action, speech, inference, or compared take. Use user-provided and an exact userQuote for a fact the user supplied.',
    category: 'editing',
    input: z
      .object({ notes: z.array(sourceNoteInputSchema).min(1).max(24) })
      .strict(),
    isConcurrencySafe: () => false,
    execute: async ({ notes }, context) => {
      const { sessionId, scope, signal } = setup(deps, context)
      const saved = await deps.runs.saveSourceNotes(
        sessionId,
        scope,
        notes,
        signal,
      )
      return JSON.stringify({
        file: 'source-notes.json',
        noteIds: saved.map(({ id }) => id),
      })
    },
  })

  return [
    start,
    analyze,
    video,
    evidence,
    readNotes,
    recordNotes,
    propose,
    preview,
    stage,
    review,
    finish,
  ]
}
