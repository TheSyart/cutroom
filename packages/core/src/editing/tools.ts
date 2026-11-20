/** Agent tools over the bound video project: read, preview, edit, history, focus. */
import { z } from 'zod'
import type { Agent } from '../harness/agent/agent'
import type { ApprovalService } from '../harness/approval/service'
import {
  ToolError,
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '../harness/tools/definition'
import { imageDimensions } from '../attachments/image-dimensions'
import type { AttachmentStore } from '../attachments/store'
import type { ContentBlock } from '../llm/types'
import {
  applyVideoProjectCommand,
  type VideoProjectCommandResult,
} from './commands'
import type { VideoProjectService } from './project-store'
import {
  clipTimelineDuration,
  resolveCaptionStyle,
  timelineClipAt,
  timelineLayout,
} from './timeline'
import { agentEditCommandSchema } from './agent-edit-commands'
import { queryTimeline, timelineQueryFields } from './timeline-query'
import {
  type VideoAsset,
  type VideoClip,
  type VideoProject,
  type VideoProjectCommand,
  type VideoProjectResult,
} from './types'

export type VideoProjectToolEvent =
  | {
      event: 'video_project_changed'
      session_id: string
      revision: number
      selectedClipId?: string | null
      totalDuration: number
    }
  | {
      event: 'video_project_focus'
      session_id: string
      clipId?: string
      time?: number
    }

export interface VideoProjectToolDeps {
  service: Pick<
    VideoProjectService,
    | 'inspect'
    | 'mutate'
    | 'undo'
    | 'redo'
    | 'motionSettings'
    | 'analysisStatus'
    | 'transcribe'
    | 'transcripts'
    | 'inspectFrames'
  >
  approval: Pick<ApprovalService, 'request'>
  attachments: AttachmentStore
  visionRecipient(agent: Agent): { label: string; scope: string } | null
  emit(event: VideoProjectToolEvent): void
}

const id = z.string().trim().min(1).max(128)
const finite = z.number().finite()
const DEFAULT_ASSET_LIMIT = 200
const DEFAULT_TRANSCRIPT_LIMIT = 200
const MAX_TRANSCRIPT_LIMIT = 500
const MAX_FRAMES = 6

const transcribeInput = z
  .object({
    assetId: id.optional(),
    clipId: id.optional(),
    language: z.enum(['auto', 'zh', 'en']).optional(),
    offset: z.number().int().min(0).max(4999).optional(),
    limit: z.number().int().min(1).max(MAX_TRANSCRIPT_LIMIT).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.assetId || value.clipId), {
    message: 'assetId or clipId is required',
  })
const framesInput = z
  .object({
    assetId: id.optional(),
    clipId: id.optional(),
    times: z
      .array(finite.nonnegative().max(86_400))
      .min(1)
      .max(MAX_FRAMES)
      .optional(),
    count: z.number().int().min(1).max(MAX_FRAMES).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.assetId || value.clipId), {
    message: 'assetId or clipId is required',
  })
const readInput = z
  .object({
    ...timelineQueryFields,
    assetOffset: z.number().int().min(0).max(1999).optional(),
  })
  .strict()

const previewInput = z.object({ command: agentEditCommandSchema }).strict()

const applyInput = z.object({ command: agentEditCommandSchema }).strict()

const historyInput = z.object({ action: z.enum(['undo', 'redo']) }).strict()

const focusInput = z
  .object({
    clipId: id.optional(),
    time: finite.nonnegative().max(86_400).optional(),
  })
  .strict()
  .refine((value) => value.clipId !== undefined || value.time !== undefined, {
    message: 'clipId or time is required',
  })

interface ProjectTranscriptView {
  available: boolean
  language: string | null
  segmentCount: number
  preview: string
}

interface ProjectAssetView {
  id: string
  displayName: string
  kind: VideoAsset['kind']
  duration: number | null
  width: number | null
  height: number | null
  usedByClips: number
  transcript?: ProjectTranscriptView
}

interface ProjectCapabilities {
  motionEnabled: boolean
  vision: boolean
  transcription: {
    available: boolean
    engine: string | null
    model: string | null
    reason: string | null
  }
}

type TimelineView = ReturnType<typeof queryTimeline>

type ProjectView = Omit<TimelineView, 'tracks' | 'totalDuration'> & {
  project: {
    id: string
    name: string
    revision: number
    canvas: VideoProject['canvas']
    captionStyle: ReturnType<typeof resolveCaptionStyle>
    totalDuration: number
    tracks: TimelineView['tracks']
    canUndo: boolean
    canRedo: boolean
  }
  assets: ProjectAssetView[]
  assetOffset: number
  assetsTruncated: boolean
  totalAssets: number
  nextAssetOffset: number | null
  capabilities: ProjectCapabilities
}

function agentOf(context: ToolRunContext): Agent {
  if (!context.agent)
    throw new ToolError('剪辑工具只能在 Agent 回合内使用。', 'agent_required')
  return context.agent
}

function sessionOf(context: ToolRunContext): string {
  return agentOf(context).session.id
}

function assetName(project: VideoProject, assetId: string): string {
  return (
    project.assets.find((asset) => asset.id === assetId)?.displayName ?? '素材'
  )
}

function assetOf(
  project: VideoProject,
  input: { assetId?: string; clipId?: string },
): VideoAsset {
  const assetId =
    input.assetId ??
    (input.clipId
      ? project.clips.find((clip) => clip.id === input.clipId)?.assetId
      : undefined)
  if (!assetId) throw new ToolError('请指定素材或片段。', 'asset_required')
  const asset = project.assets.find((item) => item.id === assetId)
  if (!asset) throw new ToolError('找不到这个素材。', 'asset_not_found')
  return asset
}

function clipOf(project: VideoProject, clipId: string): VideoClip {
  const clip = project.clips.find((item) => item.id === clipId)
  if (!clip) throw new ToolError('找不到这个时间线片段。', 'invalid_edit')
  return clip
}

function clipIndex(project: VideoProject, clipId: string): number {
  return timelineLayout(project).clips.findIndex(
    (clip) => clip.clipId === clipId,
  )
}

function timelineRange(
  project: VideoProject,
  clipId: string,
): { start: number; end: number; duration: number } | null {
  return (
    timelineLayout(project).clips.find((item) => item.clipId === clipId) ?? null
  )
}

function timeText(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`
}

function durationText(seconds: number): string {
  return `${seconds.toFixed(2)} 秒`
}

function commandSummary(
  current: VideoProject,
  command: VideoProjectCommand,
  next: VideoProject,
): string {
  switch (command.type) {
    case 'upsertMotionScene':
      return '编写动效场景'
    case 'setMotionAnchor':
      return '调整动效的原声锚点'
    case 'deleteMotionObject':
      return '删除动效对象'
    case 'deleteMotionScene':
      return '删除动效场景'
    case 'moveMotionScene':
      return '移动动效场景'
    case 'trimMotionScene':
      return '修剪动效场景'
    case 'splitMotionScene':
      return '拆分动效场景'
    case 'addClip': {
      const added = next.clips[next.clips.length - 1]
      const duration = added ? clipTimelineDuration(added) : 0
      const track = added
        ? next.tracks.find((item) => item.id === added.trackId)?.name
        : undefined
      return `添加「${assetName(current, command.assetId)}」${track ? `到${track}` : '到时间线'}，时长 ${durationText(duration)}`
    }
    case 'trimClip': {
      const before = clipOf(current, command.clipId)
      const after = clipOf(next, command.clipId)
      return `修剪「${assetName(current, before.assetId)}」第 ${clipIndex(current, command.clipId) + 1} 段：${timeText(before.sourceIn)}–${timeText(before.sourceOut)} → ${timeText(after.sourceIn)}–${timeText(after.sourceOut)}，${durationText(clipTimelineDuration(after))}`
    }
    case 'splitClip': {
      const clip = clipOf(current, command.clipId)
      return `在「${assetName(current, clip.assetId)}」第 ${clipIndex(current, command.clipId) + 1} 段的 ${durationText(command.timelineOffset)}处拆分`
    }
    case 'deleteClip': {
      const clip = clipOf(current, command.clipId)
      const range = timelineRange(current, command.clipId)
      const moved = next.clips.filter(
        (candidate) =>
          candidate.trackId === clip.trackId &&
          range &&
          candidate.timelineStart >= range.start - 1e-6,
      ).length
      return `删除「${assetName(current, clip.assetId)}」第 ${clipIndex(current, command.clipId) + 1} 段（时间线 ${range ? `${timeText(range.start)}–${timeText(range.end)}，` : ''}共 ${durationText(range?.duration ?? clipTimelineDuration(clip))}），同轨后续 ${moved} 段前移`
    }
    case 'rippleDeleteRange': {
      const removed = current.subtitles.length - next.subtitles.length
      return `全轨删除时间线 ${timeText(command.start)}–${timeText(command.end)} 并前移后续片段${removed ? `，移除与区间相交的 ${removed} 条字幕` : ''}`
    }
    case 'moveClip': {
      const clip = clipOf(current, command.clipId)
      const track = next.tracks.find((item) => item.id === command.trackId)
      return `将「${assetName(current, clip.assetId)}」移动到${track?.name ?? '轨道'} ${timeText(command.timelineStart)}`
    }
    case 'addTrack':
      return `新增${command.kind === 'audio' ? '音频' : '视频'}轨道「${command.name ?? '叠加'}」`
    case 'removeTrack':
      return '删除空轨道'
    case 'replaceClipRanges':
      return `精剪「${assetName(current, clipOf(current, command.clipId).assetId)}」，保留 ${command.ranges.length} 段`
    case 'setCaptionStyle':
      return '修改字幕样式'
    case 'addAnnotation':
      return '添加画面强调'
    case 'updateAnnotation':
      return '调整画面强调'
    case 'deleteAnnotation':
      return '删除画面强调'
    case 'addSubtitle':
      return `添加字幕「${command.text.slice(0, 30)}」${timeText(command.start)}–${timeText(command.end)}`
    case 'updateSubtitle':
      return '修改字幕文本或时间'
    case 'deleteSubtitle':
      return '删除字幕'
    case 'replaceSubtitles':
      return `替换字幕轨，共 ${command.cues.length} 条`
    case 'updateClip': {
      const clip = clipOf(current, command.clipId)
      const changes: string[] = []
      if (command.speed !== undefined)
        changes.push(`速度 ${clip.speed}× → ${command.speed}×`)
      if (command.volume !== undefined)
        changes.push(
          `音量 ${Math.round(clip.volume * 100)}% → ${Math.round(command.volume * 100)}%`,
        )
      if (command.muted !== undefined)
        changes.push(command.muted ? '静音' : '取消静音')
      if (command.transform !== undefined) changes.push('画面缩放/位移')
      return `调整「${assetName(current, clip.assetId)}」第 ${clipIndex(current, command.clipId) + 1} 段：${changes.join('，')}`
    }
    case 'updateCanvas': {
      const changes: string[] = []
      if (command.fit !== undefined)
        changes.push(`适配 ${current.canvas.fit} → ${command.fit}`)
      if (command.background !== undefined)
        changes.push(
          `背景 ${current.canvas.background} → ${command.background}`,
        )
      return `调整全片画面：${changes.join('，')}`
    }
  }
}

function projectView(
  result: VideoProjectResult,
  timeline: TimelineView,
  extras: {
    capabilities: ProjectCapabilities
    transcripts: Map<string, ProjectTranscriptView>
    assetOffset: number
  },
): ProjectView {
  const { tracks, totalDuration, ...pages } = timeline
  const usage = new Map<string, number>()
  for (const clip of result.project.clips)
    usage.set(clip.assetId, (usage.get(clip.assetId) ?? 0) + 1)
  const assets = result.project.assets
    .slice(extras.assetOffset, extras.assetOffset + DEFAULT_ASSET_LIMIT)
    .map((asset) => ({
      id: asset.id,
      displayName: asset.displayName,
      kind: asset.kind,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      usedByClips: usage.get(asset.id) ?? 0,
      ...(extras.transcripts.has(asset.id)
        ? { transcript: extras.transcripts.get(asset.id) }
        : {}),
    }))
  const nextAssetOffset = extras.assetOffset + assets.length
  const assetsTruncated = nextAssetOffset < result.project.assets.length
  return {
    project: {
      id: result.project.projectId,
      name: result.project.name,
      revision: result.project.revision,
      canvas: result.project.canvas,
      captionStyle: resolveCaptionStyle(result.project.captionStyle),
      totalDuration,
      tracks,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    },
    assets,
    assetOffset: extras.assetOffset,
    assetsTruncated,
    totalAssets: result.project.assets.length,
    nextAssetOffset: assetsTruncated ? nextAssetOffset : null,
    ...pages,
    capabilities: extras.capabilities,
  }
}

function previewCommand(
  project: VideoProject,
  command: VideoProjectCommand,
): VideoProjectCommandResult {
  try {
    return applyVideoProjectCommand(project, command)
  } catch (error) {
    throw new ToolError(
      error instanceof Error ? error.message : String(error),
      'invalid_edit',
    )
  }
}

function isSameProject(left: VideoProject, right: VideoProject): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createVideoProjectTools(
  deps: VideoProjectToolDeps,
): ToolDefinition[] {
  const read = defineTool({
    name: 'video_project_read',
    description:
      'Read the current project canvas, tracks, assets, clips, subtitles, annotations, capabilities and revision before editing. Filter clips by trackIds, sourceAssetIds, clipIds, or overlapping timelineStart/timelineEnd in seconds. The timeline time filter also applies to subtitles and annotations. Clips report both timelineRange and sourceRange. Follow the returned next offsets to read more of each collection.',
    category: 'editing',
    input: readInput,
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      const result = await deps.service.inspect(sessionId)
      const timeline = queryTimeline(result.project, args)
      const status = await deps.service.analysisStatus().catch(() => null)
      const transcripts = new Map<string, ProjectTranscriptView>()
      const used = new Set(result.project.clips.map((clip) => clip.assetId))
      const assetOffset = args.assetOffset ?? 0
      const visibleVideoIds = result.project.assets
        .slice(assetOffset, assetOffset + DEFAULT_ASSET_LIMIT)
        .filter((asset) => asset.kind !== 'image' && used.has(asset.id))
        .map((asset) => asset.id)
      for (const [assetId, cached] of await deps.service.transcripts(
        result,
        visibleVideoIds,
      )) {
        const text = cached.segments
          .slice(0, 3)
          .map((segment) => segment.text)
          .join(' ')
        transcripts.set(assetId, {
          available: true,
          language: cached.language,
          segmentCount: cached.segments.length,
          preview: text.slice(0, 160),
        })
      }
      const cloud = status?.transcriptionProvider === 'fun-asr'
      const reason = !status
        ? '媒体分析服务不可用'
        : !status.ffmpegPath
          ? '没有找到 ffmpeg'
          : cloud
            ? status.funAsrConfigured
              ? null
              : '没有配置阿里云 Fun-ASR API Key'
            : !status.whisperPath
              ? '没有找到 whisper-cli'
              : !status.modelPath
                ? '没有找到 Whisper 模型'
                : null
      return JSON.stringify(
        projectView(result, timeline, {
          capabilities: {
            motionEnabled: (await deps.service.motionSettings({ sessionId }))
              .enabled,
            vision: deps.visionRecipient(agentOf(context)) !== null,
            transcription: {
              available: Boolean(status?.ready),
              engine: cloud
                ? 'fun-asr'
                : status?.whisperPath
                  ? 'whisper.cpp'
                  : null,
              model: cloud ? 'fun-asr' : (status?.modelPath ?? null),
              reason,
            },
          },
          transcripts,
          assetOffset,
        }),
      )
    },
  })

  const preview = defineTool({
    name: 'video_edit_preview',
    description:
      'Validate one editing command against the current project and return the before/after summary without writing anything. For rippleDeleteRange, start and end are absolute timeline seconds across all tracks. The preview reports intersecting subtitles that will be removed and surviving intervals where new subtitles can be generated.',
    category: 'editing',
    input: previewInput,
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      const current = await deps.service.inspect(sessionId)
      try {
        const applied = previewCommand(current.project, args.command)
        const summary = commandSummary(
          current.project,
          args.command,
          applied.project,
        )
        return JSON.stringify({
          valid: true,
          summary,
          revision: current.project.revision,
          beforeDuration: timelineLayout(current.project).totalDuration,
          afterDuration: timelineLayout(applied.project).totalDuration,
          selectedClipId: applied.selectedClipId ?? null,
          removedSubtitleIds: applied.removedSubtitleIds,
          retimeSubtitles: applied.retimeSubtitles,
        })
      } catch (error) {
        return JSON.stringify({
          valid: false,
          error: error instanceof Error ? error.message : String(error),
          revision: current.project.revision,
        })
      }
    },
  })

  const apply = defineTool({
    name: 'video_edit_apply',
    description:
      'Apply exactly one user-requested editing command directly to the bound video project. Use this tool to write changes to the timeline manifest.',
    category: 'editing',
    input: applyInput,
    isConcurrencySafe: () => false,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      if (
        'sceneId' in args.command &&
        !(await deps.service.motionSettings({ sessionId })).enabled
      )
        throw new ToolError('工程动效制作已关闭。', 'motion_disabled')
      const current = await deps.service.inspect(sessionId)
      const applied = previewCommand(current.project, args.command)
      const summary = commandSummary(
        current.project,
        args.command,
        applied.project,
      )
      if (isSameProject(applied.project, current.project)) {
        return JSON.stringify({
          applied: false,
          noChange: true,
          revision: current.project.revision,
          summary,
        })
      }
      try {
        const result = await deps.service.mutate({
          sessionId,
          expectedRevision: current.project.revision,
          command: args.command,
          requireMotionEnabled: 'sceneId' in args.command,
          signal: context.signal,
        })
        const totalDuration = timelineLayout(result.project).totalDuration
        deps.emit({
          event: 'video_project_changed',
          session_id: sessionId,
          revision: result.project.revision,
          selectedClipId: result.selectedClipId ?? null,
          totalDuration,
        })
        return JSON.stringify({
          applied: true,
          revision: result.project.revision,
          selectedClipId: result.selectedClipId ?? null,
          totalDuration,
          summary,
          removedSubtitleIds: applied.removedSubtitleIds,
          retimeSubtitles: applied.retimeSubtitles,
        })
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'revision_conflict')
          throw new ToolError(
            '时间线已在别处修改，请先读取最新工程再重试。',
            'revision_conflict',
          )
        throw new ToolError(
          error instanceof Error ? error.message : String(error),
          'invalid_edit',
        )
      }
    },
  })

  const history = defineTool({
    name: 'video_edit_history',
    description:
      'Directly undo or redo the latest edit in the bound project when requested. The history lasts for this app run.',
    category: 'editing',
    input: historyInput,
    isConcurrencySafe: () => false,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      const current = await deps.service.inspect(sessionId)
      const available =
        args.action === 'undo' ? current.canUndo : current.canRedo
      if (!available)
        return JSON.stringify({
          applied: false,
          noHistory: true,
          action: args.action,
          revision: current.project.revision,
          message: `没有可以${args.action === 'undo' ? '撤销' : '重做'}的操作。`,
        })
      try {
        const result =
          args.action === 'undo'
            ? await deps.service.undo({
                sessionId,
                expectedRevision: current.project.revision,
                signal: context.signal,
              })
            : await deps.service.redo({
                sessionId,
                expectedRevision: current.project.revision,
                signal: context.signal,
              })
        const totalDuration = timelineLayout(result.project).totalDuration
        deps.emit({
          event: 'video_project_changed',
          session_id: sessionId,
          revision: result.project.revision,
          selectedClipId: result.selectedClipId ?? null,
          totalDuration,
        })
        return JSON.stringify({
          applied: true,
          action: args.action,
          revision: result.project.revision,
          totalDuration,
        })
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'revision_conflict')
          throw new ToolError(
            '时间线已在别处修改，请先读取最新工程再重试。',
            'revision_conflict',
          )
        throw new ToolError(
          error instanceof Error ? error.message : String(error),
          'invalid_edit',
        )
      }
    },
  })

  const transcribe = defineTool({
    name: 'video_transcribe',
    description:
      'Transcribe one asset using the owner-selected media analysis engine. Pass assetId or clipId. Returns paged raw timestamped speech and writes only a derived cache.',
    category: 'editing',
    input: transcribeInput,
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      const current = await deps.service.inspect(sessionId)
      const asset = assetOf(current.project, args)
      try {
        const { transcript } = await deps.service.transcribe({
          sessionId,
          assetId: asset.id,
          ...(args.language === undefined ? {} : { language: args.language }),
          signal: context.signal,
        })
        const offset = args.offset ?? 0
        const limit = args.limit ?? DEFAULT_TRANSCRIPT_LIMIT
        const segments = transcript.segments.slice(offset, offset + limit)
        return JSON.stringify({
          assetId: asset.id,
          displayName: asset.displayName,
          language: transcript.language,
          cached: transcript.cached,
          model: transcript.model,
          totalSegments: transcript.segments.length,
          offset,
          limit,
          segments,
          truncated: offset + segments.length < transcript.segments.length,
        })
      } catch (cause) {
        const code = (cause as { code?: unknown })?.code
        throw new ToolError(
          cause instanceof Error ? cause.message : String(cause),
          typeof code === 'string' ? code : 'transcription_failed',
        )
      }
    },
  })

  const inspectFrames = defineTool({
    name: 'video_inspect_frames',
    description:
      'Ask the user to approve sending up to 6 JPEG keyframes from a project video to the current vision model. The approval names the destination and source timestamps.',
    category: 'editing',
    input: framesInput,
    isConcurrencySafe: () => false,
    execute: async (args, context) => {
      const agent = agentOf(context)
      const recipient = deps.visionRecipient(agent)
      if (!recipient)
        throw new ToolError(
          '当前模型不支持图片输入，请在设置中切换到支持视觉的模型后再分析画面。',
          'vision_unavailable',
        )
      const sessionId = sessionOf(context)
      const current = await deps.service.inspect(sessionId)
      const asset = assetOf(current.project, args)
      if (asset.kind !== 'video')
        throw new ToolError('只有视频可以提取关键帧。', 'frames_unsupported')
      const clip = args.clipId
        ? current.project.clips.find((item) => item.id === args.clipId)
        : null
      const from = clip ? clip.sourceIn : 0.1
      const to = clip
        ? clip.sourceOut
        : Math.max(0.2, (asset.duration ?? 1) - 0.1)
      const count = args.count ?? 3
      const times =
        args.times ??
        Array.from({ length: count }, (_, index) =>
          Math.min(to, from + ((to - from) * (index + 0.5)) / count),
        )
      const outcome = await deps.approval.request({
        agent,
        toolName: 'video_inspect_frames',
        callId: context.callId,
        reason: `将「${asset.displayName}」的 ${times.length} 张画面（源时间 ${times.map(timeText).join('、')}）发送给 ${recipient.label}。`,
        risk: 'disclosure',
        signal: context.signal,
      })
      if (outcome !== 'allowed-once')
        throw new ToolError('关键帧发送未获授权。', 'frame_disclosure_denied')
      context.signal.throwIfAborted()
      try {
        const { frames } = await deps.service.inspectFrames({
          sessionId,
          assetId: asset.id,
          times,
          signal: context.signal,
          expected: {
            projectId: current.project.projectId,
            revision: current.project.revision,
          },
        })
        const content: ContentBlock[] = []
        for (const frame of frames) {
          const stored = deps.attachments.save({
            raw: frame.bytes,
            name: `${asset.id}-${frame.time.toFixed(2)}.jpg`,
            mime: 'image/jpeg',
          })
          const size = imageDimensions(frame.bytes)
          content.push({
            type: 'image',
            recipientScope: recipient.scope,
            attachment: {
              attachmentId: stored.id,
              mediaType: stored.mime,
              bytes: stored.size,
              ...(size ?? {}),
            },
          })
        }
        const meta = {
          assetId: asset.id,
          displayName: asset.displayName,
          times: frames.map((frame) => frame.time),
          skippedTimes: [...new Set(times)].filter(
            (time) => !frames.some((frame) => frame.time === time),
          ),
          note: '关键帧按源素材时间抽取；图片只用于本次分析。',
        }
        content.push({ type: 'text', text: JSON.stringify(meta) })
        return { content, meta: { videoFrames: meta } }
      } catch (cause) {
        const code = (cause as { code?: unknown })?.code
        throw new ToolError(
          cause instanceof Error ? cause.message : String(cause),
          typeof code === 'string' ? code : 'frames_failed',
        )
      }
    },
  })

  const focus = defineTool({
    name: 'video_project_focus',
    description:
      'Select a clip and/or move the editor playhead so the user can see the result. This changes only the editor view, never the project file.',
    category: 'editing',
    input: focusInput,
    isConcurrencySafe: () => true,
    execute: async (args, context) => {
      const sessionId = sessionOf(context)
      const current = await deps.service.inspect(sessionId)
      const total = timelineLayout(current.project).totalDuration
      let clipId = args.clipId
      let time = args.time
      if (clipId !== undefined) {
        clipOf(current.project, clipId)
        if (time === undefined) {
          const range = timelineRange(current.project, clipId)
          time = range?.start ?? 0
        }
      } else if (time !== undefined) {
        const at = timelineClipAt(current.project, time)
        clipId = at?.clip.id
      }
      if (time !== undefined) time = Math.max(0, Math.min(time, total))
      deps.emit({
        event: 'video_project_focus',
        session_id: sessionId,
        ...(clipId === undefined ? {} : { clipId }),
        ...(time === undefined ? {} : { time }),
      })
      return JSON.stringify({
        focused: true,
        ...(clipId === undefined ? {} : { clipId }),
        ...(time === undefined ? {} : { time }),
        revision: current.project.revision,
      })
    },
  })

  return [read, preview, apply, history, transcribe, inspectFrames, focus]
}
