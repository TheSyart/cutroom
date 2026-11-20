import type { Component } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import {
  DsBrowse,
  DsEdit,
  DsInspect,
  DsPlan,
  DsQuestion,
  DsSkill,
  DsSparkle,
} from '../../icons/ds'
import {
  PLAN_OUTCOME_LABEL,
  argsOf,
  argsPreview,
  memoryTargetLabel,
  numberArg,
  planOutcome,
  planTitle,
  questionItems,
  resultText,
  stringArg,
  truncate,
} from './toolModel'

export type ToolBodyKind = 'ask' | 'plan' | 'skill' | 'video' | 'generic'

export interface ToolViewSpec {
  readonly icon: Component
  readonly body: ToolBodyKind
  title(data: ToolChatData): string
  summary(data: ToolChatData): string
}

const join = (...parts: (string | undefined | null | false)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join(' · ')

const memoryEdit: ToolViewSpec = {
  icon: DsEdit,
  body: 'generic',
  title: () => '记忆',
  summary: (data) => {
    const args = argsOf(data)
    return join(
      memoryTargetLabel(stringArg(args, 'target')),
      stringArg(args, 'old_string') === undefined ? '追加' : '替换',
    )
  },
}

const askUserQuestion: ToolViewSpec = {
  icon: DsQuestion,
  body: 'ask',
  title: () => '提问',
  summary: (data) => {
    const items = questionItems(data)
    const first = items[0]?.question
    const outcome = data.question?.outcome
    if (data.status === 'interrupted') return join('已中断', first)
    if (outcome === 'cancelled') return join('已取消', first)
    if (outcome === 'unavailable') return join('无法提问', first)
    if (outcome === 'answered') {
      const answered = items.filter(
        (item) => item.selected.length > 0 || item.custom !== undefined,
      ).length
      return join(`已回答 ${answered}/${items.length}`, first)
    }
    if (data.status === 'running') return join('等待回答', first)
    return first ?? ''
  },
}

const exitPlanMode: ToolViewSpec = {
  icon: DsPlan,
  body: 'plan',
  title: () => '计划',
  summary: (data) => {
    const plan = stringArg(argsOf(data), 'plan') ?? ''
    const outcome = planOutcome(data).outcome
    // While waiting the row is folded and the review card below holds the
    // plan (BUG-02).
    return join(
      planTitle(plan),
      outcome === 'waiting' ? '等待你在下方确认' : PLAN_OUTCOME_LABEL[outcome],
    )
  },
}

const skill: ToolViewSpec = {
  icon: DsSkill,
  body: 'skill',
  title: () => '技能',
  summary: (data) => stringArg(argsOf(data), 'name') ?? '',
}

const VIDEO_COMMAND_LABEL: Readonly<Record<string, string>> = {
  addClip: '添加片段',
  trimClip: '修剪片段',
  splitClip: '拆分片段',
  deleteClip: '删除片段',
  reorderClip: '调整顺序',
  updateClip: '调整片段',
  updateCanvas: '调整画面',
}

function videoCommandLabel(data: ToolChatData): string {
  const command = argsOf(data).command
  if (command === null || typeof command !== 'object' || Array.isArray(command))
    return ''
  const type = (command as { type?: unknown }).type
  return typeof type === 'string' ? (VIDEO_COMMAND_LABEL[type] ?? type) : ''
}

function videoResult(data: ToolChatData): Record<string, unknown> | null {
  const source = resultText(data).trim()
  if (!source.startsWith('{')) return null
  try {
    const value = JSON.parse(source) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function videoSummary(data: ToolChatData): string {
  const result = videoResult(data)
  const summary =
    typeof result?.summary === 'string'
      ? result.summary
      : typeof result?.message === 'string'
        ? result.message
        : ''
  return truncate(summary) || videoCommandLabel(data)
}

const videoRead: ToolViewSpec = {
  icon: DsBrowse,
  body: 'video',
  title: () => '读取剪辑工程',
  summary: (data) => {
    const result = videoResult(data)
    const project = result?.project
    if (project === null || typeof project !== 'object')
      return videoCommandLabel(data)
    const revision = (project as { revision?: unknown }).revision
    const clips = result?.totalClips
    return join(
      typeof revision === 'number' ? `r${revision}` : undefined,
      typeof clips === 'number' ? `${clips} 个片段` : undefined,
    )
  },
}

const videoPreview: ToolViewSpec = {
  icon: DsInspect,
  body: 'video',
  title: () => '预演剪辑',
  summary: videoSummary,
}

const videoApply: ToolViewSpec = {
  icon: DsEdit,
  body: 'video',
  title: () => '修改时间线',
  summary: videoSummary,
}

const videoHistory: ToolViewSpec = {
  icon: DsEdit,
  body: 'video',
  title: () => '撤销 / 重做',
  summary: (data) => {
    const action = stringArg(argsOf(data), 'action')
    const result = videoResult(data)
    return join(
      action === 'redo' ? '重做' : '撤销',
      typeof result?.revision === 'number' ? `r${result.revision}` : undefined,
    )
  },
}

const videoTranscribe: ToolViewSpec = {
  icon: DsBrowse,
  body: 'video',
  title: () => '转写素材',
  summary: (data) => {
    const result = videoResult(data)
    return join(
      typeof result?.displayName === 'string' ? result.displayName : undefined,
      typeof result?.totalSegments === 'number'
        ? `${result.totalSegments} 段台词`
        : undefined,
      result?.cached === true ? '缓存' : undefined,
    )
  },
}

const videoInspectFrames: ToolViewSpec = {
  icon: DsInspect,
  body: 'generic',
  title: () => '查看关键帧',
  summary: (data) => {
    const args = argsOf(data)
    const times = Array.isArray(args.times) ? args.times.length : undefined
    return times ? `${times} 张画面` : '已在对话中查看画面'
  },
}

const videoFocus: ToolViewSpec = {
  icon: DsInspect,
  body: 'video',
  title: () => '定位片段',
  summary: (data) => {
    const args = argsOf(data)
    return join(
      stringArg(args, 'clipId'),
      numberArg(args, 'time') !== undefined
        ? `${numberArg(args, 'time')!.toFixed(2)} 秒`
        : undefined,
    )
  },
}

const generic: ToolViewSpec = {
  icon: DsSparkle,
  body: 'generic',
  title: (data) => data.name,
  summary: (data) => argsPreview(argsOf(data)),
}

function editingStep(title: string): ToolViewSpec {
  return { ...generic, icon: DsEdit, title: () => title }
}

const REGISTRY: Readonly<Record<string, ToolViewSpec>> = {
  memory_edit: memoryEdit,
  ask_user_question: askUserQuestion,
  exit_plan_mode: exitPlanMode,
  skill,
  video_project_read: videoRead,
  video_edit_preview: videoPreview,
  video_edit_apply: videoApply,
  video_edit_history: videoHistory,
  video_project_focus: videoFocus,
  video_transcribe: videoTranscribe,
  video_inspect_frames: videoInspectFrames,
  video_start_precision_edit: editingStep('开始精剪'),
  video_analyze_workspace: editingStep('分析剪辑工程'),
  video_read_video: editingStep('查看素材'),
  video_read_evidence: editingStep('查看分析证据'),
  video_propose_treatment: editingStep('拟定剪辑方案'),
  video_stage_edit: editingStep('编排剪辑'),
  video_preview_edit: editingStep('预演精剪'),
  video_review_draft: editingStep('审看草稿'),
  video_finish_draft: editingStep('完成草稿'),
  video_read_source_notes: editingStep('查看素材笔记'),
  video_record_source_notes: editingStep('记录素材笔记'),
  video_motion_read: editingStep('查看动效'),
  video_motion_begin: editingStep('开启动效编辑'),
  video_motion_object: editingStep('编辑动效对象'),
  video_motion_finish: editingStep('完成动效编辑'),
  video_motion_cancel: editingStep('取消动效编辑'),
}

export const REGISTERED_TOOLS: readonly string[] = Object.keys(REGISTRY)

export function isCutroomTool(name: string): boolean {
  return Object.hasOwn(REGISTRY, name)
}

export function toolView(name: string): ToolViewSpec {
  return isCutroomTool(name) ? REGISTRY[name]! : generic
}
