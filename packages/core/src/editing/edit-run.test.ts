import { createHmac } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as atomic from '../store/atomic-json'
import { EditRunService, type EditRunOptions } from './edit-run'
import { applyDraftCommands, unreadSourceEdits } from './draft-observation'
import { VideoProjectService } from './project-store'
import { discoverWorkspaceMedia } from './workspace-inputs'
import type { VideoProjectSession } from './types'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

const recipient = { scope: 'test-route', label: 'Test vision' }
const treatment = {
  summary: '保留演示步骤，剪掉重录',
  sections: ['演示'],
  mustKeep: ['关键操作'],
  pacing: '自然',
  picture: '展示实际录屏',
}

async function fixture(withVideo = false) {
  const root = await mkdtemp(join(tmpdir(), 'precision-edit-test-'))
  folders.push(root)
  const sessions = new Map<string, VideoProjectSession>()
  const projects = new VideoProjectService({
    stateRoot: join(root, 'private-state'),
    getSession: (id) => sessions.get(id) ?? null,
    createBuildSession: (path, title) => {
      const session = {
        id: 'session-1',
        project_path: path,
        title,
        mode: 'build',
      }
      sessions.set(session.id, session)
      return session
    },
  })
  const opened = await projects.open({ projectPath: root, initialize: true })
  const source = join(root, withVideo ? 'screen.mp4' : 'screen.png')
  await writeFile(source, 'fixture image')
  let { project } = await projects.importAssets({
    sessionId: opened.sessionId,
    sourcePaths: [source],
  })
  if (withVideo)
    ({ project } = await projects.updateAssetMetadata({
      sessionId: opened.sessionId,
      assetId: project.assets[0]!.id,
      expectedRevision: project.revision,
      duration: 2,
      width: 160,
      height: 90,
    }))
  const options: EditRunOptions = {
    projects,
    stateRoot: join(root, 'private-state'),
    recipient: () => recipient,
    ready: async () => ({ ffmpegPath: '/ffmpeg' }),
    review: async (_, { destination }) => {
      await writeFile(destination, 'test review')
      return {
        duration: 2,
        expectedDuration: 2,
        completeDecode: true,
        peakDb: null,
        issues: [],
      }
    },
    turn: async () => ({ kind: 'completed', turnId: 'test', content: '' }),
    emit: () => undefined,
  }
  return {
    options,
    projects,
    sessionId: opened.sessionId,
    project,
    service: new EditRunService(options),
  }
}

it('previews batches without saving and publishes exactly one versioned draft update per successful batch', async () => {
  const { options, projects, sessionId, project } = await fixture()
  const events: Array<{ runId: string; generation: number }> = []
  const service = new EditRunService({
    ...options,
    emitDraft: (_sessionId, runId, generation) => {
      events.push({ runId, generation })
    },
  })
  const { runId } = await service.create(sessionId, '剪掉重复')
  await service.propose(sessionId, recipient.scope, {
    summary: '保留原顺序',
    mustKeep: [],
    pacing: '保留自然停顿',
    picture: '沿用原画面',
  })
  await service.decide(sessionId, runId, 'allowed-once')
  const commands = [
    { type: 'addClip' as const, assetId: project.assets[0]!.id, duration: 2 },
  ]
  const priorEvents = events.length
  expect(
    await service.preview(sessionId, recipient.scope, commands, 0),
  ).toMatchObject({
    generation: 0,
    duration: 2,
    previousDuration: 0,
  })
  expect(
    (await service.draftSnapshot(sessionId, runId))?.project.clips,
  ).toEqual([])
  expect(events).toHaveLength(priorEvents)
  await service.stage(
    sessionId,
    recipient.scope,
    'rough_cut',
    commands,
    undefined,
    0,
  )
  const after = await new EditRunService(options).draftSnapshot(
    sessionId,
    runId,
  )
  expect(after).toMatchObject({ runId, generation: 1, change: { time: 0 } })
  expect(after?.change?.clipIds).toEqual([after?.project.clips[0]?.id])
  expect(events.slice(priorEvents)).toEqual([{ runId, generation: 1 }])
  await expect(
    service.stage(
      sessionId,
      recipient.scope,
      'fine_cut',
      commands,
      undefined,
      0,
    ),
  ).rejects.toMatchObject({ code: 'draft_generation_conflict' })
  await expect(
    service.stage(
      sessionId,
      recipient.scope,
      'fine_cut',
      [
        { type: 'updateCanvas', background: '#ff00ff' },
        { type: 'deleteClip', clipId: 'missing' },
      ],
      undefined,
      1,
    ),
  ).rejects.toThrow()
  expect(await service.draftSnapshot(sessionId, runId)).toEqual(after)
  expect((await projects.inspect(sessionId)).project).toEqual(project)
})

