# Stable 发布手册

> 文档状态：Active<br>
> 面向读者：维护者<br>
> 最后核验：2026-11-20<br>
> 事实源：[Stable 工作流](../../.github/workflows/release.yml)、[发布契约](../../scripts/release-contract.mjs)

Stable 标签使用 `v<version>`。按 `.github/workflows/release.yml` 构建 macOS arm64 和 x64 的 DMG 与 ZIP，检查完整的签名状态、产物摘要、SBOM、构建证明与应用冒烟回执。

可从已有本机构建产物运行 `scripts/release-dry-run.mjs` 核对候选包和正文。单架构演练无法代表两种架构的发布结果。实际发布正文从 [stable-release-notes.md](stable-release-notes.md) 渲染，第一段保留初次打开和摘要核对步骤。[发布包不签名](preview-release-runbook.md#发布包不签名)

## 不签名不等于不封签

打包器的本机完整性封签和开发者身份签名服务于不同的校验。核对打包验证回执，确保说明与本次产物一致。未经签名和公证的版本按[未签名安装说明](unsigned-preview-notice.md)交付。
