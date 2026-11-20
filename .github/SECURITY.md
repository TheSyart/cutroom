# Cutroom 安全问题报告

> 文档状态：Active<br>
> 面向读者：用户、维护者、安全研究者<br>
> 最后核验：2026-11-20<br>
> 事实源：[桌面主进程](../desktop/src/main/)、[公开 Core 操作](../packages/core/src/api/operations.ts)、[存储与迁移](../docs/architecture/global-state-store.md)

请向提供这份 Cutroom 构建的维护者私下报告安全问题。在托管仓库已启用私密漏洞报告时，可使用该仓库的 Security 页面。离线分发时可通过交付渠道联系维护者索取私密报告方式。

请附上受影响的版本、macOS 版本与架构、触发条件、可用临时工程复现的步骤和预期结果。可报告桌面 IPC 的权限、项目范围外读写、密钥或会话泄漏、未经确认的外发、本机文件/缓存处理与发布产物完整性等问题。

分享前移除密钥、真实用户名、会话正文、私人素材和路径。可用临时配置与虚构素材复现问题，见[存储与隔离启动](../docs/architecture/global-state-store.md)。
