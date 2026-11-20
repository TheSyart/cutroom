# Preview 发布手册

> 文档状态：Active<br>
> 面向读者：维护者<br>
> 最后核验：2026-11-20<br>
> 事实源：[Preview 工作流](../../.github/workflows/release-preview.yml)、[打包配置](../../desktop/electron-builder.preview.cjs)

Preview 标签格式为 `v<version>-preview.<n>`。核对计划发布的默认分支提交、版本与 annotated tag。进入发布流程前先验证编辑器、导出和旧配置迁移；实际支持的 macOS 架构以工作流矩阵为准。

## 发布包不签名

Preview 文件名包含 `UNSIGNED-PREVIEW`。macOS 产物不带 Developer ID 签名和 Apple 公证，用户通过 `SHA256SUMS.txt` 核对文件，用 `gh attestation verify <文件> --repo <实际的拥有者/仓库>` 验证有构建证明的产物。发布说明必须给出初次打开时的单应用确认步骤。[Apple 的应用打开说明](https://support.apple.com/en-us/102445)

## 产物核对

核对每个架构的 DMG、ZIP、版本、摘要和构建来源。用独立配置启动相应的应用，验证素材导入和导出。发布时附上本次的[未签名说明](unsigned-preview-notice.md)。Stable 使用独立的[发布手册](stable-release-runbook.md)。
