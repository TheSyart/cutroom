# Cutroom 版本记录

## [未发布]

- 将最近工程、素材库、多轨时间线、预览、参数检查器、项目 Agent 与导出放在同一个剪辑工作区。
- 支持本地 Whisper 和阿里云 Fun-ASR、字幕编辑、口播与画面精剪、草稿复核及动效绘制。
- 工程持久数据集中在 `.cutroom/`，可重建的代理、缩略图、波形和抽帧归属本机媒体缓存。
- 正式用户配置迁移至 `~/Library/Application Support/Cutroom`，日志迁移至 `~/Library/Logs/Cutroom`。升级过程保留旧版源文件。详见[备份与迁移](../architecture/global-state-store.md)。
