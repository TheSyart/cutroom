// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, ref, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import SkillsSection from './SkillsSection.vue'
import SkillDetail from './skills/SkillDetail.vue'

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  deleteSkill: vi.fn(),
  saveSkill: vi.fn(),
  validateSkill: vi.fn(),
}))
vi.mock('../../api/skills', async (actual) => ({
  ...(await actual<typeof import('../../api/skills')>()),
  ...api,
}))
const workspace = reactive({
  sessionId: 'a',
  project: { name: 'A' },
  projectPath: '/a',
})
vi.mock('../editing/editingStore', () => ({
  useEditingWorkspace: () => ({ state: workspace }),
}))
vi.mock('./skills/useSkillSelection', () => ({
  useSkillSelection: () => ({ selected: ref(null), select: vi.fn() }),
}))

let app: App | undefined
const toast = vi.fn()
function mount(detail = false) {
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp(() =>
    detail
      ? h(SkillDetail, { name: 'shared', sessionId: workspace.sessionId })
      : h(SkillsSection),
  )
  app.provide(APP_CONTEXT_KEY, {
    runSafely: (task: () => Promise<void>) => task().catch(() => {}),
    refreshCommands: async () => {},
    showToast: toast,
  } as never)
  app.mount(root)
}
const button = (selector: string) =>
  document.querySelector<HTMLButtonElement>(selector)
function skill(owner: string) {
  return {
    name: 'shared',
    description: owner,
    source: 'project',
    path: '/' + owner + '/shared/SKILL.md',
    content: owner,
    readOnly: false,
    warnings: [],
  }
}
function invalid(owner: string) {
  return {
    name: 'broken',
    source: 'project',
    path: '/' + owner + '/broken',
    reason: 'bad',
    errors: [],
    warnings: [],
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  workspace.sessionId = 'a'
  api.validateSkill.mockResolvedValue({ valid: true, errors: [], warnings: [] })
})
afterEach(() => {
  app?.unmount()
  document.body.replaceChildren()
})

it('removes the old list and its pending delete when another project fails to load', async () => {
  api.listSkills
    .mockResolvedValueOnce({ skills: [], invalid: [invalid('a')] })
    .mockRejectedValue(new Error('offline'))
  mount()
  await vi.waitFor(() =>
    expect(button('[data-testid=invalid-skills] .head')).toBeTruthy(),
  )
  button('[data-testid=invalid-skills] .head')!.click()
  await nextTick()
  button('[data-invalid-skill] [aria-expanded]')!.click()
  await nextTick()
  button('[data-invalid-skill] [data-action=delete]')!.click()
  await nextTick()
  const originalConfirm = button('[data-action=confirm]')!
  expect(originalConfirm).toBeTruthy()
  workspace.sessionId = 'b'
  await nextTick()
  originalConfirm.click()
  expect(api.deleteSkill).not.toHaveBeenCalled()
  expect(button('[data-testid=invalid-skills] .head')).toBeNull()
  expect(api.listSkills).toHaveBeenLastCalledWith({ sessionId: 'b' })
})

it('keeps a late save bound to its original Skill and preserves the new project’s editor', async () => {
  api.getSkill.mockImplementation(async (_name, options) =>
    skill(options.sessionId),
  )
  let done!: (next: ReturnType<typeof skill>) => void
  api.saveSkill.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve
      }),
  )
  mount(true)
  const editor = () => document.querySelector<HTMLTextAreaElement>('textarea')!
  await vi.waitFor(() => expect(editor()?.value).toBe('a'))
  editor().value = 'edited A'
  editor().dispatchEvent(new Event('input'))
  const save = () => button('[data-action=save]')!
  await vi.waitFor(() => expect(save().disabled).toBe(false))
  save().click()
  expect(api.saveSkill).toHaveBeenCalledWith('shared', 'edited A', {
    sessionId: 'a',
  })
  workspace.sessionId = 'b'
  await vi.waitFor(() => expect(editor().value).toBe('b'))
  done({ ...skill('a'), content: 'edited A' })
  await nextTick()
  await nextTick()
  expect(editor().value).toBe('b')
  expect(toast).not.toHaveBeenCalled()
})