it('retains fixed caption styles and requires fresh rendered evidence after repairing an occlusion', async () => {
  const { options, sessionId, project } = await fixture()
  const scope = recipient.scope
  const service = new EditRunService({
    ...options,
    review: async (snapshot, input) => ({
      ...(await options.review(snapshot, input)),
      captions: { total: 1, checked: 1, targets: [0.5], issues: [] },
    }),
  })
  const { runId } = await service.create(
    sessionId,
    '白色字幕，检查是否挡住画面',
  )
  await service.propose(sessionId, scope, {
    ...treatment,
    captionPolicy: 'auto',
    fixedCaptionStyle: { color: '#ffffff' },
  })
  await service.decide(sessionId, runId, 'allowed-once')
  await service.stage(sessionId, scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
    { type: 'addSubtitle', start: 0.2, end: 0.8, text: '示例字幕' },
  ])
  await expect(
    service.preview(sessionId, scope, [
      {
        type: 'setCaptionStyle',
        style: { fontSize: 56, color: '#ff0000', position: 'top' },
      },
    ]),
  ).rejects.toMatchObject({ code: 'caption_style_locked' })
  const report = await service.review(sessionId, scope)
  await service.recordReviewFrames(sessionId, scope, report.targets)
  const delivery = {
    summary: '精剪完成',
    bookmarks: [],
    checkedTimes: report.targets,
  }
  await expect(
    service.finish(sessionId, scope, {
      ...delivery,
      captionChecks: [{ time: 0.5, result: 'clear' }],
    }),
  ).rejects.toMatchObject({ code: 'caption_frames_not_reviewed' })
  await service.recordReviewFrames(sessionId, scope, [0.5])
  await expect(
    service.finish(sessionId, scope, {
      ...delivery,
      captionChecks: [{ time: 0.5, result: 'blocked', note: '遮挡操作图标' }],
    }),
  ).rejects.toMatchObject({ code: 'caption_occlusion' })
  expect((await service.status(sessionId))?.issues).toContainEqual(
    expect.objectContaining({
      code: 'caption_occlusion',
      start: 0.5,
      message: '遮挡操作图标',
    }),
  )
  await service.stage(sessionId, scope, 'repairing', [
    {
      type: 'setCaptionStyle',
      style: { fontSize: 56, color: '#ffffff', position: 'top' },
    },
  ])
  const corrected = {
    ...delivery,
    captionChecks: [{ time: 0.5, result: 'clear' as const }],
  }
  await expect(
    service.finish(sessionId, scope, corrected),
  ).rejects.toMatchObject({ code: 'draft_not_reviewed' })
  const next = await service.review(sessionId, scope)
  await service.recordReviewFrames(sessionId, scope, [...next.targets, 0.5])
  expect(
    await service.finish(sessionId, scope, {
      ...corrected,
      checkedTimes: next.targets,
    }),
  ).toMatchObject({ state: 'delivered' })
})

