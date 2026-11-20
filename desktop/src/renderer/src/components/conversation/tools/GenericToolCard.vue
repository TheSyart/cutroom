<script setup lang="ts">
/** GenericToolCard — fallback body: arguments IN / result OUT (JsonTree). */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { attachmentRawUrl } from '../../../api/attachments'
import { openImageViewer } from '../../ui/imageViewer'
import { useChatContext } from '../chatContext'
import Button from '../../ui/Button.vue'
import IoBlock from '../../ui/IoBlock.vue'
import { parseToolArgs, resultValue } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const { sessionId } = useChatContext()
const images = computed(() =>
  (props.data.result?.content ?? []).flatMap((block) =>
    block.type === 'image' ? [block.attachment] : [],
  ),
)
function showImage(index: number) {
  openImageViewer({
    owner: sessionId(),
    index,
    items: images.value.map(({ attachmentId }) => ({
      id: attachmentId,
      name: attachmentId,
      src: attachmentRawUrl(attachmentId),
    })),
  })
}
const input = computed(
  () => parseToolArgs(props.data.argsRaw) ?? props.data.argsRaw,
)
const output = computed(() =>
  props.data.result === undefined ? undefined : resultValue(props.data),
)
</script>

<template>
  <IoBlock
    :input="input"
    :output="output"
    :error="data.result?.isError === true"
    tree
  />
  <Button
    v-for="(image, index) in images"
    :key="image.attachmentId"
    class="tool-image"
    type="button"
    :aria-label="`查看第 ${index + 1} 张图片`"
    @click="showImage(index)"
  >
    <img :src="attachmentRawUrl(image.attachmentId)" alt="" loading="lazy" />
  </Button>
  <IoBlock
    v-if="data.subagent || data.externalAgent || data.workflow || data.job"
    :output="data.externalAgent ?? data.subagent ?? data.workflow ?? data.job"
    out-label="历史记录"
    tree
  />
</template>

<style scoped>
.tool-image {
  height: auto;
  display: inline-flex;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.tool-image img {
  max-width: 100%;
  max-height: 180px;
  object-fit: contain;
}
</style>
