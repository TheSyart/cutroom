# 剪辑工作区架构

> 文档状态：Active<br>
> 面向读者：开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[编辑器](../../desktop/src/renderer/src/components/editing/)、[Core operations](../../packages/core/src/api/operations.ts)、[剪辑实现](../../packages/core/src/editing/)

用户从项目首页选择一个工程目录。编辑器按工程绑定素材、时间线、预览、参数检查器和一个持久项目会话。renderer 通过 preload 访问具名 Core 操作。主进程负责系统文件对话框、信任来源检查、本机播放及导出入口。

`videoProject.open` 打开工程并解析布局。手动编辑和 Agent 的剪辑工具使用相同的工程命令和修订数据。素材、片段、字幕和动效的引用以工程对象与时间范围表达。精剪在独立草稿中准备修改，经审核后交付，可保留同时发生的手动编辑。

`chat.submit` 将消息送入 Core 会话。运行事件回传给同一工程的 Agent 栏。模型数据由 Core 管理。转写服务按设置调用本机工具或 Fun-ASR，关键帧交付遵守审批约束。涉及持久化变化时，请先对照[存储布局](global-state-store.md)及[开发验证](../development/README.md)。
