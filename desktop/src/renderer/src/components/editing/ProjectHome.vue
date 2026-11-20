<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowRight,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
} from 'lucide-vue-next'
import Button from '../ui/Button.vue'
import { APP_NAME } from '../../../../shared/app-brand'
import brandMark from '../../../../../../assets/brand/cutroom-mark.svg'
import consoleImage from '../../assets/cutroom-editing-console.webp'
import type { RecentVideoProject } from './editingStore'

const props = withDefaults(
  defineProps<{
    projects?: readonly RecentVideoProject[]
    loading?: boolean
    error?: string
  }>(),
  { projects: () => [], loading: false, error: '' },
)
const emit = defineEmits<{
  create: []
  open: []
  'open-recent': [project: RecentVideoProject]
}>()

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const recent = computed(() =>
  [...props.projects].sort(
    (a, b) => (Date.parse(b.openedAt) || 0) - (Date.parse(a.openedAt) || 0),
  ),
)
// Discovery supplies a modification date, but only a real opening supplies a session.
const lastOpened = computed(() =>
  recent.value.find((project) => project.sessionId),
)
const summary = computed(() => {
  const projectsLabel = `${props.projects.length} 个项目`
  if (
    !props.projects.length ||
    props.projects.some((project) => project.assetCount === undefined)
  )
    return projectsLabel
  const assets = props.projects.reduce(
    (sum, project) => sum + (project.assetCount ?? 0),
    0,
  )
  return `${projectsLabel} · ${assets} 个素材`
})
function projectStats(project: RecentVideoProject) {
  const counts: string[] = []
  if (typeof project.assetCount === 'number')
    counts.push(`${project.assetCount} 个素材`)
  if (typeof project.clipCount === 'number')
    counts.push(`${project.clipCount} 个片段`)
  return counts.join(' · ') || '本地工程'
}
function dateLabel(project: RecentVideoProject) {
  const time = Date.parse(project.openedAt)
  if (!Number.isFinite(time)) return ''
  return `${project.sessionId ? '上次打开' : '更新于'} ${dateFormat.format(time)}`
}
</script>

