import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Page } from 'playwright-core'
import type { VideoProject } from '@emperor/core/editing'

/** Compare the composited program monitor (including the media underneath)
 * with the same decoded MP4 frame. Downsampling tolerates native DPR and H.264.
 */
export async function verifyPreviewExport(
  page: Page,
  movie: string,
  project: string,
  frames: number[],
): Promise<void> {
  const timeline = JSON.parse(
    readFileSync(join(project, 'timeline.json'), 'utf8'),
  ) as VideoProject
  const evidence = join(dirname(project), 'frames-' + basename(project))
  mkdirSync(evidence, { recursive: true })
  if (process.env.CUTROOM_MOTION_SPEECH && timeline.clips.length)
    verifySpokenAudio(process.env.CUTROOM_MOTION_SPEECH, movie, evidence)
  const comparisons = []
  for (const frame of frames) {
    // The slider uses centiseconds. Round up to the first centisecond inside the frame.
    const time = Math.ceil((frame * 100) / 30) / 100
    const scene = timeline.motionScenes?.find(
      (s) => s.startFrame <= frame && frame < s.startFrame + s.durationFrames,
    )
    await page.locator('.playback-scrubber').evaluate((el, at) => {
      ;(el as HTMLInputElement).value = String(at)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, time)
    const monitor = page.locator('.monitor-canvas')
    if (scene) {
      // All comparison fixtures have their original play rate and phase.
      const local = scene.sourceInFrame + frame - scene.startFrame
      await monitor
        .locator(
          `[data-testid="motion-preview"] img[data-motion-frame="${local}"]`,
        )
        .waitFor()
    } else
      await monitor.getByTestId('motion-preview').waitFor({ state: 'detached' })
    if (timeline.clips.length) {
      await page.waitForFunction((at) => {
        const video = document.querySelector<HTMLVideoElement>(
          '[data-preview-active="true"] video',
        )
        return (
          video &&
          video.readyState >= 2 &&
          !video.seeking &&
          Math.abs(video.currentTime - at) < 0.045
        )
      }, time)
    }
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    )
    const preview = join(evidence, `${frame}-preview.png`)
    const exported = join(evidence, `${frame}-export.png`)
    await monitor.screenshot({ path: preview, scale: 'css' })
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      movie,
      '-vf',
      `select=eq(n\\,${frame})`,
      '-frames:v',
      '1',
      exported,
    ])
    const rgb = (file: string) =>
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        'scale=160:90:flags=area',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ])
    const a = rgb(preview)
    const b = rgb(exported)
    assert.equal(a.length, 160 * 90 * 3)
    assert.equal(a.length, b.length)
    // Exclude the monitor's 1px editor chrome.
    let errors = 0
    let highError = 0
    let count = 0
    for (let y = 1; y < 89; y++) {
      for (let x = 1; x < 159; x++) {
        for (let channel = 0; channel < 3; channel++) {
          const at = (y * 160 + x) * 3 + channel
          const delta = Math.abs(a[at]! - b[at]!)
          errors += delta
          if (delta > 40) highError++
          count++
        }
      }
    }
    const meanAbsoluteError = errors / count
    const highErrorFraction = highError / count
    comparisons.push({ frame, meanAbsoluteError, highErrorFraction })
    writeFileSync(
      join(evidence, 'comparison.json'),
      JSON.stringify(comparisons, null, 2),
    )
    assert.ok(
      meanAbsoluteError < 8 && highErrorFraction < 0.06,
      `Frame ${frame} differs between monitor and MP4: MAE ${meanAbsoluteError}, high-error fraction ${highErrorFraction}. See ${evidence}`,
    )
  }
}

/** Compare the same speech samples across the real source and encoded AAC.
 * A time shift in the voice should fail even if the audio stream still decodes.
 */
function verifySpokenAudio(source: string, movie: string, evidence: string) {
  const pcm = (file: string) =>
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      'pipe:1',
    ])
  const original = pcm(source),
    exported = pcm(movie)
  const samples = Math.min(original.length, exported.length) / 4
  let energyOriginal = 0,
    energyExport = 0,
    cross = 0
  for (let i = 0; i < samples; i++) {
    const a = original.readFloatLE(i * 4),
      b = exported.readFloatLE(i * 4)
    energyOriginal += a * a
    energyExport += b * b
    cross += a * b
  }
  const zeroLagCorrelation = cross / Math.sqrt(energyOriginal * energyExport)
  writeFileSync(
    join(evidence, 'audio-comparison.json'),
    JSON.stringify({ sampleRate: 16000, samples, zeroLagCorrelation }, null, 2),
  )
  assert.ok(
    zeroLagCorrelation > 0.97,
    'Source and export speech differ at the same sample positions: ' +
      zeroLagCorrelation,
  )
}
