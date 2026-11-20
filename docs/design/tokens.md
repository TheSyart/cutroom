# 主题与设计令牌

> 文档状态：Active<br>
> 面向读者：设计者、开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[主题目录](../../desktop/src/renderer/src/theme/)、[编辑组件](../../desktop/src/renderer/src/components/editing/)

基础色板、间距、字号和动效时长定义在 `primitives.css`。浅色和深色语义在 `semantic.light.css` 与 `semantic.dark.css` 对应维护，共享组件令牌在 `components.css`。编辑器的轨道、片段与选区也有专用样式。调整主题时同时检视首页、编辑器和设置弹层，并检查切换主题后正文与选中状态仍清楚可辨。
