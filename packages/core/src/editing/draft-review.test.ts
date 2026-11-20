import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readDraftFrames, reviewEditDraft } from './draft-review'
import { VideoAnalysisService } from './analysis/service'
import type { VideoAsset, VideoProjectResult } from './types'

const available = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version']).status === 0,
)

it.skipIf(!available)(
  'checks the decoded draft and maps source evidence through trim and speed',
  async () => {
    const projectPath = await realpath(
      await mkdtemp(join(tmpdir(), 'edit-review-')),
    )
    try {
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=96x54:r=30:d=2,drawbox=x=0:y=0:w=96:h=54:c=white:t=fill:enable=gte(t\\,0.8)',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(lt(t\\,0.8)\\,0\\,sin(880*PI*t)):s=48000:d=2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        join(projectPath, 'screen.mp4'),
      ])
      const asset: VideoAsset = {
        id: 'source',
        kind: 'video',
        displayName: 'screen',
        path: 'screen.mp4',
        duration: 2,
        width: 96,
        height: 54,
      }
      const snapshot: VideoProjectResult = {
        sessionId: 'editing',
        projectPath,
        canUndo: false,
        canRedo: false,
        project: {
          schemaVersion: 2,
          name: 'test',
          projectId: 'project',
          revision: 1,
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
          assets: [asset],
          tracks: [{ id: 'main', index: 0, name: 'main', kind: 'video' }],
          clips: [
            {
              id: 'clip',
              trackId: 'main',
              assetId: asset.id,
              timelineStart: 0.25,
              sourceIn: 0.2,
              sourceOut: 2,
              speed: 2,
              volume: 1,
              muted: false,
              transform: { scale: 1, x: 0, y: 0 },
            },
          ],
          subtitles: [],
          canvas: { fit: 'contain', background: '#000000' },
        },
      }
      const evidence = await new VideoAnalysisService({
        stateRoot: projectPath,
      }).inspectEvidence(snapshot, asset)
      expect(evidence.audio).toBe('present')
      expect(evidence.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'pause',
            start: 0,
            timeline: [
              expect.objectContaining({ clipId: 'clip', start: 0.25 }),
            ],
          }),
          expect.objectContaining({
            kind: 'screen-change',
            start: expect.any(Number),
            score: expect.any(Number),
          }),
          expect.objectContaining({
            kind: 'energy',
            rmsDb: expect.any(Number),
            peakDb: expect.any(Number),
          }),
        ]),
      )
      const destination = join(projectPath, 'draft.mp4')
      const review = await reviewEditDraft(snapshot, {
        destination,
        ffmpegPath: 'ffmpeg',
      })

      expect(review.duration).toBeCloseTo(1.15, 1)
      expect(review.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'black',
            start: 0,
            end: expect.any(Number),
          }),
          expect.objectContaining({
            code: 'silence',
            start: 0,
            end: expect.any(Number),
          }),
          expect.objectContaining({
            code: 'audio_peak',
            start: expect.any(Number),
            end: expect.any(Number),
          }),
        ]),
      )
      const frames = await readDraftFrames(destination, 'ffmpeg', [0, 0.8, 5])
      expect(frames.map((frame) => frame.time)).toEqual([0, 0.8])
      expect(
        frames.every(
          (frame) => frame.bytes[0] === 0xff && frame.bytes[1] === 0xd8,
        ),
      ).toBe(true)
      const cues = [
        { id: 'caption', start: 0.7, end: 1.1, text: 'Read the actual render' },
      ]
      snapshot.project.subtitles = cues
      snapshot.project.captionStyle = {
        fontSize: 36,
        color: '#ffffff',
        position: 'bottom',
        outlineWidth: 0,
      }
      const unreadable = await reviewEditDraft(snapshot, {
        destination: join(projectPath, 'unreadable.mp4'),
        ffmpegPath: 'ffmpeg',
        inspectCaptions: true,
      })
      expect(unreadable.captions).toMatchObject({ checked: 1, total: 1 })
      expect(unreadable.captions?.issues.map(({ code }) => code)).toEqual([
        'caption_small',
        'caption_contrast',
      ])
      snapshot.project.captionStyle = {
        ...snapshot.project.captionStyle,
        fontSize: 56,
        backgroundColor: '#000000',
        backgroundOpacity: 0.85,
        outlineColor: '#191919',
        outlineWidth: 3,
      }
      const repaired = await reviewEditDraft(snapshot, {
        destination: join(projectPath, 'repaired.mp4'),
        ffmpegPath: 'ffmpeg',
        inspectCaptions: true,
      })
      expect(repaired.captions).toMatchObject({
        checked: 1,
        total: 1,
        issues: [],
      })
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  },
  30_000,
)
