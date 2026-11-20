import type { CoreOperationArgs, CoreOperationResult } from '@emperor/core/api'

export type EditRunMode = NonNullable<
  CoreOperationArgs<'videoProject.startEditRun'>[0]['mode']
>
export type EditRunAction =
  CoreOperationArgs<'videoProject.editRunAction'>[0]['action']
export type EditRunStatus = NonNullable<
  CoreOperationResult<'videoProject.editRunStatus'>
>

export function isEditing(state: EditRunStatus['state'] | undefined): boolean {
  return (
    state === 'analyzing' ||
    state === 'rough_cut' ||
    state === 'fine_cut' ||
    state === 'reviewing' ||
    state === 'repairing'
  )
}

export const editRunLabels: Record<EditRunStatus['state'], string> = {
  analyzing: '分析口播与画面',
  awaiting_approval: '确认剪辑思路',
  rough_cut: '粗剪',
  fine_cut: '精剪',
  reviewing: '审片',
  repairing: '修复问题',
  paused: '精剪已暂停',
  blocked: '精剪遇到阻碍',
  delivered: '精剪已交付',
  conflict: '精剪草稿待处理',
  cancelled: '精剪已取消',
}
