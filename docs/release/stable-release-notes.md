<!-- Cutroom Stable release body, rendered by scripts/release-contract.mjs. -->

**Cutroom {{version}} 安装包未签名，未经 Apple 公证。** 请先用 `SHA256SUMS.txt` 核对下载的文件。把 Cutroom 拖到「应用程序」并打开。如果 macOS 拦截，进入「系统设置 › 隐私与安全性」，对 Cutroom 选择「仍要打开」。

## 下载与核验

Apple 芯片选择 `Cutroom-{{version}}-macos-arm64`，Intel Mac 选择 `Cutroom-{{version}}-macos-x64`。每种架构提供 DMG 与 ZIP。按相应文件名核对摘要，若当前发布提供 GitHub 构建证明，可运行 `gh attestation verify <文件> --repo <实际的拥有者/仓库>` 核对来源。同批次的依赖清单为 `Cutroom-{{tag}}.cdx.json`。

<!-- emperor-release electron={{electron}} -->
