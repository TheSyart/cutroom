# 存储、备份与迁移

> 文档状态：Active<br>
> 面向读者：用户、开发者、支持人员<br>
> 最后核验：2026-11-20<br>
> 事实源：[用户配置迁移](../../packages/core/src/runtime/cutroom-profile-migration.ts)、[工程布局](../../packages/core/src/editing/project-layout.ts)、[媒体缓存](../../packages/core/src/editing/media-cache.ts)、[桌面配置](../../desktop/src/main/config.ts)

## 复制、备份工程

复制整个工程文件夹，包括隐藏的 `.cutroom/`、素材副本 `assets/`、时间线以及导出的文件。新工程写入 `timeline.json`。旧工程可以继续使用 `video-edit.json`。编辑草稿、版本与撤销依据、转写结果和项目 Skills 随 `.cutroom/` 移动。已导出到其他位置的成片需要单独备份。

首次打开旧工程时，程序将 `.video-edit-agent/` 中的持久数据及旧项目的 `.emperor/skills/` 校验复制到 `.cutroom/`。源目录保留。新旧目录之间有冲突时会提示处理。预览代理与抽帧可以重建。与本机签名绑定的既有精剪授权需要原来的 `precision-run.key`，移动机器或恢复配置时应一并保管。

## 本机数据

| 位置                                            | 包含的内容                                                                                                                   | 备份方式                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `~/Library/Application Support/Cutroom`         | 模型与转写设置、加密密钥、精剪签名密钥、会话、附件、Token 记录、用户 Skills、项目索引、界面偏好及存放在配置内的 Whisper 文件 | 退出应用后复制整个目录。单独复制模型配置无法恢复其加密凭据。 |
| `~/Library/Caches/com.video-edit-agent.desktop` | 按配置与工程分隔的代理、缩略图、波形、抽帧                                                                                   | 可重建。在「设置 › 媒体与转写 › 媒体缓存」清理。             |
| `~/Library/Logs/Cutroom`                        | 正式配置的桌面与 Core 日志                                                                                                   | 仅在排查时保留需要的日志。                                   |

持久转写 JSON 位于工程的 `.cutroom/analysis/transcripts/`。每个配置的可重建媒体缓存在缓存根下按配置路径哈希、工程路径哈希、类别建立子目录，类别为 `proxies/`、`thumbnails/`、`waveforms/` 和 `frames/`。

最近工程保存的是访问位置。备份项目索引无法替代工程目录。如果 Whisper 模型放在配置目录之外，请另外复制该文件，并在新电脑的「设置 › 媒体与转写 › Whisper 模型」重新选择。用户安装的 Skills 位于本机配置内，项目专用 Skills 位于工程内。

## 旧版配置升级

1. 退出旧版 Video Edit Agent。默认启动时，Cutroom 检查 `~/Library/Application Support/Video Edit Agent`。显式指定数据目录的实例只使用指定目录。
2. 迁移器取得写锁，在同一磁盘暂存并校验副本。旧版 `computer-use/secrets/local.key` 的保留用途是解密凭据，迁移后位置为 `secrets/local.key`。密封的模型和 Fun-ASR 凭据经解密验证后才发布新目录。旧版文件保留原位置。
3. 在新版中检查最近工程、会话、模型、转写设置和主题。再次启动时，已完成的迁移由回执识别。首次复制中断时，下一次启动会核对暂存目录归属并重试。旧版与新版同时写入时会阻止迁移。

如果新旧两个配置目录都有数据且缺少迁移回执，请先退出应用，分别备份。核对后将需要保留但本次不使用的整份配置移到另外的位置，再启动。请勿混合两份 `local.key`、加密设置与精剪签名文件。找不到原密钥时，保留原始数据，恢复对应备份后重试。上游 Emperor 的个人配置不属于自动迁移源。

## 隔离启动

在启动前设置 `CUTROOM_DATA_DIR` 指定独立配置，必要时再设置 `CUTROOM_CACHE_DIR` 指定缓存根。试用配置的日志保存在 `<数据目录>/logs/`。兼容别名按 `CUTROOM_DATA_DIR`、`VIDEO_EDIT_AGENT_DATA_DIR`、`EMPEROR_CONFIG_DIR` 的顺序选择。不要将试用配置指向现有工作数据目录。
