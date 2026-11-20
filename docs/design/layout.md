# 剪辑工作区布局

> 文档状态：Active<br>
> 面向读者：设计者、开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[EditorPage](../../desktop/src/renderer/src/components/editing/EditorPage.vue)

项目首页负责选择工程。打开工程后，顶栏提供工程级操作。素材库、播放器、参数检查器、时间线与工程 Agent 使用同一工程上下文。宽窗口中时间线与画面预览可同时查看，Agent 栏可独立切换。调整窄窗口时优先保障预览和时间线，检查收起的检查器仍可被用户重新打开。
