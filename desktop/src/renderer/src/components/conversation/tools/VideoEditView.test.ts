// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import VideoEditView from './VideoEditView.vue'

let app: App | undefined
let root: HTMLDivElement

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  app?.unmount()
  root.remove()
})

function data(text: string, isError = false): ToolChatData {
  return {
    callId: 'call-1',
    name: 'video_edit_apply',
    argsRaw: '{}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: { seq: 1, time: 1, content: [{ type: 'text', text }], isError },
  } as ToolChatData
}

async function mount(input: ToolChatData) {
  app = createApp(VideoEditView, { data: input })
  app.mount(root)
  await nextTick()
}

describe('VideoEditView', () => {
  it('shows the semantic edit summary and duration change', async () => {
    await mount(
      data(
        JSON.stringify({
          applied: true,
          summary: '修剪「interview.mp4」第 1 段',
          beforeDuration: 10,
          afterDuration: 4,
          revision: 4,
        }),
      ),
    )
    expect(root.textContent).toContain('修剪「interview.mp4」第 1 段')
    expect(root.textContent).toContain('前 10.00 秒')
    expect(root.textContent).toContain('后 4.00 秒')
    expect(root.textContent).toContain('r4')
    expect(root.querySelector('.video-edit')?.getAttribute('data-state')).toBe(
      'ok',
    )
  })

  it('marks an invalid preview as an error without dumping raw JSON', async () => {
    await mount(
      data(
        JSON.stringify({
          valid: false,
          error: '剪切范围不能超出素材时长。',
          revision: 3,
        }),
      ),
    )
    expect(root.textContent).toContain('剪切范围不能超出素材时长。')
    expect(root.querySelector('.video-edit')?.getAttribute('data-state')).toBe(
      'error',
    )
    expect(root.textContent).not.toContain('{"valid"')
  })

  it('falls back to the generic card for a non-JSON result', async () => {
    await mount(data('没有找到这个时间线片段。', true))
    expect(root.querySelector('.video-edit')).toBeNull()
    expect(root.textContent).toContain('没有找到这个时间线片段。')
  })
})
