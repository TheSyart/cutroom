import { historicalChild } from './test-helpers'
import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { CoreApi } from './core-api'
import type { ReferencePreview } from '../public/api'
import {
  CORE_OPERATION_REGISTRY,
  invokeCoreOperation,
  type CoreOperationResult,
} from './operations'
import { makeApi } from './test-helpers'

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup() {
  const fixture = await makeApi()
  apis.push(fixture.api)
  return fixture
}

describe('reference preview application boundary', () => {
  it('exposes site icons only through readable, opaque session references', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Icons' }).id)
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: 'https://example.com',
      label: 'Example',
    })
    const args = CORE_OPERATION_REGISTRY['references.siteIcon'].args
    expect(() =>
      args.parse([
        {
          sessionId,
          referenceId: reference.id,
          href: 'https://forged.example',
        },
      ]),
    ).toThrow()
    expect(
      await invokeCoreOperation(api, 'references.siteIcon', [
        { sessionId, referenceId: reference.id },
      ]),
    ).toMatchObject({ state: 'unavailable', reason: 'network_unavailable' })
    expect(
      await api.references.siteIcon({ sessionId, referenceId: 'missing' }),
    ).toMatchObject({ reason: 'reference_unavailable' })
  })
  it('validates an opaque reference identity and rejects raw targets', () => {
    const registry = CORE_OPERATION_REGISTRY as unknown as Record<
      string,
      { args: { parse(input: unknown): unknown } }
    >
    expect(registry['references.preview']).toBeDefined()
    const args = registry['references.preview']!.args
    expect(args.parse([{ sessionId: 's1', referenceId: 'ref_1' }])).toEqual([
      { sessionId: 's1', referenceId: 'ref_1' },
    ])
    for (const input of [
      { sessionId: '', referenceId: 'ref_1' },
      { sessionId: 's1', referenceId: '' },
      {
        sessionId: 's1',
        referenceId: 'ref_1',
        href: 'https://forged.example/secret',
      },
      { sessionId: 's1', referenceId: 'ref_1', absolutePath: '/forged' },
    ])
      expect(() => args.parse([input])).toThrow()
    expectTypeOf<
      CoreOperationResult<'references.preview'>
    >().toEqualTypeOf<ReferencePreview>()
  })

  it('returns the same typed absence through direct and registered operations without changing transcript', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Preview' }).id)
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: 'https://example.com/guide',
      label: 'Guide',
    })
    const before = api.host.sessionLog(sessionId)?.events.slice()
    const direct = await api.references.preview({
      sessionId,
      referenceId: reference.id,
    })
    const registered = await invokeCoreOperation(api, 'references.preview', [
      { sessionId, referenceId: reference.id },
    ])
    expect(direct).toMatchObject({
      state: 'unavailable',
      reason: 'network_unavailable',
    })
    expect(registered).toMatchObject({
      state: 'unavailable',
      reason: 'network_unavailable',
    })
    expect(api.host.sessionLog(sessionId)?.events).toEqual(before)
    api.sessions.create({ title: 'Retained' })
    await api.sessions.delete(sessionId)
    expect(
      await api.references.preview({ sessionId, referenceId: reference.id }),
    ).toMatchObject({ state: 'unavailable', reason: 'reference_unavailable' })
  })
})

describe('readable child reference ownership', () => {
  it('previews child references while the lineage root is readable and refuses archived roots', async () => {
    const { api } = await makeApi({
      replies: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: {
                description: 'research',
                prompt: 'find x',
                run_in_background: false,
              },
            },
          ],
        },
        { text: 'child found x' },
        { text: 'parent done' },
      ],
    })
    apis.push(api)
    const rootId = String(api.sessions.create({ title: 'Parent' }).id)
    historicalChild(api, rootId)
    const childId = api.sessions.children({ sessionId: rootId })[0]!.subagentId
    expect(api.sessions.history({ sessionId: childId }).header.id).toBe(childId)
    const rootRef = api.references.resolve({
      sessionId: rootId,
      sourceMessageId: 'm1',
      href: 'https://example.com/root',
      label: 'Root',
    })
    const childRef = api.references.resolve({
      sessionId: childId,
      sourceMessageId: 'm2',
      href: 'https://example.com/child',
      label: 'Child',
    })
    expect(
      await api.references.preview({
        sessionId: rootId,
        referenceId: rootRef.id,
      }),
    ).toMatchObject({ reason: 'network_unavailable' })
    expect(
      await api.references.preview({
        sessionId: childId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'network_unavailable' })
    expect(
      await api.references.preview({
        sessionId: rootId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'reference_unavailable' })
    await api.sessions.rename(rootId, { archived: true })
    expect(
      await api.references.preview({
        sessionId: childId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'reference_unavailable' })
  })
})

describe('Chat attachment references', () => {
  it('resolves a stored attachment without a Build project and binds Finder access to its readable session', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    const foreignSession = String(api.sessions.create({ title: 'Other' }).id)
    const attachment = api.attachments.save({
      raw: Buffer.from('private notes'),
      name: '报告 说明.md',
      mime: 'text/markdown',
    })
    const input = {
      sessionId,
      sourceMessageId: 'm1',
      href: `attachment:${attachment.id}`,
      label: attachment.name,
    }
    const reference = api.references.resolve(input)
    expect(reference).toMatchObject({
      kind: 'external_file',
      available: true,
      label: '报告 说明.md',
      actions: ['reveal', 'preview'],
    })
    expect(
      api.references.revealPath({ sessionId, referenceId: reference.id }),
    ).toBe(realpathSync(join(api.attachmentStore.root, attachment.rel_path)))
    expect(() =>
      api.references.revealPath({
        sessionId: foreignSession,
        referenceId: reference.id,
      }),
    ).toThrow()
    expect(() =>
      api.references.resolve({ ...input, sessionId: 'unknown-session' }),
    ).toThrow()
    expect(() =>
      api.references.resolve({ ...input, href: 'attachment:att_invalid' }),
    ).toThrow()
    expect(() =>
      api.references.resolve({
        ...input,
        href: 'attachment:att_2026-10_ffffffff',
      }),
    ).toThrow()
    rmSync(join(api.attachmentStore.root, attachment.rel_path))
    expect(api.references.resolve(input)).toMatchObject({
      available: false,
      actions: [],
    })
    expect(() =>
      api.references.revealPath({ sessionId, referenceId: reference.id }),
    ).toThrow()
  })

  it('rejects stored attachment traversal and symlinks outside the attachment directory', async () => {
    const { api, root } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    const attachment = api.attachments.save({
      raw: Buffer.from('notes'),
      name: 'notes.md',
      mime: 'text/markdown',
    })
    const original = attachment.rel_path
    const input = {
      sessionId,
      sourceMessageId: 'm1',
      href: `attachment:${attachment.id}`,
      label: 'Notes',
    }
    attachment.rel_path = '../outside.md'
    expect(() => api.references.resolve(input)).toThrow()
    attachment.rel_path = original
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    rmSync(join(api.attachmentStore.root, original))
    symlinkSync(outside, join(api.attachmentStore.root, original))
    expect(() => api.references.resolve(input)).toThrow()
  })
})