it('requires continuous source and current rendered coverage, preserving pages across reopen', async () => {
  const { options, sessionId, project } = await fixture(true)
  const active = { ...options, requireVisualCoverage: true }
  const service = new EditRunService(active)
  const { runId } = await service.create(sessionId, '全片去重录')
  const assetId = project.assets[0]!.id
  const source = await service.visualTarget(sessionId, recipient.scope, {
    from: 'source',
    assetId,
  })
  await service.recordVisualCoverage(
    sessionId,
    recipient.scope,
    source,
    1,
    2,
    1,
    2,
  )
  await expect(
    service.propose(sessionId, recipient.scope, treatment),
  ).rejects.toMatchObject({
    code: 'source_visual_coverage_required',
  })
  const resumed = new EditRunService(active)
  expect(
    (await resumed.draftSnapshot(sessionId, runId))?.coverage?.source[0],
  ).toMatchObject({
    readSeconds: 1,
    unread: [{ start: 0, end: 1 }],
  })
  await resumed.recordVisualCoverage(
    sessionId,
    recipient.scope,
    source,
    0,
    1,
    0,
    2,
    { noFrames: true },
  )
  expect(
    (await resumed.draftSnapshot(sessionId, runId))?.coverage?.source[0],
  ).toMatchObject({
    readSeconds: 1,
    unread: [],
    noPicture: [{ start: 0, end: 1 }],
  })
  await resumed.propose(sessionId, recipient.scope, treatment)
  await resumed.decide(sessionId, runId, 'allowed-once')
  await resumed.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId },
  ])
  await resumed.review(sessionId, recipient.scope)
  const first = await resumed.visualTarget(sessionId, recipient.scope, {
    from: 'draft',
  })
  await resumed.recordVisualCoverage(
    sessionId,
    recipient.scope,
    first,
    0,
    2,
    0,
    2,
  )
  await resumed.stage(sessionId, recipient.scope, 'repairing', [
    { type: 'updateCanvas', background: '#ff00ff' },
  ])
  expect((await service.status(sessionId))?.previewPath).toBeUndefined()
  const { targets } = await resumed.review(sessionId, recipient.scope)
  await resumed.recordReviewFrames(sessionId, recipient.scope, targets)
  await expect(
    resumed.recordVisualCoverage(sessionId, recipient.scope, first, 0, 2, 0, 2),
  ).rejects.toMatchObject({ code: 'draft_generation_conflict' })
  const delivery = { summary: '精剪', bookmarks: [], checkedTimes: targets }
  await expect(
    resumed.finish(sessionId, recipient.scope, delivery),
  ).rejects.toMatchObject({ code: 'draft_visual_coverage_required' })
  const latest = await resumed.visualTarget(sessionId, recipient.scope, {
    from: 'draft',
  })
  await resumed.recordVisualCoverage(
    sessionId,
    recipient.scope,
    latest,
    0,
    2,
    0,
    2,
  )
  expect(
    await resumed.finish(sessionId, recipient.scope, delivery),
  ).toMatchObject({ state: 'delivered' })
})

it('reports subtitle re-timing in final coordinates after several linked cuts', async () => {
  const { project } = await fixture()
  const source = applyDraftCommands(project, [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 8 },
    { type: 'addSubtitle', start: 4, end: 6, text: '跨剪口的原声' },
  ]).project
  const result = applyDraftCommands(source, [
    { type: 'rippleDeleteRange', start: 4.5, end: 5.5 },
    { type: 'rippleDeleteRange', start: 1, end: 2 },
  ])
  expect(result.retimeSubtitles).toEqual([{ start: 3, end: 4 }])
  expect(result.project.subtitles).toEqual([])
})

it('requests the exact unviewed source removed by a scoped repair', async () => {
  const { project } = await fixture(true)
  const assetId = project.assets[0]!.id
  const before = applyDraftCommands(project, [
    { type: 'addClip', assetId },
  ]).project
  const after = applyDraftCommands(before, [
    {
      type: 'replaceClipRanges',
      clipId: before.clips[0]!.id,
      ranges: [
        { sourceIn: 0, sourceOut: 0.5 },
        { sourceIn: 1, sourceOut: 2 },
      ],
    },
  ]).project
  expect(
    unreadSourceEdits(before, after, {
      local: true,
      source: {
        [assetId]: {
          duration: 2,
          ranges: [{ start: 0, end: 0.25 }],
          scope: [{ start: 0, end: 0.25 }],
        },
      },
    }),
  ).toEqual([{ assetId, name: 'screen.mp4', start: 0.5, end: 1 }])
})

it('requires one treatment approval and commits a reviewed batch as one undo step', async () => {
  const { projects, sessionId, project, service, options } = await fixture()
  await service.create(sessionId, '自然剪辑')
  const commands = [
    { type: 'addClip' as const, assetId: project.assets[0]!.id, duration: 2 },
  ]
  await expect(
    service.stage(sessionId, recipient.scope, 'fine_cut', commands),
  ).rejects.toMatchObject({ code: 'treatment_not_approved' })
  const proposal = await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, proposal.runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', commands)
  await expect(
    service.finish(sessionId, recipient.scope, {
      summary: '演示',
      bookmarks: [],
      checkedTimes: [0.5],
    }),
  ).rejects.toMatchObject({ code: 'draft_not_reviewed' })
  expect((await projects.inspect(sessionId)).project).toEqual(project)
  const { targets } = await service.review(sessionId, recipient.scope)
  await service.recordReviewFrames(sessionId, recipient.scope, targets)
  const result = await service.finish(sessionId, recipient.scope, {
    summary: '演示',
    bookmarks: [],
    checkedTimes: targets,
  })
  expect(result).toMatchObject({
    state: 'delivered',
    revision: project.revision + 1,
    canRestore: true,
  })
  expect((await projects.inspect(sessionId)).project.clips).toHaveLength(1)
  const reopened = new EditRunService(options)
  await reopened.restore(sessionId)
  expect((await projects.inspect(sessionId)).project.clips).toEqual([])
})

