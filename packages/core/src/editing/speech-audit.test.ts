import { describe, expect, it } from 'vitest'
import {
  findMissingSpeechAnchors,
  findSpeechDisfluencies,
} from './speech-audit'
import type { VideoProject } from './types'

describe('rendered take restart checks', () => {
  it.each([
    [4.4, '我们给了第，', 5.12, '我们给他定了岗位，'],
    [17.35, '那如果要招，', 18.31, '那如果要交整份的周报，'],
    [24.07, '那谁教什么？', 25.63, '那谁教了什么呢？'],
    [34.48, '在我们这个群里，', 35.28, '也就是在我们这个群里呢，'],
    [49.16, '来进行，', 50.4, '来进行专精，'],
    [53.36, '对上期的，', 54.28, '那就是对上期的升级还有补充。'],
    [56.64, '那本期视频到这里，', 57.88, '那本期视频到这里也就结束了。'],
  ] as const)('locates the failed take at %s', (start, first, next, clean) => {
    const tokens = [
      { start, end: start + 0.6, text: first },
      { start: next, end: next + 1, text: clean },
    ]
    const segments = [{ start, end: next + 1, text: first + clean }]
    expect(findSpeechDisfluencies({ segments, tokens }, 64)[0]?.remove).toEqual(
      { start, end: next },
    )
    expect(findSpeechDisfluencies({ segments }, 64)[0]?.remove).toBeUndefined()
  })
  it('keeps distinct parallel clauses and distant repetitions', () => {
    const segments = [
      '来进行专精，',
      '来进行沉淀，',
      '来进行净化。',
      '来进行净化。',
    ].map((text, i) => ({ text, start: i * 3, end: i * 3 + 1 }))
    expect(findSpeechDisfluencies({ segments }, 20)).toEqual([])
  })
  it('preserves neighboring complete sentences that develop the same thought', () => {
    const segments = ['我们做到了。', '我们做到了以前做不到的事。'].map(
      (text, i) => ({ text, start: i, end: i + 0.9 }),
    )
    expect(findSpeechDisfluencies({ segments }, 5)).toEqual([])
  })
  it('flags a restarted summary when the next sentence restates its opening and conclusion', () => {
    const segments = [
      { start: 41.72, end: 43.56, text: '那就是对上期视频的补充。' },
      { start: 43.56, end: 45.64, text: '那就是对上期的升级还有补充。' },
    ]
    expect(findSpeechDisfluencies({ segments }, 52)).toMatchObject([
      {
        code: 'speech_repeat',
        severity: 'error',
        remove: { start: 41.72, end: 43.56 },
      },
    ])
  })
  it('drops both failed attempts before the clean restart', () => {
    const segments = [
      '再把我的反馈保留到了，',
      '再把我们，',
      '再把我的反馈保留到他的记忆中去了。',
    ].map((text, i) => ({ text, start: i, end: i + 0.9 }))
    expect(
      findSpeechDisfluencies({ segments }, 5).map((x) => x.remove),
    ).toEqual([{ start: 0, end: 2 }])
  })
  it('locates an explicit correction when the speaker restarts the same sentence', () => {
    const segments = [
      '我们现在点删除，',
      '不对，说错了。',
      '我们现在点导出，',
    ].map((text, i) => ({ text, start: i, end: i + 0.8 }))
    const tokens = [
      segments[0]!,
      { start: 1, end: 1.24, text: '不对' },
      { start: 1.25, end: 1.8, text: '说错了' },
      segments[2]!,
    ]
    expect(findSpeechDisfluencies({ segments, tokens }, 5)).toMatchObject([
      {
        code: 'speech_false_start',
        severity: 'error',
        remove: { start: 0, end: 2 },
      },
    ])
  })
})

it('unions audible intervals, handles output end, speed and muted takes', () => {
  const clip = {
    assetId: 'a',
    sourceIn: 1,
    sourceOut: 2,
    timelineStart: 0,
    speed: 2,
    volume: 1,
    muted: false,
  }
  const project = {
    clips: [
      clip,
      { ...clip, timelineStart: 0.5, sourceIn: 2, sourceOut: 3 },
      { ...clip, muted: true, timelineStart: 1, sourceIn: 3, sourceOut: 4 },
    ],
  } as VideoProject
  const anchor = { assetId: 'a', start: 0.95, end: 3, text: '关键句' }
  expect(findMissingSpeechAnchors(project, [anchor], 2)).toEqual([])
  expect(findMissingSpeechAnchors(project, [anchor], 0.6)).toHaveLength(1)
  expect(
    findMissingSpeechAnchors(project, [{ ...anchor, start: 3, end: 4 }], 2)[0],
  ).toMatchObject({ code: 'speech_missing', start: 1 })
})
