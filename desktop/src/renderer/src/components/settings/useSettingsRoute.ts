import { computed } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  editorSettingsSection,
  type SettingsSectionKey,
} from './settingsSections'

const PAGE_KEY = /^[a-z][a-z0-9-]{0,31}$/

/** A `page` query value that can name a sub page, else null. */
export function settingsPageKey(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && PAGE_KEY.test(raw) ? raw : null
}

export function settingsQuery(
  query: LocationQuery,
  section: SettingsSectionKey | null,
  page: string | null = null,
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.settings
  delete next.page
  if (query.settings === 'skills' && section !== 'skills') delete next.skill
  if (section) {
    next.settings = section
    if (page) next.page = page
  }
  return next
}

export function useSettingsRoute() {
  const route = useRoute()
  const router = useRouter()

  const open = computed(() => route.query.settings != null)
  const section = computed(() => editorSettingsSection(route.query.settings))
  /**
   * The sub page the route names (or the one a folded section's old key
   * stands for); the section decides whether it has one.
   */
  const page = computed(() => settingsPageKey(route.query.page) ?? null)

  function openSettings(
    target: SettingsSectionKey = 'model',
    subPage: string | null = null,
  ): Promise<unknown> {
    return router
      .push({
        path: route.path,
        query: settingsQuery(route.query, target, subPage),
      })
      .catch(() => undefined)
  }

  function selectSection(target: SettingsSectionKey): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, target) })
      .catch(() => undefined)
  }

  /** A sub page of the open section, or its main page (null). */
  function openPage(target: string | null): Promise<unknown> {
    return router
      .replace({
        path: route.path,
        query: settingsQuery(route.query, section.value, target),
      })
      .catch(() => undefined)
  }

  function closeSettings(): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, null) })
      .catch(() => undefined)
  }

  return {
    open,
    section,
    page,
    openSettings,
    selectSection,
    openPage,
    closeSettings,
  }
}