it('blocks delivery when the rendered voice repeats, then accepts a new checked draft without another approval', async () => {
  const { options, projects, sessionId, project } = await fixture()
  let audits = 0
  const service = new EditRunService({
    ...options,
    ready: async () => ({
      ffmpegPath: '/ffmpeg',
      transcriptionProvider: 'fun-asr',
    }),
    reviewSpeech: async ({ provider, relativePath }) => {
      expect(relativePath).toMatch(/review-[12]\.mp4$/)
      audits++
      return {
        status: 'checked',
        provider,
        sentenceCount: 1,
        wordCount: audits === 1 ? 8 : 4,
        issues:
          audits === 1
            ? [
                {
                  code: 'speech_repeat',
                  severity: 'error',
                  start: 0.2,
                  end: 0.9,
                  message: '两次起句',
                  remove: { start: 0.2, end: 0.5 },
                },
              ]
            : [],
      }
    },
  })
  const proposal = await service.create(sessionId, '清理真实原声')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, proposal.runId, 'allowed-once')
  expect(await service.source(sessionId, recipient.scope)).toMatchObject({
    transcriptionProvider: 'fun-asr',
  })
  await service.stage(sessionId, recipient.scope, 'fine_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  const rejected = await service.review(sessionId, recipient.scope)
  expect(rejected.issues[0]).toMatchObject({
    code: 'speech_repeat',
    remove: { start: 0.2, end: 0.5 },
  })
  await service.recordReviewFrames(sessionId, recipient.scope, rejected.targets)
  await expect(
    service.finish(sessionId, recipient.scope, {
      summary: '精剪',
      bookmarks: [],
      checkedTimes: rejected.targets,
    }),
  ).rejects.toMatchObject({ code: 'draft_review_failed' })
  expect((await projects.inspect(sessionId)).project).toEqual(project)
  await service.stage(sessionId, recipient.scope, 'repairing', [
    { type: 'updateCanvas', background: '#123456' },
  ])
  const accepted = await service.review(sessionId, recipient.scope)
  expect(accepted.audio).toMatchObject({
    provider: 'fun-asr',
    status: 'checked',
  })
  await service.recordReviewFrames(sessionId, recipient.scope, accepted.targets)
  expect(
    await service.finish(sessionId, recipient.scope, {
      summary: '精剪',
      bookmarks: [],
      checkedTimes: accepted.targets,
    }),
  ).toMatchObject({ state: 'delivered' })
  expect(audits).toBe(2)
})

it('preserves simultaneous manual changes and offers the reviewed draft for adoption', async () => {
  const { projects, sessionId, project, service } = await fixture()
  await service.create(sessionId, '精剪')
  const proposal = await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, proposal.runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  const { targets } = await service.review(sessionId, recipient.scope)
  await service.recordReviewFrames(sessionId, recipient.scope, targets)
  const changed = await projects.mutate({
    sessionId,
    expectedRevision: project.revision,
    command: { type: 'updateCanvas', background: '#aaaaaa' },
  })
  const result = await service.finish(sessionId, recipient.scope, {
    summary: '独立版本',
    bookmarks: [],
    checkedTimes: targets,
  })
  expect(result).toMatchObject({
    state: 'conflict',
    canAdopt: true,
    previewPath: expect.stringMatching(/\.mp4$/),
  })
  expect((await projects.inspect(sessionId)).project).toEqual(changed.project)
  await service.adopt(sessionId)
  await service.restore(sessionId)
  expect((await projects.inspect(sessionId)).project.canvas.background).toBe(
    '#aaaaaa',
  )
})

