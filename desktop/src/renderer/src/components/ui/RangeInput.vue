<script setup lang="ts">
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{ tone?: 'default' | 'editor' }>(), {
  tone: 'default',
})
</script>

<template>
  <input
    v-bind="$attrs"
    class="ds-range-input"
    :data-tone="tone"
    type="range"
  />
</template>

<style scoped>
.ds-range-input {
  width: 100%;
  min-width: 0;
  height: var(--control-xs);
  margin: 0;
  padding: 0;
  accent-color: rgb(var(--accent));
  cursor: pointer;
}
.ds-range-input[data-tone='editor'] {
  accent-color: rgb(var(--editor-accent));
}
.ds-range-input:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
