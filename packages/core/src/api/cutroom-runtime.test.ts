import { expect, it } from 'vitest'
import { coreOperationKeys, invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'

it('boots only the editing runtime and rejects retired operations before dispatch', async () => {
  const { api } = await makeApi({ replies: [{ text: 'Ready' }] })
  try {
    const names = api.host.tools.names()
    expect(names).toEqual(
      expect.arrayContaining([
        'skill',
        'ask_user_question',
        'exit_plan_mode',
        'video_project_read',
      ]),
    )
    for (const name of [
      'bash',
      'write',
      'edit',
      'subagent',
      'workflow',
      'web_fetch',
      'mcp_config',
      'scheduler',
    ]) {
      expect(names).not.toContain(name)
    }
    const ops = new Set<string>(coreOperationKeys())
    for (const key of [
      'executors.list',
      'git.status',
      'mcp.status',
      'scheduler.createJob',
      'terminals.create',
      'hooks.getConfig',
      'desktopPet.get',
      'memory.checkWatchlist',
    ] as const) {
      expect(ops.has(key)).toBe(false)
      await expect(invokeCoreOperation(api, key, [])).rejects.toThrow(
        'Unknown Cutroom operation',
      )
    }
    for (const service of [
      'subagents',
      'mcpTools',
      'hooks',
      'watchlist',
      'computerUse',
    ]) {
      expect(api.host).not.toHaveProperty(service)
    }
    for (const service of [
      'mcpClient',
      'schedulerService',
      'processRuntime',
      'managedEnvironmentService',
    ]) {
      expect(api.host.kept).not.toHaveProperty(service)
    }
  } finally {
    await api.close()
  }
})

it('keeps an unanswered grant from an old log readable without taking over the editor', async () => {
  const { api } = await makeApi({ replies: [] })
  try {
    const id = String(api.sessions.create({ title: 'Archived grant' }).id)
    const agent = api.host.agentFor(id)
    agent.session.append('ui/grant-requested', {
      requestId: 'archived-grant',
      subject: 'old-call',
      driver: 'desktop',
      targetScope: { kind: 'desktop', appId: 'old-app' },
      actions: ['observe'],
      allowedScopes: ['once'],
    })
    expect(agent.session.events.at(-1)?.type).toBe('ui/grant-requested')
    expect(api.host.controlPayload(id).pending).toBeNull()
  } finally {
    await api.close()
  }
})
