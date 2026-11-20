# Cutroom

![Cutroom · AI 视频剪辑工作台](assets/brand/repository-cover.webp)

Cutroom 是面向 macOS 的开源 AI 视频剪辑工作台。把一段口播拖进时间线，告诉 Agent 要保留什么，确认方案后就能审看和修改剪辑草稿。也可以让 Agent 在预览里逐步画出动效，最后导出 MP4。

[安装与启动](#安装) · [使用手册](docs/user/README.md) · [品牌素材](assets/brand/README.md) · [MIT 许可证](LICENSE)

一个工作区对应一个独立文件夹、一份时间线和一个持久 Build 对话。新工程使用 `timeline.json`，已有工程沿用原来的 `video-edit.json`。

## 功能

### 项目首页

- 启动进入剪映式项目首页：继续最近项目、新建项目或打开已有文件夹。
- 最近项目会与本机 Core 已记录的工程合并；未打开过的工程不显示伪造的素材/片段数量。
- 每个项目只加载自己的 `assets/`，不会与其他项目混合。

### 多轨时间线

- 最多 8 条画面轨（含主轨），上层覆盖下层。独立音轨可承载旁白、配乐和环境声。
- 每个片段保存明确的 `timelineStart`，支持跨轨拖动、按落点插入、拆分、左右修剪和同轨波纹删除；同一轨道内不允许重叠。
- 视频原声随视频片段保留，音频素材可放入独立音轨。片段支持音量、静音和边缘淡入淡出。
- 预览按活动片段分层合成，多路视频原声参与混音；字幕在预览底部实时叠加。
- 字幕轨支持生成、选中、拖动、修剪、修改文本与时间和调整全片字幕样式。画面可按时间加框选和局部放大。

### 本地转写与画面理解

- 默认使用本机 `ffmpeg` 和 `whisper-cli` 转写。可在「设置 › 媒体与转写」启用阿里云北京 Fun-ASR，配置 API Key 与热词。启用时仅向阿里云提交提取的音轨。
- 转写结果随工程保存在 `.cutroom/analysis/`。可重建的预览代理和关键帧存入本机媒体缓存。
- Agent 可通过 `video_transcribe` 读取台词；通过 `video_inspect_frames` 抽取最多 6 张关键帧交给支持视觉的模型。
- 当前模型不支持图片输入时，界面和工具都会明确提示，不会静默失败。

### Cutroom Agent

- 固定在右侧、从顶栏下方贯通到底部的项目 Agent 竖栏；顶栏 Agent 按钮可隐藏/显示整个区域。
- 在对话中告诉 Agent 剪辑要求，它会 按当前工程的口播、录屏和参考资料提出剪辑思路。确认思路后，Agent 在独立草稿完成剪辑、字幕、混音、试渲染和复检，一次性交付可编辑时间线。时间戳原始转写负责找剪口，呈现字幕单独整理。正式交付前重新转写实际渲染的音轨，发现明确的重复、口误或关键原声丢失会返修并重新检查。
- 自主精剪从头到尾按图序查看素材和试渲染，每 0.5 秒取样，补取画面切换，必要时加密回看。时间线上方显示已读范围，可切换「当前工程」和「Agent 草稿」，实时播放草稿并查看最近一次修改。
- 「波纹删除」会切去选中时段并联动前移画面、音轨、字幕和标注。横跨剪口的字幕可按保留原声重新对时。
- 精剪可以暂停后恢复、整次撤销或基于已交付版本局部返修。运行中手剪了工程时，成片草稿与原时间线分别保留。日常聊天可以直接修改当前工程，并支持撤销、重做。
- 右击时间线上的片段、字幕、轨道、时间点或选区，选择「添加到对话」，即可把精确定位信息追加到 Agent 的输入框。
- 在右侧输入框的加号菜单打开「动效绘制」，例如输入「给这句口播画一个工具调用流程」。开关按工程保存，新工程默认关闭。节点、文字、路径逐步出现在播放器里，刚改的对象短暂描边。开始播放或拖动播放头可接管预览，点「跟随绘制」回到最新进度。
- 展开「动效」轨上的场景可定位对象和动作，右击「添加到对话」可指定返修对象。场景可移动、修剪、拆分或撤销。绑定原声的场景跟随对应片段，独立场景使用工程时间。空工程可直接制作并导出全屏动效。绘制中的工作版本在整幕完成后合并成一次修改。
- 参数检查器位于预览与 Agent 之间，可手动收起；窄窗口默认收起。

## 安装

### 系统要求

- macOS（当前只支持 macOS）。
- Node.js 22 或更新版本、npm、macOS Command Line Tools。
- 完整构建 native helper 需要 Xcode 26 或更新版本及对应 macOS SDK。

### 可选：本地媒体分析与 MP4 导出

```bash
brew install ffmpeg-full whisper-cpp
```

带字幕导出需要 FFmpeg 的 `subtitles` 滤镜。Cutroom 会在 Homebrew 的默认安装位置查找完整版。

下载一个 ggml Whisper 模型（推荐 `ggml-small-q5_1.bin`，约 190MB；中文效果比 base 好）：

- 官方模型仓库：<https://huggingface.co/ggerganov/whisper.cpp>
- 参考文件：`ggml-small-q5_1.bin`

启动后打开「设置 › 媒体与转写」，应用会自动检测 `ffmpeg`、`whisper-cli` 和模型；也可以点「选择模型」手动指定 `.bin` 文件。MP4 导出需要 FFmpeg 和 ffprobe。重新定位时间线中使用的视频也需要 ffprobe 校验时长。本地转写另需 whisper.cpp 和模型。阿里云 Fun-ASR 使用加密保存的北京地域 API Key，适合需要逐词时间戳和自定义热词的任务。

### 安装依赖

```bash
git clone https://github.com/TheSyart/cutroom.git
cd cutroom
npm ci
npm --prefix desktop ci
```

macOS 应用包名为 `Cutroom.app`。安装包按 `Cutroom-<version>-macos-<arch>` 命名，预览版文件名在扩展名前附加 `-UNSIGNED-PREVIEW`。

### 启动

双击 [启动.command](启动.command)，或：

```bash
./启动.command
```

启动脚本会构建 native helper、主进程和 renderer，然后打开桌面窗口。首次使用可在「设置 › 剪辑模型」配置模型，也可以直接手动剪辑。已有 Cutroom 配置会在首次启动时迁移。

开发模式：

```bash
npm --prefix desktop run dev
```

## 使用

1. 在项目首页新建项目，或打开含 `timeline.json` 或 `video-edit.json` 的文件夹。
2. 用「导入素材」多选视频、音频或图片。文件会复制到项目 `assets/` 。自主精剪也能索引工程文件夹中支持的媒体和文字参考资料。
3. 把素材双击或拖入时间线；拖动片段可跨轨或改变开始时间。
4. 选中片段后在右侧检查器调整源入点/出点、画面、变速、原声；选中字幕时编辑字幕。
5. 点时间线工具栏「字幕」按媒体分析设置生成字幕。当前片段模式只更新选区内的字幕。
6. 在右侧 Agent 输入剪辑要求，检查并确认剪辑思路。等待收到可播放草稿，也可在这之前手动剪辑。
7. 顶栏点「导出 MP4」，选择保存位置。输出为 1920×1080、30 fps、H.264/AAC，包含多轨画面、混合原声和烧录字幕。

快捷键：`Space` 播放/暂停，`Delete`/`Backspace` 删除选中的片段或字幕，`Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z` 重做。

## 工程与数据

```text
MyEdit/
  timeline.json                   # 新工程的时间线
  source-notes.json               # 按源时间保存的素材认知
  editing-brief.md                # 对话中确认的剪法
  assets/                         # 项目独立素材副本
  .cutroom/                       # 工程身份、修订、转写、动效、精剪草稿及项目 Skills
  exports/                        # 工程内的导出文件，也可另选保存位置
```

复制整个工程文件夹时请包含隐藏目录 `.cutroom`。打开旧工程后，Cutroom 将 `.video-edit-agent` 中的持久数据迁移到 `.cutroom`，保留旧目录用于恢复。复制工程前的自动审批与本机签名密钥有关，换机器或缺少原密钥时需重新确认。

| 位置                                            | 内容                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `~/Library/Application Support/Cutroom`         | 模型与语音设置、本机密钥、会话、Token 记录、用户 Skills、界面偏好      |
| `~/Library/Caches/com.video-edit-agent.desktop` | 按工程组织的可重建媒体缓存。设置中的「媒体与转写」可查看占用与清理缓存 |
| `~/Library/Logs/Cutroom`                        | 正式应用日志                                                           |

首次启动会从旧版 `~/Library/Application Support/Video Edit Agent` 校验并复制需要的数据。保留旧配置，待新版运行验证后再自行归档。显式设置 `CUTROOM_DATA_DIR` 可启动隔离配置，适用于试剪和测试。`CUTROOM_CACHE_DIR` 可指定独立的媒体缓存位置。

波形和抽帧在本机完成。转写按设置走本机 Whisper 或阿里云 Fun-ASR。Agent 可以将转写文本交给当前模型。发送关键帧前，审批卡会显示素材、时间点和接收模型。素材失联时可继续打开工程，并在素材面板重新定位。

## 架构摘要

```text
Vue renderer                        Electron main / preload
┌─────────────────────────┐         ┌─────────────────────────┐
│ EditorPage              │  core() │ preload IPC             │
│ 素材 / 预览 / 检查器     │ ──────> │ CoreApi                 │
│ 时间线 / 字幕 / Agent    │         │  ├─ VideoProjectService  │
└─────────────────────────┘         │  ├─ VideoAnalysisService │
                                    │  ├─ HarnessHost / Agent  │
                                    │  └─ 工程 JSON / 分析缓存  │
                                    └─────────────────────────┘
```

- 工程命令、布局、迁移和持久化在 `packages/core/src/editing/`。
- 本地分析在 `packages/core/src/editing/analysis/`。
- Agent 专用工具在 `packages/core/src/editing/tools.ts`，由 `HarnessHost.installVideoProjectTools()` 注册。
- 剪辑 UI 在 `desktop/src/renderer/src/components/editing/`。
- 设置页在 `desktop/src/renderer/src/components/settings/mediaAnalysis/`。

完整开发指南见 [docs/development/README.md](docs/development/README.md)。

## 开发与验证

```bash
npm run typecheck
npm --prefix desktop run typecheck:test
npm --prefix desktop run lint
npm --prefix desktop run test
npm run build
```

真实 Electron 验收使用临时数据目录和本地脚本模型，不读取真实用户 profile，也不调用付费模型：

```bash
cd desktop
node scripts/e2e-cu.mjs --mode=editing
node scripts/e2e-cu.mjs --mode=motion
node tests/electron/migration-smoke/run.mjs
```

- `editing` 覆盖项目首页、素材导入、播放、多轨叠加、字幕生成/编辑、拆分/修剪/删除、参数、撤销/重做、Agent 审批和本地转写、重启恢复，以及实际拖拽、短距离定位、离线素材重新定位和 MP4 导出。
- `motion` 在 Electron 中录制绘制过程，记录工具收件到上屏的耗时，重开工程后导出 MP4 并比对预览关键帧。默认使用本地脚本模型。显式提供 `CUTROOM_MOTION_REAL_PROFILE` 可用已有配置进行真实模型验收，会产生模型调用。口播用例接受 `CUTROOM_MOTION_SPEECH` 和对应的 Whisper 词级时间戳 `CUTROOM_MOTION_TRANSCRIPT`。产物位于 `desktop/out-e2e/motion/`。
- 视觉基线使用 `npm --prefix desktop run visual:baselines` 比对，界面有意变化时用 `visual:baselines:update` 更新。

## 当前边界

自主精剪以自然口播和录屏教程为主要工作流，需要能调用工具并读图的模型。多机位同步、自由关键帧、复杂视觉特效和录制采集暂未提供。详细设计见 [DESIGN.md](DESIGN.md)。

## 安装包与发布说明

公开安装包不做代码签名，Preview 版本用于提前测试，**不是 Stable**。未签名版本的安全核验见 [未签名版本安全说明](docs/release/unsigned-preview-notice.md)。本地打包可用 Python 3.11 执行 `npm --prefix desktop run package:verify`。独立更新源上线前，应用内更新保持关闭。

## 文档

- [开发指南](docs/development/README.md)
- [项目设计](DESIGN.md)
- [文档中心](docs/README.md)
- [未签名版本安全说明](docs/release/unsigned-preview-notice.md)

## 来源与许可

Emperor Agent `release/0.2`，提交 `15d89ab38790e5174401179298ea8f35b3ac9a82`，桌面版本 0.2.1。上游许可证见 [LICENSE](LICENSE)。Agent Loop、Core IPC 和 Vue 对话实现沿用上游架构；剪辑工程通过现有 Core operations 接入。剪辑面板此前参考 MIT 许可的 [DogSC](https://github.com/laogou717/dogsc)，视觉与交互参考用户提供的剪映截图，未使用其素材、图标、商标或代码。
