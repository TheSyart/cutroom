import { describe, expect, it } from 'vitest'
import { approvalInteraction, questionInteraction } from './interactions'

describe('question interactions', () => {
  const asked = {
    id: 'q1',
    questions: [{ id: 'a', header: 'codex', question: '用哪个分支？' }],
  }

  it('7 · an external subagent’s question names its task, so its own page can answer it (AGT-10)', () => {
    const interaction = questionInteraction(
      {
        ...asked,
        external: {
          delegationId: 'dlg-1',
          runId: 'dgr-1',
          generation: 1,
          requestId: 'req-1',
          backend: 'codex',
        },
      } as never,
      1000,
    )
    expect(interaction.meta).toMatchObject({
      interaction_type: 'question',
      question_id: 'q1',
      external_delegation_id: 'dlg-1',
      external_run_id: 'dgr-1',
    })
  })

  it('a question of the agent itself carries no task', () => {
    const interaction = questionInteraction(asked as never, 1000)
    expect(interaction.meta).toEqual({
      interaction_type: 'question',
      question_id: 'q1',
    })
  })
})

describe('approval interactions', () => {
  it('labels an editing approval as an edit, not a sandbox escalation', () => {
    const interaction = approvalInteraction(
      {
        id: 'a1',
        toolName: 'video_edit_apply',
        reason: '修改工程',
        risk: 'edit',
      },
      undefined,
      1000,
    )
    const permission = (
      interaction.meta as {
        permission: { operations: Array<{ risk: string }> }
      }
    ).permission
    expect(permission.operations[0]?.risk).toBe('edit')
  })
})
