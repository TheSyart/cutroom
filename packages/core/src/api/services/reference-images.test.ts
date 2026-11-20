import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { makeApi } from '../test-helpers'

it('previews ordinary chat workspace images and keeps file links previewable and revealable without a Build project', async () => {
  const f = await makeApi()
  try {
    const sessionId = String(
      f.api.sessions.create({ title: 'chat image', mode: 'chat' }).id,
    )
    const cwd = f.api.host.sessionWorkspaceRoot(sessionId)
    mkdirSync(cwd, { recursive: true })
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(cwd, 'sun.png'), bytes)
    for (const href of ['sun.png', join(cwd, 'sun.png')]) {
      const reference = f.api.references.resolve({
        sessionId,
        sourceMessageId: 'chat',
        href,
        label: 'sun',
      })
      // Chat workspace files open in Files (preview) and stay revealable.
      expect(reference).toMatchObject({
        kind: 'project_file',
        available: true,
        actions: ['open_files', 'preview', 'reveal'],
      })
      expect(
        (await f.api.references.image({ sessionId, referenceId: reference.id }))
          .dataBase64,
      ).toBe(bytes.toString('base64'))
      expect(
        f.api.references.revealPath({ sessionId, referenceId: reference.id }),
      ).toBe(realpathSync(join(cwd, 'sun.png')))
    }
  } finally {
    await f.api.close()
  }
})
