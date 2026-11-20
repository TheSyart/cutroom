import { dirname, join } from 'node:path'
import { EmperorError } from '../errors'
import type { HarnessHost } from '../harness/host/host'
import { findExecutable } from './analysis/paths'
import type { VideoAnalysisService } from './analysis/service'
import { reviewEditDraft, type DraftReviewIssue } from './draft-review'
import { EditRunService } from './edit-run'
import { createPrecisionTools } from './precision-tools'
import type { VideoProjectService } from './project-store'
import {
  findMissingSpeechAnchors,
  findSpeechDisfluencies,
} from './speech-audit'
import { timelineLayout } from './timeline'
import { discoverWorkspaceMedia } from './workspace-inputs'

const PRECISION_EDITING_PROMPT = [
  'Work as an editor: inventory with video_analyze_workspace; watch every task source in chronological pages with video_read_video, following nextStart until null. Note what changes in the picture, where an action starts or finishes, and where it matches the speech. Inspect candidate cuts at 4 or 8 fps and use individual detailed frames for fine visual judgment. For scoped revisions read the target source interval with surrounding context.',
  'Reuse current video_read_source_notes. As you watch, save specific observed scenes, actions, raw speech and compared takes with video_record_source_notes and the returned sourceEvidence IDs. Log user corrections as user-provided with their exact words. Inspect still images at 0 and independent audio with video_analyze_workspace. Inventory identifies renders and unresolved files. If the user wants an unregistered original, ask them to start the task with a line 使用素材：relative/path. Do not treat exports as new originals.',
  'Apply the confirmed editingBrief supplied by video_analyze_workspace to the task. For the first brief, or an explicit request to change lasting project rules, propose projectBrief with goal, mustKeep, cutRules, pacing, picture, audio and captions. Keep temporary requests in the normal treatment. Summarize concrete observations and important uncertainty in the single treatment confirmation.',
  'Default to the existing delivery order and preserve complete takes, meaningful pauses, and required actions. Compare alternative takes using raw timed words and observed movement. Propose the editing scope, keep/remove criteria, pacing and picture handling once with video_propose_treatment when approval is needed. Content sections are optional. Use speechAnchors for important speech: one short continuous clean phrase per measured interval. Split neighboring phrases into separate anchors when a pause, restart, or alternate take lies between them. A change in whole-film direction requires a new treatment.',
  'After approval, trial candidate operations using video_preview_edit, then submit versioned video_stage_edit batches for rough and fine cuts. Carry the returned generation and real IDs forward. Use rippleDeleteRange when multiple tracks must move together. Keep complete words and picture continuity; sync audio and add short fades where useful. Edit subtitles on a separate layer after the audible cut and retime caption ranges reported by a ripple edit.',
  'Run video_review_draft. When it flags a sound error, repair the actual timeline audio and update captions before rendering again. Check all reported picture targets with video_read_evidence and watch the final rendered timeline continuously with video_read_video. Then call video_finish_draft with checked times and useful bookmarks. Continue repairs on the approved scope without more approvals. Leave user MP4 export to the editor.',
].join('\n')

