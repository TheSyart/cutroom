import { describe, expect, it, vi } from 'vitest'
import { createComposerLifecycleController } from './composerLifecycle'

describe('plan lifecycle', () => {
  it('enters once, and dismisses to the normal editing conversation', async () => {
    let control = { preset: 'workspace-write' as const, plan: false }
    const setPlanEnabled = vi.fn(async (plan: boolean) => {
      control = { ...control, plan }
    })
    const lifecycle = createComposerLifecycleController({
      currentControl: () => control,
      agentBusy: () => false,
      setPlanEnabled,
    })
    expect(await lifecycle.activatePlan()).toMatchObject({
      mode: 'plan',
      changed: true,
    })
    expect(await lifecycle.activatePlan()).toMatchObject({ changed: false })
    expect(await lifecycle.dismissLifecycle()).toMatchObject({
      mode: null,
      changed: true,
    })
    expect(setPlanEnabled.mock.calls).toEqual([[true], [false]])
  })
  it('refuses a change during an active turn', async () => {
    const setPlanEnabled = vi.fn()
    const lifecycle = createComposerLifecycleController({
      currentControl: () => null,
      agentBusy: () => true,
      setPlanEnabled,
    })
    expect((await lifecycle.activatePlan()).ok).toBe(false)
    expect(setPlanEnabled).not.toHaveBeenCalled()
  })
})
