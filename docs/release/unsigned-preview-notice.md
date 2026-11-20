# Cutroom {{tag}} · UNSIGNED-PREVIEW / 未签名预览版

> 文档状态：Active<br>
> 面向读者：macOS 用户<br>
> 最后核验：2026-11-20<br>
> 事实源：[Preview 构建配置](../../desktop/electron-builder.preview.cjs)、[发布工作流](../../.github/workflows/release-preview.yml)

安装包没有 Apple Developer ID 签名，也未经 Apple 公证。选择与本机架构对应的 macOS DMG 或 ZIP，从提供这次 Cutroom 构建的渠道取得文件及配套清单。

1. 将下载文件与同一次发布的 `SHA256SUMS.txt` 对照，在终端用 `shasum -a 256 <文件>` 核对摘要。
2. 对于由 GitHub Actions 发布且带有构建证明的产物，使用 `gh attestation verify <文件> --repo <实际的拥有者/仓库>` 核对来源。仓库名称应来自这次 Cutroom 发布页。
3. 将 Cutroom 拖到「应用程序」并打开。若 macOS 拦截，在核验来源后打开「系统设置 › 隐私与安全性」，对 Cutroom 选择「仍要打开」。保留系统全局防护设置。[Apple 的应用打开说明](https://support.apple.com/en-us/102445)

使用本机听写时，系统可能询问麦克风和语音识别权限，可在「设置 › 语音输入」检查。导入已有媒体文件和本地转写使用另一条流程，参见[第一次剪辑](../user/getting-started.md)。
