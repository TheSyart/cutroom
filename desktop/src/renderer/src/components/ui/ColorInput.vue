<script setup lang="ts">
defineOptions({ inheritAttrs: false })
</script>

<template>
  <input v-bind="$attrs" class="ds-color-input" type="color" />
</template>

<style scoped>
.ds-color-input {
  width: var(--control-md);
  height: var(--control-sm);
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  cursor: pointer;
}
</style>
