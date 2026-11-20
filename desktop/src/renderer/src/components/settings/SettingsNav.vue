<script setup lang="ts">
import {
  Activity,
  Cpu,
  BookOpen,
  ChartNoAxesCombined,
  AudioLines,
} from 'lucide-vue-next'
import {
  EDITOR_SETTINGS_SECTIONS as labels,
  type SettingsModalSection,
} from './settingsSections'
defineProps<{ active: SettingsModalSection; titleId: string }>()
const emit = defineEmits<{ select: [section: SettingsModalSection] }>()
const icons = {
  model: Cpu,
  skills: BookOpen,
  media: AudioLines,
  voice: Activity,
  tokens: ChartNoAxesCombined,
}
const sections = Object.keys(labels) as SettingsModalSection[]
</script>

<template>
  <nav class="settings-nav editor-nav" aria-label="设置分区">
    <div :id="titleId" class="nav-title">设置</div>
    <div class="nav-list">
      <div class="nav-group">
        <button
          v-for="key in sections"
          :key="key"
          type="button"
          class="nav-cell"
          :class="{ active: key === active }"
          :data-section="key"
          :title="labels[key]"
          :aria-current="key === active ? 'page' : undefined"
          @click="emit('select', key)"
        >
          <component :is="icons[key]" :size="16" aria-hidden="true" />
          <span class="nav-label">{{ labels[key] }}</span>
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.settings-nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  width: 190px;
  min-height: 0;
  padding: var(--space-5) var(--space-2) 0;
  box-sizing: border-box;
  overflow-y: auto;
  border-right: 0.5px solid var(--stroke-2);
  background: rgb(var(--surface-canvas));
}

.nav-title {
  padding: 0 var(--space-2-5);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
}

.nav-list {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--space-3);
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* Muted gold group titles (BUG-04): readable without competing with the
   items or the gold of actions and links. */
.nav-group-label {
  padding: var(--space-4) var(--space-2-5) var(--space-1);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.02em;
  color: rgb(var(--text-3));
}

.nav-cell {
  display: flex;
  align-items: center;
  height: 34px;
  gap: var(--space-2-5);
  padding: 0 var(--space-2-5);
  box-sizing: border-box;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-regular);
  color: rgb(var(--text-1));
  text-align: left;
}

.nav-cell:hover:not(.active) {
  background: var(--surface-hover);
}

.nav-cell.active {
  color: rgb(var(--editor-accent));
  background: rgb(var(--editor-accent-soft));
  font-weight: var(--weight-medium);
}

.nav-cell:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.nav-cell svg {
  flex: none;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.nav-mark {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: var(--space-2);
  border-radius: 50%;
  background: rgb(var(--accent));
}

/* Read out, not shown. */
.nav-mark-text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@container settings-panel (max-width: 639px) {
  .settings-nav:not(.editor-nav) {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3-5) var(--space-3) var(--space-1);
    overflow-x: auto;
    overflow-y: hidden;
  }

  .settings-nav:not(.editor-nav) .nav-title {
    flex: none;
    padding: 0 var(--space-2) 0 var(--space-1-5);
  }

  .settings-nav:not(.editor-nav) .nav-list,
  .settings-nav:not(.editor-nav) .nav-group {
    flex-direction: row;
    gap: var(--space-1);
    padding-bottom: 0;
  }

  .nav-group-label {
    display: none;
  }

  .settings-nav:not(.editor-nav) .nav-cell {
    flex: none;
    padding: 0 var(--space-3);
  }

  .nav-label {
    overflow: visible;
  }
}
.editor-nav .nav-list {
  margin-top: var(--space-3);
}
@container settings-panel (max-width: 639px) {
  .editor-nav {
    width: 126px;
  }
}
@container settings-panel (max-width: 480px) {
  .editor-nav {
    width: 90px;
    padding-inline: var(--space-1);
  }
  .editor-nav .nav-cell {
    padding-inline: var(--space-2);
    gap: var(--space-1);
    font-size: var(--fs-xs);
  }
  .editor-nav .nav-cell svg {
    width: 13px;
  }
}
</style>
