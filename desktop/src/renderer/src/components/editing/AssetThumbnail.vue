<script setup lang="ts">
/** Real media poster for the asset grid and timeline clips (no fake gradient). */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { Music, Film, Image as ImageIcon } from 'lucide-vue-next'
import type { VideoAsset } from '@emperor/core/editing'
import {
  editingMediaTarget,
  useMediaAddress,
} from '../workspace/useFileAddress'
import { useEditMediaSource } from './useEditMediaSource'

const props = withDefaults(
  defineProps<{
    asset: VideoAsset
    sessionId: string
    fit?: 'cover' | 'contain'
    posterTime?: number
    posterEnd?: number
  }>(),
  { fit: 'cover' },
)

const host = ref<HTMLElement | null>(null)
const visible = ref(typeof IntersectionObserver === 'undefined')
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (!host.value || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    ([entry]) => {
      visible.value = Boolean(entry?.isIntersecting)
    },
    { rootMargin: '120px' },
  )
  observer.observe(host.value)
})
onBeforeUnmount(() => observer?.disconnect())
const source = useEditMediaSource(
  () =>
    visible.value
      ? {
          sessionId: props.sessionId,
          asset: props.asset,
          posterTime: props.posterTime,
          posterEnd: props.posterEnd,
        }
      : null,
  'poster',
)
const media = useMediaAddress(() =>
  editingMediaTarget(props.sessionId, source.path.value),
)
const showFallback = computed(
  () => !visible.value || media.state.value !== 'ready',
)
</script>

<template>
  <span ref="host" class="asset-thumbnail" :data-fit="fit">
    <Music
      v-if="
        asset.kind === 'audio' &&
        (posterTime === undefined || showFallback || !media.url.value)
      "
      aria-label="音频素材"
      :size="20"
    />
    <template v-else-if="!showFallback && media.url.value">
      <img
        :src="media.url.value"
        :alt="asset.displayName"
        loading="lazy"
        @load="media.loaded"
        @error="media.failed"
      />
    </template>
    <span v-else class="fallback" aria-hidden="true">
      <Film v-if="asset.kind === 'video'" :size="20" />
      <ImageIcon v-else :size="20" />
    </span>
  </span>
</template>

<style scoped>
.asset-thumbnail {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: rgb(var(--editor-panel-raised));
}
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
[data-fit='contain'] img {
  object-fit: contain;
}
.fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: rgb(var(--editor-muted));
}
</style>
