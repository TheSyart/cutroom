# 颜色与状态区分

> 文档状态：Active<br>
> 面向读者：设计者、开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[深色语义](../../desktop/src/renderer/src/theme/semantic.dark.css)、[浅色语义](../../desktop/src/renderer/src/theme/semantic.light.css)

使用 `--surface-canvas`、`--surface-base` 与 `--surface-overlay` 区分窗口、面板和浮层。正文、次要描述与不可用操作需要各自的文字层级。键盘焦点使用可见的焦点环。时间线上应能区分素材片段、选中片段、播放头和离线素材。错误或离线状态同时给出文字提示。
