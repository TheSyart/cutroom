import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import { editorSettingsSection } from './components/settings/settingsSections'
const EditorPage = () => import('./components/editing/EditorPage.vue')

function firstParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

export const routeRecords: RouteRecordRaw[] = [
  { path: '/editor', name: 'editor', component: EditorPage },
  {
    path: '/chat/:sessionId?/:rest(.*)*',
    redirect: (to) => ({
      path: '/editor',
      query: {
        ...to.query,
        ...(firstParam(to.params.sessionId)
          ? { projectSession: firstParam(to.params.sessionId) }
          : {}),
      },
    }),
  },
  {
    path: '/settings/:section?',
    redirect: (to) => ({
      path: '/editor',
      query: { settings: editorSettingsSection(to.params.section) },
    }),
  },
  {
    path: '/skills/:name?',
    redirect: (to) => ({
      path: '/editor',
      query: {
        settings: 'skills',
        ...(firstParam(to.params.name)
          ? { skill: firstParam(to.params.name) }
          : {}),
      },
    }),
  },
  { path: '/capabilities/skills', redirect: '/editor?settings=skills' },
  { path: '/model', redirect: '/editor?settings=model' },
  { path: '/tokens', redirect: '/editor?settings=tokens' },
  { path: '/:pathMatch(.*)*', redirect: '/editor' },
]

/** Canonicalize old bookmarks and remove invalid settings selections. */
export function installRouteGuards(target: Router): void {
  target.beforeEach((to) => {
    if (to.query.settings == null) return true
    const section = editorSettingsSection(to.query.settings)
    if (
      section === to.query.settings &&
      !('page' in to.query) &&
      (section === 'skills' || !('skill' in to.query))
    )
      return true
    const { page: _page, skill, ...rest } = to.query
    return {
      path: to.path,
      hash: to.hash,
      query: {
        ...rest,
        settings: section,
        ...(section === 'skills' && skill ? { skill } : {}),
      },
      replace: true,
    }
  })
}

export const router = createRouter({
  history:
    typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(),
  routes: routeRecords,
})
installRouteGuards(router)

/** Route location of a session's Chat (or Trajectory) tab. */
export function sessionLocation(
  sessionId: string,
  _tab: 'chat' | 'trajectory' = 'chat',
): RouteLocationRaw {
  return {
    name: 'editor',
    query: sessionId ? { projectSession: sessionId } : {},
  }
}