export function installPrecisionEditing({
  host,
  projects,
  analysis,
  stateRoot,
  renderMotionFrame,
}: {
  host: HarnessHost
  projects: VideoProjectService
  analysis: VideoAnalysisService
  stateRoot: string
  renderMotionFrame?: import('./motion-export').RenderMotionFrame
}): EditRunService {
  const runs = new EditRunService({
    projects,
    stateRoot,
    requireVisualCoverage: true,
    recipient: (sessionId) => host.precisionRecipient(sessionId),
    ready: async ({ project, missingAssetIds }) => {
      const status = await analysis.status()
      if (
        !status.ffmpegPath ||
        !findExecutable('ffprobe', join(dirname(status.ffmpegPath), 'ffprobe'))
      )
        throw new EmperorError(
          '自主精剪需要本机 FFmpeg 和 ffprobe。',
          'edit_run_ffmpeg_required',
        )
      if (
        status.transcriptionProvider === 'fun-asr' &&
        !status.funAsrConfigured
      )
        throw new EmperorError(
          '请先在「媒体分析」配置阿里云 Fun-ASR API Key。',
          'edit_run_fun_asr_required',
        )
      if (
        status.transcriptionProvider === 'whisper' &&
        (!status.whisperPath || !status.modelPath)
      )
        throw new EmperorError(
          '请先在「媒体分析」配置 whisper-cli 和 Whisper 模型。',
          'edit_run_whisper_required',
        )
      const missing = new Set(missingAssetIds)
      if (project.clips.some((clip) => missing.has(clip.assetId)))
        throw new EmperorError(
          '请先重新定位时间线上的离线素材。',
          'edit_run_asset_missing',
        )
      return {
        ffmpegPath: status.ffmpegPath,
        transcriptionProvider: status.transcriptionProvider,
      }
    },
    review: (snapshot, options) =>
      reviewEditDraft(snapshot, { ...options, renderMotionFrame }),
    reviewSpeech: async ({
      snapshot,
      relativePath,
      runId,
      generation,
      provider,
      duration,
      anchors,
      signal,
    }) => {
      const issues: DraftReviewIssue[] = findMissingSpeechAnchors(
        snapshot.project,
        anchors,
        duration,
      )
      const spokenAssets = new Set(
        snapshot.project.assets
          .filter((asset) => asset.kind !== 'image')
          .map((asset) => asset.id),
      )
      const hasSound = snapshot.project.clips.some(
        (clip) =>
          !clip.muted && clip.volume > 0 && spokenAssets.has(clip.assetId),
      )
      if (!hasSound)
        return {
          provider,
          status: 'no_speech',
          sentenceCount: 0,
          wordCount: 0,
          issues,
        }
      try {
        const raw = await analysis.transcribe(
          snapshot.projectPath,
          {
            id: `draft-${runId}-${generation}`,
            kind: 'video',
            path: relativePath,
            displayName: '成片原声复检',
            duration,
            width: null,
            height: null,
          },
          { signal, preferTokens: true, expectedProvider: provider },
        )
        if (!raw.segments.length && anchors.length)
          issues.push({
            code: 'speech_unavailable',
            severity: 'error',
            start: 0,
            end: duration,
            message: '成片未识别出有效原声，请确认讲解音轨未被静音。',
          })
        issues.push(...findSpeechDisfluencies(raw, duration))
        return {
          provider,
          status: raw.segments.length ? 'checked' : 'no_speech',
          sentenceCount: raw.segments.length,
          wordCount: raw.tokens?.length ?? 0,
          issues,
        }
      } catch (cause) {
        signal?.throwIfAborted()
        issues.push({
          code:
            cause instanceof EmperorError &&
            cause.code === 'fun_asr_account_unavailable'
              ? cause.code
              : 'speech_unavailable',
          severity: 'error',
          start: 0,
          end: duration,
          message:
            cause instanceof Error
              ? cause.message
              : '成片原声转写未完成。请重试复检。',
        })
        return {
          provider,
          status: 'unavailable',
          sentenceCount: 0,
          wordCount: 0,
          issues,
        }
      }
    },
    inventory: discoverWorkspaceMedia,
    turn: async (sessionId, prompt, signal, displayContent) =>
      (
        await host.runBackgroundTurn(host.scopeFor(sessionId), prompt, {
          source: 'video-precision-edit',
          interactionPolicy: 'wait',
          signal,
          uiHidden: !displayContent,
          displayContent,
          unconsumed: 'withdraw',
          continueTask: !displayContent,
        })
      ).result,
    emit: (snapshot) =>
      host.emitHost({
        event: 'video_project_changed',
        session_id: snapshot.sessionId,
        revision: snapshot.project.revision,
        totalDuration: timelineLayout(snapshot.project).totalDuration,
      }),
    emitDraft: (sessionId, runId, generation) =>
      host.emitHost({
        event: 'video_edit_draft_changed',
        session_id: sessionId,
        run_id: runId,
        generation,
      }),
  })
  host.installPrecisionTools(
    {
      runs,
      analysis,
      start: (sessionId, brief, mode) =>
        projects.startEditRun({ sessionId, brief, mode }, true),
    },
    createPrecisionTools,
    PRECISION_EDITING_PROMPT,
  )
  return runs
}