<template>
  <section class="project-home" aria-label="项目首页">
    <div class="home-inner">
      <header class="hero">
        <img
          class="hero-art"
          :src="consoleImage"
          width="2172"
          height="724"
          alt=""
        />
        <div class="hero-copy">
          <div class="hero-brand">
            <img :src="brandMark" width="22" height="22" alt="" />{{ APP_NAME }}
          </div>
          <h1>剪辑工作台</h1>
          <p v-if="lastOpened" class="hero-context">
            <span>上次打开</span
            ><strong :title="lastOpened.name">{{ lastOpened.name }}</strong>
          </p>
          <p v-else class="hero-context">在本机整理素材、剪辑视频。</p>
          <div class="home-actions">
            <Button
              v-if="lastOpened"
              class="hero-action hero-primary"
              data-testid="continue-project"
              :disabled="loading"
              @click="emit('open-recent', lastOpened)"
            >
              继续剪辑<ArrowRight :size="16" aria-hidden="true" />
            </Button>
            <Button
              class="hero-action"
              :class="{ 'hero-primary': !lastOpened }"
              data-testid="new-project"
              :disabled="loading"
              @click="emit('create')"
            >
              <Plus :size="16" aria-hidden="true" />新建项目
            </Button>
            <Button
              class="hero-action"
              data-testid="open-folder"
              :disabled="loading"
              @click="emit('open')"
            >
              <FolderOpen :size="16" aria-hidden="true" />打开文件夹
            </Button>
          </div>
        </div>
      </header>

      <p v-if="error" class="home-error" role="alert">{{ error }}</p>

      <section class="local-projects" aria-labelledby="home-projects-title">
        <header class="recent-header">
          <h2 id="home-projects-title">本地项目</h2>
          <span class="home-summary">{{ summary }}</span>
        </header>
        <ul v-if="recent.length" class="project-list">
          <li v-for="project in recent" :key="project.projectPath">
            <Button
              class="project-card"
              :disabled="loading"
              :title="project.projectPath"
              :data-testid="`recent-project-${project.sessionId || project.projectPath}`"
              @click="emit('open-recent', project)"
            >
              <span class="project-symbol"
                ><Folder :size="20" aria-hidden="true"
              /></span>
              <span class="project-copy">
                <strong>{{ project.name }}</strong>
                <small>{{ project.projectPath }}</small>
              </span>
              <span class="project-meta">
                <span>{{ projectStats(project) }}</span>
                <time v-if="dateLabel(project)" :datetime="project.openedAt">{{
                  dateLabel(project)
                }}</time>
              </span>
              <ChevronRight class="row-arrow" :size="16" aria-hidden="true" />
            </Button>
          </li>
        </ul>
        <div v-else class="recent-empty">
          <span class="project-symbol"
            ><FolderOpen :size="20" aria-hidden="true"
          /></span>
          <div>
            <strong>还没有本地项目</strong>
            <p>新建或打开的项目会列在这里。</p>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.project-home {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  color: rgb(var(--editor-text));
  background: rgb(var(--editor-canvas));
}
.home-inner {
  width: min(1240px, 100%);
  padding: clamp(20px, 3.5vw, 54px);
  margin-inline: auto;
  box-sizing: border-box;
}
.hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: flex;
  align-items: center;
  min-height: clamp(246px, 24vw, 320px);
  padding: clamp(24px, 3.7vw, 54px);
  box-sizing: border-box;
  border-radius: var(--radius-card);
  background: rgb(20 20 19);
  color: rgb(250 249 247);
}
.hero-art,
.hero::before {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.hero-art {
  z-index: var(--z-base);
  object-fit: cover;
  object-position: 70% center;
}
.hero::before {
  z-index: var(--z-raised);
  content: '';
  pointer-events: none;
  background: linear-gradient(
    90deg,
    rgb(11 13 16 / 0.87),
    rgb(11 13 16 / 0.67) 32%,
    transparent 74%
  );
}
.hero-copy {
  position: relative;
  z-index: var(--z-raised);
  display: grid;
  justify-items: start;
  min-width: 0;
  max-width: 62%;
}
.hero-brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  font-weight: var(--weight-medium);
  line-height: 1;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgb(249 248 241);
}
.hero h1 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: clamp(32px, 3.4vw, 48px);
  line-height: 1.12;
  font-weight: var(--weight-semibold);
  letter-spacing: -0.045em;
}
.hero-context {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  margin: 0;
  color: rgb(227 226 223);
  font-size: var(--fs-xs);
  line-height: 1.55;
}
.hero-context > span {
  flex: none;
}
.hero-context strong {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: var(--weight-medium);
}
.home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-6);
}
.home-actions .hero-action {
  height: 36px;
  padding: 0 var(--space-3-5);
  border: 0.5px solid rgb(255 255 255 / 0.28);
  border-radius: var(--radius-row);
  background: rgb(24 26 28 / 0.9);
  color: rgb(248 247 245);
}
.home-actions .hero-action:hover:not(:disabled) {
  background: rgb(55 57 59);
  color: rgb(255 255 255);
}
.home-actions .hero-primary {
  border-color: transparent;
  background: rgb(235 205 164);
  color: rgb(35 28 21);
}
.home-actions .hero-primary:hover:not(:disabled) {
  background: rgb(248 223 190);
  color: rgb(35 28 21);
}
.local-projects {
  margin-top: clamp(24px, 3vw, 42px);
}
.recent-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.recent-header h2 {
  margin: 0;
  font-size: var(--fs-hero);
  line-height: var(--lh-hero);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
}
.home-summary,
.project-meta,
.project-copy small,
.recent-empty p {
  color: rgb(var(--editor-muted));
}
.home-summary {
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
}
.project-list {
  overflow: hidden;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 0.5px solid rgb(var(--editor-line));
  border-radius: var(--radius-card);
  background: rgb(var(--editor-panel));
}
.project-list li + li {
  border-top: 0.5px solid rgb(var(--editor-line));
}
.project-list .project-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  justify-content: stretch;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  height: auto;
  min-height: 77px;
  padding: var(--space-3-5) var(--space-5);
  border-radius: 0;
  color: rgb(var(--editor-text));
  text-align: left;
}
.project-list .project-card:hover:not(:disabled) {
  background: rgb(var(--editor-panel-raised));
  color: rgb(var(--editor-text));
}
.project-list .project-card:focus-visible {
  outline: 2px solid rgb(var(--editor-accent));
  outline-offset: -2px;
}
.project-symbol {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-row);
  background: rgb(var(--editor-accent-soft));
  color: rgb(var(--editor-accent));
}
.project-copy,
.project-meta {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
}
.project-copy strong,
.project-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-copy strong,
.recent-empty strong {
  font-size: var(--fs-s);
  font-weight: var(--weight-medium);
}
.project-copy small {
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}
.project-meta {
  justify-items: end;
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
  font-variant-numeric: tabular-nums;
}
.project-meta time {
  font-size: var(--fs-xxxs);
}
.row-arrow {
  color: rgb(var(--editor-muted));
}
.recent-empty {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 0.5px solid rgb(var(--editor-line));
  border-radius: var(--radius-card);
  background: rgb(var(--editor-panel));
}
.recent-empty p {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-xxs);
}
.home-error {
  margin: var(--space-3) 0 0;
  color: rgb(var(--error));
  font-size: var(--fs-xs);
}
@media (max-width: 700px) {
  .home-inner {
    padding: var(--space-4);
  }
  .hero-copy {
    max-width: 100%;
  }
  .hero::before {
    background: linear-gradient(
      90deg,
      rgb(11 13 16 / 0.91),
      rgb(11 13 16 / 0.72) 60%,
      rgb(11 13 16 / 0.12)
    );
  }
  .project-list .project-card {
    gap: var(--space-3);
    padding-inline: var(--space-3);
  }
}
@media (max-width: 460px) {
  .home-inner {
    padding: var(--space-3);
  }
  .hero {
    padding: var(--space-5);
  }
  .home-actions {
    gap: var(--space-1-5);
  }
  .home-actions .hero-action {
    padding-inline: var(--space-2-5);
  }
  .project-list .project-card {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .project-symbol {
    grid-row: span 2;
  }
  .project-meta {
    grid-column: 2;
    justify-items: start;
  }
  .row-arrow {
    grid-column: 3;
    grid-row: 1 / 3;
  }
}
</style>
