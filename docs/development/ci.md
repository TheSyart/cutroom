# 本地与 CI 验证入口

> 文档状态：Active<br>
> 面向读者：维护者<br>
> 最后核验：2026-11-20<br>
> 事实源：[CI 工作流](../../.github/workflows/ci.yml)、[构建脚本](../../package.json)

开发环境可按[开发与验证](README.md)运行类型检查、测试、构建和 Electron 验收。修改公开文档时运行 `node scripts/check_public_docs.mjs`。修改配置读写时，加跑旧配置迁移冒烟测试。修改媒体导出时检查实际生成的 MP4，并核对视频时长、画面与音频。

构建本机应用时使用 `npm --prefix desktop run package:verify`。发布标签、签名状态和清单格式见[发布流程](../release/stable-release-runbook.md)。本地构建与测试的成功状态应与发布渠道中的实际产物分别记录。
