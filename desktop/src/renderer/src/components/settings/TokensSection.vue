<script setup lang="ts">
// Usage totals and the three detail views share the same time range.
import { computed, onMounted, ref } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import { formatNumber, formatTokenCompact } from '../../utils/format'
import { formatPercent } from '../../utils/tokens'
import { EmptyState, Metric, Segmented, Select, SettingsSection } from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import TokenHeatmap from './tokens/TokenHeatmap.vue'
import TokenRankingList from './tokens/TokenRankingList.vue'
import TokenTrendChart from './tokens/TokenTrendChart.vue'
import {
  RANGE_OPTIONS,
  SORT_OPTIONS,
  VIEW_OPTIONS,
  cacheModelRows,
  cacheRankingItems,
  cacheTrend,
  cacheUsageRows,
  generatedTime,
  heatmapView,
  modelRankingItems,
  quickStats,
  rangeTotals,
  rankModels,
  recentCacheRows,
  sortRanking,
  usageComposition,
  usageMetrics,
  type RankSort,
  type UsageView,
} from './tokens/tokenUsageModel'
import type { TokensRange } from '../../types'

const ctx = useAppContext()
const range = ref<TokensRange>('all')
const view = ref<UsageView>('activity')
const sort = ref<RankSort>('total')

const tokens = computed(() => ctx.tokens.value)
const totals = computed(() => rangeTotals(tokens.value, range.value))
const lifetime = computed(() => rangeTotals(tokens.value, 'all'))
const metrics = computed(() => usageMetrics(totals.value))
const empty = computed(
  () => Boolean(tokens.value) && lifetime.value.total === 0,
)
const updated = computed(() => generatedTime(tokens.value))
const rangeLabel = computed(
  () => RANGE_OPTIONS.find((option) => option.value === range.value)?.label,
)

const heatmap = computed(() => heatmapView(tokens.value))
const facts = computed(() => quickStats(tokens.value, totals.value))
const ranking = computed(() =>
  modelRankingItems(
    sortRanking(rankModels(tokens.value, range.value), sort.value),
  ),
)
const composition = computed(() => usageComposition(totals.value))
const cacheLines = computed(() => cacheTrend(tokens.value, range.value))
const cacheModels = computed(() =>
  cacheRankingItems(cacheModelRows(tokens.value, range.value)),
)
const cacheUsage = computed(() =>
  cacheRankingItems(cacheUsageRows(tokens.value)),
)
const recent = computed(() => recentCacheRows(tokens.value))

useSettingsHeader({
  actions: () => [
    refreshAction(() => ctx.runSafely(() => ctx.loadTokens(false)), {
      title: '刷新 Token 统计',
      busy: ctx.tokensLoading.value,
    }),
  ],
})

onMounted(() => {
  if (!ctx.tokens.value) void ctx.runSafely(() => ctx.loadTokens(true))
})

function partWidth(value: number, total: number) {
  if (!total) return '0%'
  return `${Math.max(2, (value / total) * 100)}%`
}
</script>