it('allows revision of a declined treatment before any write approval', async () => {
  const { projects, sessionId, project, service } = await fixture()
  const briefPath = join(
    (await projects.inspect(sessionId)).projectPath,
    'editing-brief.md',
  )
  const started = await service.create(sessionId, '保留演示步骤')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, started.runId, 'rejected')
  await expect(readFile(briefPath, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(
    service.propose(sessionId, recipient.scope, treatment),
  ).rejects.toMatchObject({ code: 'edit_run_wrong_stage' })
  expect(
    await service.create(sessionId, '加入一个安装前提', 'revise_treatment'),
  ).toMatchObject({ runId: started.runId, state: 'analyzing' })
  const revised = { ...treatment, mustKeep: ['安装前提', '关键操作'] }
  await service.propose(sessionId, recipient.scope, revised)
  await service.decide(sessionId, started.runId, 'allowed-once')
  expect(await service.status(sessionId)).toMatchObject({
    state: 'rough_cut',
    treatment: revised,
  })
  expect(await readFile(briefPath, 'utf8')).toContain('安装前提')
  await expect(
    service.source(sessionId, recipient.scope),
  ).resolves.toMatchObject({
    editingBrief: {
      revision: 1,
      markdown: expect.stringContaining('安装前提'),
    },
  })
  expect((await projects.inspect(sessionId)).project).toEqual(project)
})

it('requires observed project sources and keeps user corrections with their provenance on reopen', async () => {
  const { options, sessionId, project } = await fixture()
  const service = new EditRunService({ ...options, inventory: async () => [] })
  const { runId } = await service.create(sessionId, '这是安装界面')
  const assetId = project.assets[0]!.id
  const scope = recipient.scope
  await expect(
    service.propose(sessionId, scope, treatment),
  ).rejects.toMatchObject({
    code: 'source_notes_required',
  })
  const note = {
    assetId,
    start: 0,
    end: 0,
    provenance: 'observed' as const,
    observation: '画面中存在一个系统弹窗。',
  }
  await expect(
    service.saveSourceNotes(sessionId, scope, [
      {
        ...note,
        evidence: [{ id: 'invented', kind: 'frame' }],
      },
    ]),
  ).rejects.toMatchObject({ code: 'source_note_evidence_required' })
  const evidence = await service.recordSourceEvidence(
    sessionId,
    scope,
    runId,
    assetId,
    [{ kind: 'frame', start: 0, end: 0 }],
  )
  await service.saveSourceNotes(sessionId, scope, [{ ...note, evidence }])
  await service.propose(sessionId, scope, treatment)
  await service.decide(sessionId, runId, 'rejected')
  await service.create(sessionId, '弹窗是在检查权限', 'revise_treatment')
  await service.saveSourceNotes(sessionId, scope, [
    {
      assetId,
      start: 0,
      end: 0,
      provenance: 'user-provided',
      userQuote: '弹窗是在检查权限',
      observation: '此处为权限检查界面。',
    },
  ])
  await expect(
    new EditRunService(options).readSourceNotes(sessionId, scope, {
      assetId,
      provenance: 'user-provided',
    }),
  ).resolves.toMatchObject({
    notes: [
      { observation: '此处为权限检查界面。', userQuote: '弹窗是在检查权限' },
    ],
  })
})

it('reloads the project brief, and updates only confirmed durable guidance', async () => {
  const { options, projects, sessionId, service } = await fixture()
  const scope = recipient.scope
  const path = join(
    (await projects.inspect(sessionId)).projectPath,
    'editing-brief.md',
  )
  const first = await service.create(sessionId, '开始制作')
  await service.propose(sessionId, scope, treatment)
  await service.decide(sessionId, first.runId, 'allowed-once')
  const saved = await readFile(path, 'utf8')
  await service.action(sessionId, 'cancel')
  const restarted = new EditRunService(options)
  const temporary = await restarted.create(sessionId, '这次加快一点')
  await expect(restarted.source(sessionId, scope)).resolves.toMatchObject({
    editingBrief: {
      revision: 1,
      markdown: expect.stringContaining(treatment.pacing),
    },
  })
  await restarted.propose(sessionId, scope, {
    ...treatment,
    pacing: '这次加快一点',
  })
  await restarted.decide(sessionId, temporary.runId, 'allowed-once')
  expect(await readFile(path, 'utf8')).toBe(saved)
  await restarted.action(sessionId, 'cancel')
  const update = await restarted.create(
    sessionId,
    '以后都保留操作结果出现后的停顿',
  )
  const proposed = await restarted.propose(sessionId, scope, {
    ...treatment,
    projectBrief: {
      goal: '完整展示操作',
      mustKeep: ['操作结果'],
      cutRules: '剪掉重录，保留完整操作',
      pacing: '保留操作结果出现后的停顿',
      picture: '展示实际录屏',
      audio: '保留原声',
      captions: '沿用工程样式',
    },
  })
  expect(proposed.editingBriefChange).toMatchObject({ revision: 2 })
  expect(await readFile(path, 'utf8')).toBe(saved)
  await restarted.decide(sessionId, update.runId, 'allowed-once')
  expect(await readFile(path, 'utf8')).toContain('保留操作结果出现后的停顿')
})

it('selects an already imported source by path and blocks expanding the approved source scope', async () => {
  const { options, projects, sessionId, project } = await fixture()
  const scope = recipient.scope
  const root = (await projects.inspect(sessionId)).projectPath
  const another = join(root, 'b.png')
  await writeFile(another, 'second source')
  const { project: withBoth } = await projects.importAssets({
    sessionId,
    sourcePaths: [another],
  })
  const source = project.assets[0]!
  const other = withBoth.assets.find(({ id }) => id !== source.id)!
  const service = new EditRunService({
    ...options,
    inventory: discoverWorkspaceMedia,
  })
  const { runId } = await service.create(sessionId, `使用素材：${source.path}`)
  expect((await service.source(sessionId, scope)).sourceAssetIds).toEqual([
    source.id,
  ])
  const evidence = await service.recordSourceEvidence(
    sessionId,
    scope,
    runId,
    source.id,
    [{ kind: 'frame', start: 0, end: 0 }],
  )
  await service.saveSourceNotes(sessionId, scope, [
    {
      assetId: source.id,
      start: 0,
      end: 0,
      provenance: 'observed',
      observation: '选定的静态素材。',
      evidence,
    },
  ])
  await service.propose(sessionId, scope, treatment)
  await service.decide(sessionId, runId, 'allowed-once')
  const command = { type: 'addClip' as const, assetId: other.id, duration: 2 }
  await expect(
    service.preview(sessionId, scope, [command], 0),
  ).rejects.toMatchObject({ code: 'source_outside_edit_scope' })
  await expect(
    service.stage(sessionId, scope, 'rough_cut', [command], undefined, 0),
  ).rejects.toMatchObject({ code: 'source_outside_edit_scope' })
})

it('recovers an authorized brief after interruption before final run state is written', async () => {
  const { options, projects, sessionId, service } = await fixture()
  const scope = recipient.scope
  const projectPath = (await projects.inspect(sessionId)).projectPath
  const { runId } = await service.create(sessionId, '开始制作')
  await service.propose(sessionId, scope, treatment)
  const save = atomic.writeJsonAtomic
  const intercepted = vi
    .spyOn(atomic, 'writeJsonAtomic')
    .mockImplementation(async (path, value, settings) => {
      if (
        path.endsWith('/run.json') &&
        (value as { body: string }).body.includes('"state":"rough_cut"')
      )
        throw new Error('interrupted after a confirmed brief was written')
      await save(path, value, settings)
    })
  try {
    await expect(
      service.decide(sessionId, runId, 'allowed-once'),
    ).rejects.toThrow('interrupted')
    expect(
      await readFile(join(projectPath, 'editing-brief.md'), 'utf8'),
    ).toContain(treatment.summary)
  } finally {
    intercepted.mockRestore()
  }
  const reopened = new EditRunService(options)
  await expect(reopened.status(sessionId)).resolves.toMatchObject({
    runId,
    editingBriefRevision: 1,
    state: 'rough_cut',
  })
})

it('rerenders a removed review artifact and requires reviewing new frames before delivery', async () => {
  const { projects, sessionId, project, service } = await fixture()
  const started = await service.create(sessionId, '复检草稿')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, started.runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  const first = await service.review(sessionId, recipient.scope)
  await service.recordReviewFrames(sessionId, recipient.scope, first.targets)
  const { path } = await service.reviewedPath(sessionId, recipient.scope)
  await rm(path)
  const delivery = {
    summary: '草稿',
    bookmarks: [],
    checkedTimes: first.targets,
  }
  await expect(
    service.finish(sessionId, recipient.scope, delivery),
  ).rejects.toMatchObject({ code: 'draft_not_reviewed' })
  expect((await projects.inspect(sessionId)).project).toEqual(project)
  expect(await service.review(sessionId, recipient.scope)).toMatchObject({
    attempts: first.attempts,
    checkedFrames: [],
  })
  expect(await readFile(path, 'utf8')).toBe('test review')
  await expect(
    service.finish(sessionId, recipient.scope, delivery),
  ).rejects.toMatchObject({ code: 'draft_frames_not_reviewed' })
})

it('preserves an old job from another installation without recovering its authorization', async () => {
  const { sessionId, service, options } = await fixture()
  const original = await service.create(sessionId, '以前的任务')
  const { projectPath } = await options.projects.inspect(sessionId)
  const oldRecord = join(
    projectPath,
    '.cutroom',
    'precision',
    original.runId,
    'run.json',
  )
  const priorBytes = await readFile(oldRecord)
  const foreign = new EditRunService({
    ...options,
    stateRoot: join(projectPath, 'different-install'),
  })
  await expect(foreign.status(sessionId)).rejects.toMatchObject({
    code: 'edit_run_invalid',
  })
  expect(await foreign.motionTarget(sessionId, recipient.scope)).toBeNull()
  const write = vi.fn(async () => 'live')
  await expect(foreign.withLiveMotionTarget(sessionId, write)).resolves.toBe(
    'live',
  )
  await expect(
    foreign.motionTarget(sessionId, recipient.scope, true),
  ).rejects.toMatchObject({ code: 'edit_run_invalid' })
  await expect(
    foreign.draftSnapshot(sessionId, original.runId),
  ).rejects.toMatchObject({ code: 'edit_run_invalid' })
  const restarted = await foreign.create(sessionId, '新任务')
  await expect(
    foreign.withLiveMotionTarget(sessionId, write),
  ).rejects.toMatchObject({ code: 'motion_target_changed' })
  expect(write).toHaveBeenCalledTimes(1)
  expect(await readFile(oldRecord)).toEqual(priorBytes)
  expect(restarted.runId).not.toBe(original.runId)
  expect(await readFile(oldRecord, 'utf8')).toContain(original.runId)
  await expect(
    foreign.action(sessionId, 'cancel', original.runId),
  ).rejects.toMatchObject({ code: 'edit_run_wrong_stage' })
})

it('automatically resumes an approved, unfinished run from disk without another treatment', async () => {
  const { options, projects, sessionId, project, service } = await fixture()
  const initial = await service.create(sessionId, '续跑检查')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, initial.runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  let onCommit!: (revision: number) => void
  const committed = new Promise<number>((resolve) => {
    onCommit = resolve
  })
  const reopened = new EditRunService({
    ...options,
    turn: async (_id, prompt) => {
      expect(prompt).toContain('state=rough_cut; approved=true; generation=1')
      const { targets } = await reopened.review(sessionId, recipient.scope)
      await reopened.recordReviewFrames(sessionId, recipient.scope, targets)
      await reopened.finish(sessionId, recipient.scope, {
        summary: '完成续跑',
        bookmarks: [],
        checkedTimes: targets,
      })
      return { kind: 'completed', turnId: 'resumed', content: '' }
    },
    emit: (snapshot) => onCommit(snapshot.project.revision),
  })
  expect(await reopened.status(sessionId)).toMatchObject({
    runId: initial.runId,
    state: 'rough_cut',
  })
  expect(await committed).toBe(project.revision + 1)
  expect(await reopened.status(sessionId)).toMatchObject({
    state: 'delivered',
    runId: initial.runId,
  })
  expect((await projects.inspect(sessionId)).project.clips).toHaveLength(1)
})

it('reopens a signed review in a copied project and rejects changed source or review bytes', async () => {
  const { projects, sessionId, project, service, options } = await fixture()
  const { runId } = await service.create(sessionId, '复检已确认的素材')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  await service.review(sessionId, recipient.scope)
  const original = await service.reviewedPath(sessionId, recipient.scope)
  const copy = await mkdtemp(join(tmpdir(), 'precision-edit-copy-'))
  folders.push(copy)
  await cp(original.projectPath, copy, { recursive: true })
  await projects.open({ projectPath: copy })
  const reopened = new EditRunService(options)
  const moved = await reopened.reviewedPath(sessionId, recipient.scope)
  expect((await lstat(moved.path)).ino).not.toBe(
    (await lstat(original.path)).ino,
  )
  expect(moved.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  const signed = await readFile(
    join(original.projectPath, '.cutroom/precision', runId, 'run.json'),
  )
  expect(
    await readFile(join(copy, '.cutroom/precision', runId, 'run.json')),
  ).toEqual(signed)
  expect((await reopened.source(sessionId, recipient.scope)).runId).toBe(runId)
  await writeFile(moved.path, 'fake review')
  await expect(
    reopened.reviewedPath(sessionId, recipient.scope),
  ).rejects.toMatchObject({ code: 'draft_not_reviewed' })
  await writeFile(join(copy, project.assets[0]!.path), 'changed media')
  await expect(
    reopened.source(sessionId, recipient.scope),
  ).rejects.toMatchObject({ code: 'draft_asset_changed' })
})

it('migrates an approved legacy run and its reviewed frames without changing the signed record or its authorization', async () => {
  const { projects, sessionId, project, service, options } = await fixture()
  const { runId } = await service.create(sessionId, '继续已批准的剪辑')
  await service.propose(sessionId, recipient.scope, treatment)
  await service.decide(sessionId, runId, 'allowed-once')
  await service.stage(sessionId, recipient.scope, 'rough_cut', [
    { type: 'addClip', assetId: project.assets[0]!.id, duration: 2 },
  ])
  const reviewed = await service.review(sessionId, recipient.scope)
  await service.recordReviewFrames(sessionId, recipient.scope, reviewed.targets)
  const { projectPath } = await projects.inspect(sessionId)
  const old = join(projectPath, '.video-edit-agent')
  await rename(join(projectPath, '.cutroom'), old)
  const runDir = join(old, 'precision', runId)
  const file = join(runDir, 'run.json')
  const record = JSON.parse(await readFile(file, 'utf8'))
  const run = JSON.parse(record.body)
  const relative =
    '.video-edit-agent/precision/' +
    runId +
    '/review-' +
    run.generation +
    '.mp4'
  const info = await lstat(join(projectPath, relative), { bigint: true })
  run.review.fingerprint = JSON.stringify([
    relative,
    String(info.size),
    String(info.mtimeNs),
    String(info.ino),
  ])
  const key = Buffer.from(
    await readFile(join(options.stateRoot, 'precision-run.key'), 'utf8'),
    'hex',
  )
  const body = JSON.stringify(run)
  const bytes = JSON.stringify({
    body,
    signature: createHmac('sha256', key).update(body).digest('hex'),
  })
  await writeFile(file, bytes)
  await mkdir(join(projectPath, '.emperor/skills/cut'), { recursive: true })
  await writeFile(
    join(projectPath, '.emperor/skills/cut/SKILL.md'),
    'project skill',
  )
  await mkdir(join(old, 'preview-cache'))
  await writeFile(join(old, 'preview-cache/poster'), 'disposable')
  const foreign = 'precision/55555555-5555-4555-8555-555555555555'
  const foreignRecord = JSON.stringify({
    body,
    signature: 'from-another-profile',
  })
  await mkdir(join(old, foreign))
  await writeFile(join(old, foreign, 'run.json'), foreignRecord)
  const opened = await projects.open({ projectPath })
  expect(opened.readOnlyReason).toBeUndefined()
  expect(opened.editRunRecovery).toContain('1 条历史精剪记录')
  expect(await readFile(join(old, foreign, 'run.json'), 'utf8')).toBe(
    foreignRecord,
  )
  expect(
    await readFile(join(projectPath, '.cutroom', foreign, 'run.json'), 'utf8'),
  ).toBe(foreignRecord)
  expect(opened.sessionId).toBe(sessionId)
  expect(opened.project).toEqual(project)
  expect(
    await readFile(join(projectPath, '.cutroom/skills/cut/SKILL.md'), 'utf8'),
  ).toBe('project skill')
  expect(await readFile(file, 'utf8')).toBe(bytes)
  expect(
    await readFile(
      join(projectPath, '.cutroom/precision', runId, 'run.json'),
      'utf8',
    ),
  ).toBe(bytes)
  await expect(
    lstat(join(projectPath, '.cutroom/preview-cache')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  const restored = new EditRunService(options)
  const media = await restored.reviewedPath(sessionId, recipient.scope)
  expect(media.relativePath).toBe(
    relative.replace('.video-edit-agent', '.cutroom'),
  )
  const contents = await readFile(media.path)
  await writeFile(media.path, 'changed review')
  await expect(
    restored.reviewedPath(sessionId, recipient.scope),
  ).rejects.toMatchObject({ code: 'draft_not_reviewed' })
  await writeFile(media.path, contents)
  expect(
    await restored.finish(sessionId, recipient.scope, {
      summary: '原审片',
      bookmarks: [],
      checkedTimes: reviewed.targets,
    }),
  ).toMatchObject({ state: 'delivered' })
  expect(await readFile(file, 'utf8')).toBe(bytes)
})
