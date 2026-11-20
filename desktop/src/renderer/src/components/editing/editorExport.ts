import { ref } from 'vue'
import { cancelVideoExport, exportVideo } from '../../api/backend'
import type {
  VideoExportOwner,
  VideoExportResponse,
} from '../../../../shared/ipc-contract'

interface EditorExportState {
  owner: VideoExportOwner
  percent: number | null
  cancelling: boolean
  result?: VideoExportResponse
}

// The native exporter belongs to this window and outlives a mounted project or toolbar.
export const editorExport = ref<EditorExportState | null>(null)

export async function startEditorExport(
  sessionId: string,
  projectId: string,
  expectedRevision: number,
): Promise<void> {
  if (editorExport.value && !editorExport.value.result) return
  const owner = { sessionId, projectId, runId: crypto.randomUUID() }
  editorExport.value = { owner, percent: null, cancelling: false }
  const job = editorExport.value
  try {
    job.result = await exportVideo(
      { ...owner, expectedRevision },
      (percent) => {
        if (!job.result && !job.cancelling) job.percent = percent
      },
    )
  } catch (error) {
    job.result = {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function cancelEditorExport(
  owner: VideoExportOwner,
): Promise<void> {
  const job = editorExport.value
  if (!job || job.owner.runId !== owner.runId || job.result || job.cancelling)
    return
  job.cancelling = true
  try {
    await cancelVideoExport({ ...owner })
  } catch (error) {
    job.cancelling = false
    throw error
  }
}
