import { describe, expect, it } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import { REGISTERED_TOOLS, toolView } from './registry'
import {
  errorSummary,
  hunksFromUnifiedDiff,
  mutationHunks,
  readWindow,
  shellOutcome,
  toolRowState,
} from './toolModel'

function tool(
  name: string,
  args: unknown,
  result?: {
    text: string
    isError?: boolean
    meta?: unknown
    code?: string
  },
  extra: Partial<ToolChatData> = {},
): ToolChatData {
  return {
    callId: `call-${name}`,
    name,
    argsRaw: JSON.stringify(args),
    turn: 1,
    step: 1,
    time: 0,
    status: result === undefined ? 'running' : 'settled',
    approvals: [],
    ...(result === undefined
      ? {}
      : {
          result: {
            seq: 1,
            time: 1,
            content: [{ type: 'text', text: result.text }],
            isError: result.isError === true,
            ...(result.meta === undefined
              ? {}
              : { meta: result.meta as never }),
            ...(result.code === undefined
              ? {}
              : { error: { name: 'ToolError', code: result.code } }),
          },
        }),
    ...extra,
  } as ToolChatData
}

const row = (data: ToolChatData) => {
  const view = toolView(data.name)
  return {
    title: view.title(data),
    summary: view.summary(data),
    body: view.body,
  }
}

describe('tool registry titles and summaries', () => {
  it('renders the seven editing tools with semantic titles and summaries', () => {
    const read = tool(
      'video_project_read',
      {},
      { text: JSON.stringify({ project: { revision: 3 }, totalClips: 2 }) },
    )
    expect(row(read)).toMatchObject({
      title: '读取剪辑工程',
      summary: 'r3 · 2 个片段',
      body: 'video',
    })
    const preview = tool(
      'video_edit_preview',
      { command: { type: 'trimClip' } },
      { text: JSON.stringify({ valid: true, summary: '修剪片段到 4 秒' }) },
    )
    expect(row(preview)).toMatchObject({
      title: '预演剪辑',
      summary: '修剪片段到 4 秒',
      body: 'video',
    })
    const apply = tool(
      'video_edit_apply',
      { command: { type: 'deleteClip' } },
      {
        text: JSON.stringify({
          applied: true,
          revision: 4,
          summary: '删除「interview.mp4」',
        }),
      },
    )
    expect(row(apply)).toMatchObject({
      title: '修改时间线',
      summary: '删除「interview.mp4」',
      body: 'video',
    })
    const history = tool(
      'video_edit_history',
      { action: 'undo' },
      { text: JSON.stringify({ applied: true, revision: 5 }) },
    )
    expect(row(history)).toMatchObject({
      title: '撤销 / 重做',
      summary: '撤销 · r5',
      body: 'video',
    })
    const focus = tool(
      'video_project_focus',
      { clipId: 'clip-1', time: 2.5 },
      { text: JSON.stringify({ focused: true }) },
    )
    expect(row(focus)).toMatchObject({
      title: '定位片段',
      summary: 'clip-1 · 2.50 秒',
      body: 'video',
    })
    const transcribe = tool(
      'video_transcribe',
      { assetId: 'asset-1' },
      {
        text: JSON.stringify({
          displayName: 'interview.mp4',
          totalSegments: 12,
          cached: true,
        }),
      },
    )
    expect(row(transcribe)).toMatchObject({
      title: '转写素材',
      summary: 'interview.mp4 · 12 段台词 · 缓存',
      body: 'video',
    })
    const frames = tool(
      'video_inspect_frames',
      { assetId: 'asset-1', times: [0, 1, 2] },
      { text: JSON.stringify({ times: [0, 1, 2] }) },
    )
    expect(row(frames)).toMatchObject({
      title: '查看关键帧',
      summary: '3 张画面',
      body: 'generic',
    })
    for (const name of [
      'video_project_read',
      'video_edit_preview',
      'video_edit_apply',
      'video_edit_history',
      'video_project_focus',
      'video_transcribe',
      'video_inspect_frames',
    ])
      expect(REGISTERED_TOOLS).toContain(name)
  })

  it('ask_user_question follows the interaction outcome', () => {
    const args = {
      questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
    }
    expect(row(tool('ask_user_question', args)).summary).toBe(
      '等待回答 · Which?',
    )
    const answered = tool(
      'ask_user_question',
      args,
      { text: '{}' },
      {
        question: {
          id: 'x',
          questions: args.questions as never,
          outcome: 'answered',
          answers: { q: { selected: ['a'] } },
        },
      },
    )
    expect(row(answered).summary).toBe('已回答 1/1 · Which?')
    const cancelled = tool(
      'ask_user_question',
      args,
      { text: '', isError: true },
      {
        question: {
          id: 'x',
          questions: args.questions as never,
          outcome: 'cancelled',
        },
      },
    )
    expect(row(cancelled).summary).toBe('已取消 · Which?')
  })

  it('exit_plan_mode reports the review outcome', () => {
    const plan = { plan: '# Ship it\n\n1. do' }
    expect(row(tool('exit_plan_mode', plan)).summary).toBe(
      'Ship it · 等待你在下方确认',
    )
    expect(
      row(
        tool('exit_plan_mode', plan, { text: 'ok', meta: { approved: true } }),
      ).summary,
    ).toBe('Ship it · 已批准')
    expect(
      row(
        tool('exit_plan_mode', plan, {
          text: 'The user chose to keep planning; their feedback: more tests',
          isError: true,
          code: 'PLAN_REJECTED',
        }),
      ).summary,
    ).toBe('Ship it · 继续规划')
    // A dismissed review is a successful, turn-ending result, never an approval.
    expect(
      row(
        tool('exit_plan_mode', plan, {
          text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
          meta: { approved: false, dismissed: true },
        }),
      ).summary,
    ).toBe('Ship it · 已取消')
  })

  it.each([
    'bash',
    'read',
    'subagent',
    'job_kill',
    'mcp_docs_fetch',
    'ui_click',
    'browser_open',
    'workflow',
    'scheduler',
    'constructor',
  ])('renders %s using the read-only history card', (name) => {
    expect(REGISTERED_TOOLS).not.toContain(name)
    expect(
      row(tool(name, { value: 'stored input' }, { text: 'old output' })),
    ).toMatchObject({
      title: name,
      body: 'generic',
      summary: 'stored input',
    })
  })
})

