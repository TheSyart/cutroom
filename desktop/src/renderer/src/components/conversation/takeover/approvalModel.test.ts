import { describe, expect, it } from 'vitest'
import { riskLabel } from './approvalModel'

describe('approval risk labels', () => {
  it('shows a project edit as 修改工程 rather than a sandbox escalation', () => {
    expect(riskLabel('edit')).toBe('修改工程')
    expect(riskLabel('escalation')).toBe('需要提权')
  })
})
