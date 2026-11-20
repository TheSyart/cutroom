# 开发与验证

> 文档状态：Active<br>
> 面向读者：桌面与 Core 开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[根脚本](../../package.json)、[桌面脚本](../../desktop/package.json)、[Electron 验收](../../desktop/tests/electron/)

## 运行工程

在 macOS 上使用 Node.js 22 或更新版本。安装依赖后运行启动脚本。原生听写 helper 的完整构建需要对应的 Xcode 和 SDK，具体要求见[根目录安装说明](../../README.md)。

```sh
npm ci
npm --prefix desktop ci
./启动.command
```

Vue 剪辑界面位于 [components/editing](../../desktop/src/renderer/src/components/editing/)，媒体和持久化逻辑位于 [Core editing](../../packages/core/src/editing/)。新增可调用操作时，同步修改 [Core 注册表](../../packages/core/src/api/operations.ts) 并核对桌面来源和数据校验。有关模型配置，见[模型元数据](../design/model-metadata.md)。

## 验证

在根目录运行类型检查、Core 与桌面测试、生产构建。运行真实 Electron 验收前先完成构建。

```sh
npm run typecheck
npm --prefix desktop run typecheck:test
npm test
npm run build
node scripts/check_public_docs.mjs
node desktop/tests/electron/migration-smoke/run.mjs
```

迁移冒烟测试建立临时主目录、旧版密封凭据和 Chromium 状态，启动桌面程序，检查旧目录、新目录、独立配置以及重启结果。剪辑交互和动效导出的入口分别为 `node desktop/scripts/e2e-cu.mjs --mode=editing` 与 `--mode=motion`。使用本机 ffmpeg/ffprobe 检查导出，区分界面断言和实际文件产物。单元测试与发布打包使用不同的入口。

Preview 构建使用 `desktop/electron-builder.preview.cjs`。发布所需的产物核对见[发布包不签名](../release/preview-release-runbook.md#发布包不签名)与[Stable 流程](../release/stable-release-runbook.md)。