describe('tool model readers', () => {
  it('derives row state and error summaries', () => {
    expect(toolRowState(tool('read', {}))).toBe('running')
    expect(
      toolRowState(tool('read', {}, { text: 'x' }, { status: 'interrupted' })),
    ).toBe('stopped')
    const failed = tool(
      'read',
      {},
      { text: 'ENOENT: no such file\nat x', isError: true },
    )
    expect(toolRowState(failed)).toBe('error')
    expect(errorSummary(failed)).toBe('ENOENT: no such file')
    const exit = tool(
      'bash',
      { command: 'false' },
      {
        text: '(no output)\n[exit code: 1]',
        meta: { kind: 'foreground', exitCode: 1 },
      },
    )
    expect(toolRowState(exit)).toBe('error')
    expect(errorSummary(exit)).toBe('退出码 1')
  })

  it('strips shell markers from terminal output', () => {
    const data = tool(
      'bash',
      { command: 'x' },
      {
        text: 'hello\n[stderr]\nwarn\n[exit code: 2]',
        meta: { kind: 'foreground', exitCode: 2 },
      },
    )
    expect(shellOutcome(data)).toMatchObject({
      output: 'hello\n[stderr]\nwarn',
      exitCode: 2,
      background: false,
    })
  })

  it('parses the read envelope', () => {
    const data = tool(
      'read',
      { file_path: 'a.ts' },
      {
        text: '<path>a.ts</path>\n<type>file</type>\n<content>\n1: one\n2: \n3: three\n\n(End of file - total 3 lines)\n</content>',
        meta: { path: 'a.ts', startLine: 1, endLine: 3, totalLines: 3 },
      },
    )
    expect(readWindow(data)).toEqual({
      path: 'a.ts',
      totalLines: 3,
      lines: [
        { number: 1, text: 'one' },
        { number: 2, text: '' },
        { number: 3, text: 'three' },
      ],
    })
  })

  it('builds diff hunks for mutations', () => {
    expect(
      mutationHunks(
        tool('edit', { file_path: 'a', old_string: 'x', new_string: 'y' }),
      ),
    ).toEqual([{ path: 'a', oldText: 'x', newText: 'y' }])
    expect(
      mutationHunks(tool('write', { file_path: 'a', content: 'z' })),
    ).toEqual([{ path: 'a', oldText: null, newText: 'z' }])
    expect(
      hunksFromUnifiedDiff(
        '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new',
        'f',
      ),
    ).toEqual([{ path: 'f', oldText: 'keep\nold\n', newText: 'keep\nnew\n' }])
  })
})
