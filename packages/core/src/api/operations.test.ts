import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { SessionEntry } from '../sessions/store'
import type { CoreApi } from './core-api'
import {
  CORE_OPERATION_REGISTRY,
  coreOperationDescriptors,
  coreOperationKeys,
  invokeCoreOperation,
  isCoreOperationKey,
  type CoreOperationArgs,
  type CoreOperationKey,
  type CoreOperationResult,
} from './operations'

describe('Core operation registry', () => {
  it('owns every public CoreApi operation in one descriptor registry', () => {
    const descriptors = coreOperationDescriptors()
    const descriptorKeys = descriptors.map((entry) => entry.key)

    expect(coreOperationKeys()).toEqual(descriptorKeys)
    expect(Object.keys(CORE_OPERATION_REGISTRY).sort()).toEqual(descriptorKeys)
    expect(
      descriptors.every((descriptor) =>
        Boolean(
          descriptor.handlerKey === descriptor.key &&
          descriptor.audience === 'main_renderer' &&
          descriptor.classification === 'application_operation' &&
          descriptor.inputSchema ===
            CORE_OPERATION_REGISTRY[descriptor.key].args,
        ),
      ),
    ).toBe(true)
    expect(descriptorKeys).toContain('videoProject.open')
    expect(descriptorKeys).toContain('chat.submit')
    expect(
      descriptorKeys.filter((key) =>
        /^(git|terminals|scheduler|delegations|executors|computerUse|desktopPet|hooks|mcp|agents|tasks|environment|browser|processes|workspace)\./.test(
          key,
        ),
      ),
    ).toEqual([])
  })

  it('validates the reference operation boundary', () => {
    const registry = CORE_OPERATION_REGISTRY as unknown as Record<
      string,
      { args: { parse(input: unknown): unknown } }
    >
    const input = {
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/guide.md#L4',
      label: 'Guide',
    }
    expect(registry['references.resolve']?.args.parse([input])).toEqual([input])
    expect(() =>
      registry['references.resolve']?.args.parse([
        { ...input, absolutePath: '/forged/path' },
      ]),
    ).toThrow()
  })

  it('validates the new-session permission change (UI-S07)', () => {
    const args = CORE_OPERATION_REGISTRY['sessions.setDefaults'].args
    for (const permission of [
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])
      expect(args.parse([{ permission }])).toEqual([{ permission }])
    for (const bad of [
      { permission: 'root' },
      { permission: 'read-only', extra: true },
      {},
    ])
      expect(() => args.parse([bad]), JSON.stringify(bad)).toThrow()
  })

  it('validates the simplified model editor and the replacement (MOD-05)', () => {
    const save = CORE_OPERATION_REGISTRY['model.saveEntry'].args
    expect(
      save.parse([
        {
          entryId: 'pro',
          sampling: { temperature: 0.7 },
          lockFields: ['contextWindowTokens', 'maxTokens'],
        },
      ]),
    ).toEqual([
      {
        entryId: 'pro',
        sampling: { temperature: 0.7 },
        lockFields: ['contextWindowTokens', 'maxTokens'],
      },
    ])
    expect(
      save.parse([{ entryId: 'pro', sampling: { temperature: null } }]),
    ).toEqual([{ entryId: 'pro', sampling: { temperature: null } }])
    for (const bad of [
      { entryId: 'pro', sampling: { temperature: 3 } },
      { entryId: 'pro', lockFields: ['apiKey'] },
    ])
      expect(() => save.parse([bad]), JSON.stringify(bad)).toThrow()
    const replace = CORE_OPERATION_REGISTRY['model.replaceEntry'].args
    expect(
      replace.parse([{ entryId: 'chat', modelId: 'deepseek-flash' }]),
    ).toEqual([{ entryId: 'chat', modelId: 'deepseek-flash' }])
    expect(() => replace.parse([{ entryId: 'chat' }])).toThrow()
  })

  it('accepts the three permission presets and Plan mode', () => {
    expect(
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
        'workspace-write',
      ]),
    ).toEqual(['workspace-write'])
    expect(
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
        'read-only',
        'session-1',
      ]),
    ).toEqual(['read-only', 'session-1'])
    for (const legacy of ['plan', 'accept_edits', 'full_access'])
      expect(() =>
        CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
          legacy,
        ]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['control.setMode'].args.parse(['plan']),
    ).toEqual(['plan'])
    expect(() =>
      CORE_OPERATION_REGISTRY['control.setMode'].args.parse(['auto']),
    ).toThrow()
  })

  it('FIX-13 · a draft carries its own plan mode and preset', () => {
    const draftSession = { mode: 'chat', plan: true, preset: 'read-only' }
    expect(
      CORE_OPERATION_REGISTRY['chat.submit'].args.parse([
        { content: 'hi', sessionId: 'draft:1', draftSession },
      ])[0],
    ).toMatchObject({ draftSession })
    expect(
      CORE_OPERATION_REGISTRY['sessions.create'].args.parse([
        { title: '新会话', mode: 'chat', plan: true, preset: 'read-only' },
      ]),
    ).toEqual([
      { title: '新会话', mode: 'chat', plan: true, preset: 'read-only' },
    ])
    for (const bad of [
      { ...draftSession, preset: 'plan' },
      { ...draftSession, plan: 'yes' },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['chat.submit'].args.parse([
          { content: 'hi', sessionId: 'draft:1', draftSession: bad },
        ]),
      ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.create'].args.parse([
        { preset: 'full_access' },
      ]),
    ).toThrow()
  })

  it('uses exact Zod tuples for no-arg, optional, single, and multi-arg operations', () => {
    expect(CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([])).toEqual([])
  })

  it('accepts chips that sit in the text and refuses ones that do not', () => {
    const submit = CORE_OPERATION_REGISTRY['chat.submit']
    const chip = {
      kind: 'skill' as const,
      id: 'reviewer',
      label: 'Reviewer',
      start: 2,
      end: 11,
    }
    expect(() =>
      submit.args.parse([{ content: '请 /reviewer 看看', references: [chip] }]),
    ).not.toThrow()
    for (const bad of [
      { ...chip, start: 1, end: 10 },
      { ...chip, id: 'Reviewer' },
      { ...chip, kind: 'plugin' as const },
      { ...chip, end: 99 },
    ])
      expect(
        () =>
          submit.args.parse([
            { content: '请 /reviewer 看看', references: [bad] },
          ]),
        JSON.stringify(bad),
      ).toThrow()
    const invoke = CORE_OPERATION_REGISTRY['commands.invoke']
    const request = {
      sessionId: 's1',
      commandId: 'skill.user.reviewer',
      rawInput: '/reviewer 看看',
      invocationId: 'inv-1',
      invocationSource: 'desktop' as const,
    }
    expect(() =>
      invoke.args.parse([
        { ...request, references: [{ ...chip, start: 0, end: 9 }] },
      ]),
    ).not.toThrow()
    expect(() =>
      invoke.args.parse([{ ...request, references: [chip] }]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([{}]),
    ).toThrow()

    expect(CORE_OPERATION_REGISTRY.bootstrap.args.parse([])).toEqual([])
    expect(
      CORE_OPERATION_REGISTRY.bootstrap.args.parse([{ sessionId: 's1' }]),
    ).toEqual([{ sessionId: 's1' }])
    expect(() => CORE_OPERATION_REGISTRY.bootstrap.args.parse(['s1'])).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { title: 'New title' },
      ]),
    ).toEqual(['s1', { title: 'New title' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse(['s1']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { archived: 'yes' },
      ]),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['sessions.history'].args.parse([
        { sessionId: 'sub-1', beforeSeq: 10, maxMessages: 20 },
      ]),
    ).toEqual([{ sessionId: 'sub-1', beforeSeq: 10, maxMessages: 20 }])
    expect(
      CORE_OPERATION_REGISTRY['sessions.history'].args.parse([
        { sessionId: 's1' },
      ]),
    ).toEqual([{ sessionId: 's1' }])
    for (const invalid of [
      { sessionId: '../etc' },
      { sessionId: 's1', beforeSeq: -1 },
      { sessionId: 's1', maxMessages: 0 },
      { sessionId: 's1', extra: true },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['sessions.history'].args.parse([invalid]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.event'].args.parse([
        { sessionId: 'sub-1', seq: 3 },
      ]),
    ).toEqual([{ sessionId: 'sub-1', seq: 3 }])
    for (const invalid of [
      { sessionId: 's1' },
      { sessionId: 's1', seq: -1 },
      { sessionId: '../x', seq: 1 },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['sessions.event'].args.parse([invalid]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.lineage'].args.parse([
        { sessionId: 's1' },
      ]),
    ).toEqual([{ sessionId: 's1' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.children'].args.parse(['s1']),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.watch'].args.parse([
        { sessionIds: ['s1', 'sub-2'] },
      ]),
    ).toEqual([{ sessionIds: ['s1', 'sub-2'] }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.watch'].args.parse([
        { sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) },
      ]),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([
        { sessionId: 's1', afterSeq: 0, format: 'projection' },
      ]),
    ).toEqual([{ sessionId: 's1', afterSeq: 0, format: 'projection' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([
        { format: 'envelope_v2' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([{ format: 'raw' }]),
    ).toThrow()
  })

  it('exposes only typed schema-v2 model mutations', () => {
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'model.saveEntry',
        'model.deleteEntry',
        'model.activate',
        'model.resolveProfile',
        'model.setReasoningEffort',
      ]),
    )
    expect(coreOperationKeys()).not.toContain('model.saveConfig')
    expect(coreOperationKeys()).not.toContain('model.saveOnboardingConfig')

    expect(
      CORE_OPERATION_REGISTRY['model.saveEntry'].args.parse([
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          apiBase: 'https://api.openai.com/v1',
          apiKey: null,
          contextWindowTokens: 128_000,
          maxTokens: 16_000,
          reasoningEffort: 'high',
          capabilityOverrides: { vision: false },
        },
      ]),
    ).toHaveLength(1)
    expect(() =>
      CORE_OPERATION_REGISTRY['model.saveEntry'].args.parse([
        { config: { arbitrary: true } },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['model.test'].args.parse([
        { entryId: 'entry-1', kind: 'text', role: 'secondary' },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['model.resolveProfile'].args.parse([
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          capabilityOverrides: { vision: false },
          contextWindowTokens: 128_000,
          maxTokens: 16_000,
        },
      ]),
    ).toHaveLength(1)
    expect(
      CORE_OPERATION_REGISTRY['model.test'].args.parse([
        { entryId: 'entry-1', kind: 'vision' },
      ]),
    ).toEqual([{ entryId: 'entry-1', kind: 'vision' }])
    // MOD-02: listing and probing take the form's draft connection.
    const draft = {
      provider: 'moonshot',
      protocol: 'openai',
      apiBase: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-draft',
      connectionId: 'conn-1',
      workspaceId: 'llm-ws01',
    }
    expect(
      CORE_OPERATION_REGISTRY['model.probeConnection'].args.parse([draft]),
    ).toEqual([draft])
    expect(
      CORE_OPERATION_REGISTRY['model.discoverModels'].args.parse([
        { ...draft, refresh: true },
      ]),
    ).toEqual([{ ...draft, refresh: true }])
    for (const bad of [
      { ...draft, refresh: true },
      { ...draft, apiKey: 42 },
      { ...draft, workspaceId: 'x'.repeat(64) },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['model.probeConnection'].args.parse([bad]),
      ).toThrow()
  })

  it('rejects malformed security-sensitive payloads before invoking CoreApi', () => {
    expect(() =>
      CORE_OPERATION_REGISTRY['attachments.save'].args.parse([
        { raw: 'not-bytes', name: 'a.txt', mime: 'text/plain' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['chat.submit'].args.parse([
        {
          content: 'review',
          requestedSkills: [{ name: '../outside', source: 'slash' }],
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.create'].args.parse([
        { name: '../outside', description: 'Unsafe' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.copyToUser'].args.parse([
        { name: 'valid', output: '/tmp/untrusted' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.import'].args.parse([
        {
          source: { kind: 'url', url: 'http://insecure.example/a.zip' },
          scope: 'user',
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.import'].args.parse([
        { source: { kind: 'folder', path: '/tmp/x' }, scope: 'global' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.validate'].args.parse([{}]),
    ).toThrow()
  })

  it('invokes the fixed adapter instead of resolving a dotted property path', async () => {
    const rename = vi.fn(() => ({ id: 's1', title: 'Renamed' }))
    const api = { sessions: { rename } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'sessions.rename', ['s1', { title: 'Renamed' }]),
    ).resolves.toEqual({ id: 's1', title: 'Renamed' })
    expect(rename).toHaveBeenCalledWith('s1', { title: 'Renamed' })
  })

  it('maps schema failures to a safe operation argument error', async () => {
    const setEnabled = vi.fn()
    const api = { desktopPet: { setEnabled } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'control.get', [123]),
    ).rejects.toMatchObject({
      code: 'invalid_core_arguments',
      message: 'Invalid arguments for control.get',
    })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('FIX-14 · commands.list / complete take a session, or a draft id with its draft context', async () => {
    const list = vi.fn(async () => [])
    const complete = vi.fn(async () => [])
    const api = { commands: { list, complete } } as unknown as CoreApi
    const draftSession = {
      mode: 'build',
      project: {
        project_id: 'p',
        project_path: '/work/p',
        project_name: 'p',
      },
    }
    await invokeCoreOperation(api, 'commands.list', [
      { sessionId: 'draft:1', draftSession, invocationSource: 'desktop' },
    ])
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'draft:1', draftSession }),
    )
    await invokeCoreOperation(api, 'commands.complete', [
      {
        sessionId: 'draft:1',
        draftSession,
        commandId: 'builtin.model',
        rawArgs: '',
        cursor: 0,
        invocationSource: 'desktop',
      },
    ])
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'draft:1', draftSession }),
    )
    // Neither a session nor a draft, or a draft context on a real session:
    // the safe argument error, which the interface shows in Chinese.
    for (const input of [
      { invocationSource: 'desktop' },
      { sessionId: '  ', invocationSource: 'desktop' },
      { draftSession, invocationSource: 'desktop' },
      { sessionId: 'session-1', draftSession, invocationSource: 'desktop' },
    ])
      await expect(
        invokeCoreOperation(api, 'commands.list', [input]),
      ).rejects.toMatchObject({
        code: 'invalid_core_arguments',
        message: 'Invalid arguments for commands.list',
      })
    await expect(
      invokeCoreOperation(api, 'commands.complete', [
        {
          commandId: 'builtin.model',
          rawArgs: '',
          cursor: 0,
          invocationSource: 'desktop',
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_core_arguments' })
    expect(list).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })

  it('exposes a runtime operation-key guard without accepting arbitrary strings', () => {
    expect(isCoreOperationKey('hooks.getConfig')).toBe(false)
    expect(isCoreOperationKey('control.get')).toBe(true)
    expect(isCoreOperationKey('chat.__proto__')).toBe(false)
    expect(isCoreOperationKey('missing.operation')).toBe(false)
  })
})

const renameArgs: CoreOperationArgs<'sessions.rename'> = [
  's1',
  { title: 'Typed' },
]
expectTypeOf(renameArgs).toMatchTypeOf<
  [string, string | { title?: string | null; archived?: boolean | null }]
>()

type RenameResult = CoreOperationResult<'sessions.rename'>
expectTypeOf<Awaited<RenameResult>>().toEqualTypeOf<SessionEntry>()

type ToolResult = CoreOperationResult<'tools.readResult'>
expectTypeOf<Awaited<ToolResult>>().toEqualTypeOf<{
  content: string
  page: number
  pages: number
  bytes: number
}>()

expectTypeOf<
  ReturnType<typeof coreOperationDescriptors>[number]['key']
>().toEqualTypeOf<CoreOperationKey>()

// @ts-expect-error operation keys are a closed union
const invalidKeyArgs: CoreOperationArgs<'missing.operation'> = []
void invalidKeyArgs

// @ts-expect-error sessions.rename requires a patch argument
const invalidRenameArgs: CoreOperationArgs<'sessions.rename'> = ['s1']
void invalidRenameArgs