<template>
  <SettingsSection>
    <EmptyState
      v-if="!tokens"
      :title="
        ctx.tokensLoading.value ? '加载 Token 统计中…' : '暂无 Token 统计'
      "
    />
    <EmptyState
      v-else-if="empty"
      title="还没有 Token 记录"
      description="发起一次真实模型调用后会自动出现统计。"
      framed
    />
    <div v-else class="dashboard">
      <div class="toolbar">
        <span class="updated">
          {{ updated ? `更新于 ${updated}` : '' }}
        </span>
        <Segmented
          v-model="range"
          :options="RANGE_OPTIONS"
          aria-label="统计范围"
        />
      </div>

      <div class="metrics" data-testid="token-metrics">
        <Metric
          v-for="metric in metrics"
          :key="metric.key"
          :label="metric.label"
          :value="metric.value"
          :hint="metric.hint"
          :title="metric.title"
          :data-metric="metric.key"
        />
      </div>

      <Segmented
        v-model="view"
        class="views"
        :options="VIEW_OPTIONS"
        size="md"
        block
        aria-label="用量视图"
      />

      <section v-if="view === 'activity'" class="panel" data-view="activity">
        <div class="heading">
          <h3>Token 活跃度</h3>
          <span class="caption">近 53 周 · 每格一天</span>
        </div>
        <TokenHeatmap :view="heatmap" label="近一年每日 Token 活跃热力图" />
        <dl class="facts">
          <div
            v-for="item in facts"
            :key="item.label"
            class="fact"
            :title="item.title"
          >
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
      </section>

      <section v-else-if="view === 'models'" class="panel" data-view="models">
        <div class="heading">
          <h3>模型排名</h3>
          <Select
            v-model="sort"
            :options="SORT_OPTIONS"
            size="sm"
            aria-label="排序方式"
          />
        </div>
        <TokenRankingList
          :items="ranking"
          :label="`${rangeLabel}模型用量排名`"
        />
      </section>

      <section v-else class="panel" data-view="cache">
        <div class="heading">
          <h3>输入缓存效率</h3>
          <strong class="rate">{{
            formatPercent(composition.cacheHit, composition.inputTotal)
          }}</strong>
        </div>
        <div
          class="meter"
          role="img"
          :aria-label="
            composition.parts
              .map((part) => `${part.label} ${formatTokenCompact(part.value)}`)
              .join('，')
          "
        >
          <span
            v-for="part in composition.parts"
            :key="part.key"
            :style="{
              width: partWidth(part.value, composition.total),
              background: part.color,
            }"
            :title="`${part.label}: ${formatNumber(part.value)} tokens`"
          />
        </div>
        <div class="meter-legend">
          <span
            v-for="part in composition.parts"
            :key="part.key"
            class="legend-item"
          >
            <i :style="{ background: part.color }" />
            {{ part.label }}
            <strong :title="`${formatNumber(part.value)} tokens`">{{
              formatTokenCompact(part.value)
            }}</strong>
          </span>
        </div>

        <div class="heading sub">
          <h3>缓存趋势</h3>
          <span class="caption">每日 KV Cache 读取 / 写入</span>
        </div>
        <TokenTrendChart
          :data="cacheLines"
          :label="`${rangeLabel}每日缓存趋势`"
        />

        <div class="heading sub">
          <h3>按模型</h3>
          <span class="caption">{{ cacheModels.length }} 个模型</span>
        </div>
        <TokenRankingList
          :items="cacheModels"
          label="模型缓存排名"
          empty-text="暂无模型产生缓存记录。"
        />

        <div class="heading sub">
          <h3>按用途</h3>
          <span class="caption">全部时间 · {{ cacheUsage.length }} 类</span>
        </div>
        <TokenRankingList
          :items="cacheUsage"
          label="用途缓存排名"
          empty-text="暂无用途维度缓存记录。"
        />

        <div class="heading sub">
          <h3>最近缓存调用</h3>
          <span class="caption">tokens.jsonl 中最新的命中 / 写入记录</span>
        </div>
        <p v-if="!recent.length" class="muted">还没有最近缓存调用。</p>
        <ul v-else class="recent" aria-label="最近缓存调用">
          <li v-for="row in recent" :key="row.key" class="recent-row">
            <span class="recent-time">{{ row.time }}</span>
            <span class="recent-main">
              <strong :title="row.model">{{ row.model }}</strong>
              <small>{{ row.usage }} · {{ row.detail }}</small>
            </span>
            <strong class="recent-total" :title="row.totalTitle">{{
              row.total
            }}</strong>
          </li>
        </ul>
      </section>
    </div>
  </SettingsSection>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.updated {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  min-width: 0;
  min-height: 290px;
}

.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  min-width: 0;
}

.heading.sub {
  margin-top: var(--space-3);
}

.heading h3 {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
}

.caption,
.muted {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
}

.muted {
  margin: 0;
  padding: var(--space-3) 0;
  text-align: center;
}

.facts {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-1) 0 0;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding: var(--space-2) var(--space-2-5);
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-row);
}

.fact dt {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
}

.fact dd {
  margin: 0;
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rate {
  font-size: var(--fs-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
  color: rgb(var(--state-ok-label));
  font-variant-numeric: tabular-nums;
}

.meter {
  display: flex;
  gap: 2px;
  height: var(--space-2-5);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
}

.meter span {
  display: block;
  min-width: 0;
  height: 100%;
}

.meter-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5) var(--space-4);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-2));
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}

.legend-item i {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: 2px;
}

.legend-item strong {
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
  font-variant-numeric: tabular-nums;
}

.recent {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--stroke-1);
}

.recent-row:last-child {
  border-bottom: none;
}

.recent-time {
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
}

.recent-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.recent-main strong {
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-main small {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
  overflow-wrap: anywhere;
}

.recent-total {
  font-size: var(--fs-xxs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

@container (max-width: 520px) {
  .facts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@container (max-width: 439px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .recent-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .recent-time {
    grid-column: 1 / -1;
  }
}
</style>
