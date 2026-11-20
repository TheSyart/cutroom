# 弹层与操作焦点

> 文档状态：Active<br>
> 面向读者：设计者、开发者<br>
> 最后核验：2026-11-20<br>
> 事实源：[设置弹层](../../desktop/src/renderer/src/components/settings/SettingsModal.vue)、[共享控件](../../desktop/src/renderer/src/components/ui/)

打开设置后，焦点进入弹层。左栏选择分区，标题区可从子页返回，关闭后回到原先的工作位置。编辑未保存的设置时，离开操作需要经过已有的变更确认逻辑。文件选择与导出位置由系统对话框负责。检查键盘导航、取消、确认及设置关闭后播放头和工程选择是否保留。
