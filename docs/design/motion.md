# 剪辑预览与动效绘制

> 文档状态：Active<br>
> 面向读者：设计者、开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[动效轨](../../desktop/src/renderer/src/components/editing/MotionLane.vue)、[动效工具](../../packages/core/src/editing/motion-tools.ts)、[动效导出](../../packages/core/src/editing/motion-export.ts)

Agent 生成的动效在工作版本中逐步绘制。绘制过程中保留用户接管播放与拖动的入口。整幕完成后并入工程，时间线上的场景支持定位、修剪、拆分和撤销。绑定素材的动效随片段时间移动，独立场景以工程时间定位。

检查动作的开始、结束与遮挡时，使用同一时间点比较播放器与导出画面，覆盖空工程全屏动效、叠加在原片上的场景以及重新打开工程三种情况。
