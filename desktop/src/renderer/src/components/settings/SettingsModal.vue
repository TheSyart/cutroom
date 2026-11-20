<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type Component,
} from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import { DsChevronRight, DsClose } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import { useModalLayer } from '../ui/modalStack'
import { provideDirtyGuard } from '../ui/useDirtyGuard'
import { useFocusTrap } from '../ui/useFocusTrap'
import SettingsHeaderBar from './SettingsHeaderBar.vue'
import SettingsNav from './SettingsNav.vue'
import { provideSettingsHeader } from './settingsHeader'
import {
  EDITOR_SETTINGS_SECTIONS,
  editorSettingsSection,
  type SettingsModalSection,
} from './settingsSections'
import { settingsPageKey, useSettingsRoute } from './useSettingsRoute'

const SECTION_BODIES: Record<keyof typeof EDITOR_SETTINGS_SECTIONS, Component> =
  {
    skills: defineAsyncComponent(() => import('./SkillsSection.vue')),
    model: defineAsyncComponent(() => import('./ModelSection.vue')),
    voice: defineAsyncComponent(() => import('./VoiceSettingsSection.vue')),
    media: defineAsyncComponent(
      () => import('./mediaAnalysis/MediaAnalysisSection.vue'),
    ),
    tokens: defineAsyncComponent(() => import('./TokensSection.vue')),
  }

/** What the modal shows for a query: '' closed, else section/page. */
function settingsView(query: LocationQuery): string {
  if (query.settings == null) return ''
  const page = settingsPageKey(query.page) ?? ''
  return `${editorSettingsSection(query.settings)}/${page}`
}

const route = useRoute()
const settings = useSettingsRoute()
const { open } = settings
const section = computed(() => editorSettingsSection(route.query.settings))
const header = provideSettingsHeader({
  page: () => settings.page.value,
  go: (page) => void settings.openPage(page),
})

const titleId = 'settings-modal-title'
const sectionTitleId = 'settings-section-title'
const overlay = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const options = ref<HTMLElement | null>(null)
const crumb = ref<HTMLButtonElement | null>(null)

const body = computed(() => SECTION_BODIES[section.value])
const sectionLabel = computed(() => EDITOR_SETTINGS_SECTIONS[section.value])

function close() {
  void settings.closeSettings()
}

function select(target: SettingsModalSection) {
  if (target === section.value) {
    if (header.page.value !== null) header.back()
    return
  }
  void settings.selectSection(target)
}

const guard = provideDirtyGuard()
const removeGuard = useRouter().beforeEach((to, from) =>
  !guard.dirty.value || settingsView(to.query) === settingsView(from.query)
    ? true
    : guard.confirmDiscard(),
)
onBeforeUnmount(removeGuard)

useModalLayer(open, close)
useFocusTrap(panel, open, {
  initialFocus: () => panel.value,
  layer: () => overlay.value,
})

watch(
  () => header.page.value,
  (next) => {
    if (options.value) options.value.scrollTop = 0
    // Read before the page re-renders and the focused control is gone.
    const active =
      typeof document === 'undefined' ? null : document.activeElement
    const fromSection = Boolean(active && options.value?.contains(active))
    const fromCrumb = active !== null && active === crumb.value
    void nextTick(() => {
      if (next !== null && fromSection)
        crumb.value?.focus({ preventScroll: true })
      else if (next === null && fromCrumb)
        panel.value?.focus({ preventScroll: true })
    })
  },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="overlay" class="settings-overlay" role="presentation">
      <div class="settings-mask" aria-hidden="true" @click="close" />
      <div
        ref="panel"
        class="settings-panel editor-settings-panel ds-fade-in"
        :data-view="section"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        data-testid="settings-modal"
      >
        <div class="settings-layout editor-layout">
          <SettingsNav :active="section" :title-id="titleId" @select="select" />
          <div class="settings-content">
            <div class="settings-header">
              <h2 :id="sectionTitleId" class="section-title">
                <template v-if="header.trail.value">
                  <button
                    ref="crumb"
                    type="button"
                    class="section-crumb"
                    data-testid="settings-crumb"
                    @click="header.back()"
                  >
                    {{ sectionLabel }}
                  </button>
                  <DsChevronRight
                    class="section-crumb-separator"
                    :size="12"
                    aria-hidden="true"
                  />
                  <span
                    class="section-page"
                    data-testid="settings-page-title"
                    >{{ header.trail.value }}</span
                  >
                </template>
                <template v-else>{{ sectionLabel }}</template>
              </h2>
              <div class="header-actions">
                <SettingsHeaderBar :actions="header.actions.value" />
                <IconButton
                  class="settings-close"
                  label="关闭设置"
                  tooltip="关闭"
                  @click="close"
                >
                  <DsClose :size="14" />
                </IconButton>
              </div>
            </div>
            <div
              ref="options"
              class="settings-options"
              role="region"
              :aria-labelledby="sectionTitleId"
              :data-section="section"
              :data-page="header.page.value ?? undefined"
            >
              <component
                :is="body"
                :key="section"
                v-bind="section === 'model' ? { editingOnly: true } : {}"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-mask {
  position: absolute;
  inset: 0;
  background: var(--scrim);
  backdrop-filter: blur(var(--mask-blur));
}

.settings-panel {
  container: settings-panel / inline-size;
  position: relative;
  width: 960px;
  height: min(760px, calc(100dvh - 56px));
  max-width: calc(100vw - 48px);
  overflow: hidden;
  border-radius: var(--r-xl);
  background: rgb(var(--surface-base));
  box-shadow: var(--shadow-lv3);
  color: rgb(var(--text-1));
  outline: none;
}

.settings-layout {
  display: flex;
  width: 100%;
  height: 100%;
}

.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: rgb(var(--surface-base));
}

/* dsh .Header: h54, pad (20,14,8,10); title inset to the 24px content edge. */
.settings-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 60px;
  padding: var(--space-3) var(--space-4) var(--space-3) var(--space-2-5);
  border-bottom: 0.5px solid var(--stroke-2);
  box-sizing: border-box;
}

.section-title {
  min-width: 0;
  margin: 0;
  padding-left: var(--space-3-5);
  overflow: hidden;
  font-size: var(--fs-hero);
  line-height: var(--lh-hero);
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-title:has(.section-crumb) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* The section name on a sub page: a quiet link back to its main page. */
.section-crumb {
  flex: none;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--text-3));
  font: inherit;
  cursor: pointer;
}

.section-crumb:hover {
  color: rgb(var(--text-1));
}

.section-crumb:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.section-crumb-separator {
  flex: none;
  color: rgb(var(--text-3));
}

.section-page {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-left: auto;
}

/* dsh .options: pad (0,24,24), scrolls. The right padding widens past 24px
   once the column exceeds 720 + 48px, capping the content at 720px while
   the scrollbar stays at the panel edge. */
.settings-options {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-4)
    max(var(--space-6), calc(100% - 720px - var(--space-6))) var(--space-6)
    var(--space-6);
  overflow-y: auto;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--text-1));
}

@container settings-panel (max-width: 639px) {
  .settings-layout:not(.editor-layout) {
    flex-direction: column;
  }

  .settings-header {
    height: auto;
    padding-top: var(--space-2);
  }

  .settings-options {
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  .section-title {
    padding-left: var(--space-1-5);
  }
}
@media (max-width: 640px) {
  .settings-panel {
    max-width: calc(100vw - 16px);
    height: calc(100dvh - 24px);
  }
}
</style>
