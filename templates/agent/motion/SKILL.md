# 工程动效制作

项目已开启动效工具。需要图解观点、演示过程、突出屏幕动作或回应用户的动效要求时，把画面编入当前时间线。保持原声、已有字幕和用户指定的风格。以 1920×1080 作为动效设计坐标，时间轴为 30 fps。

## 从口播和源画面确定时间

在普通编辑中读取 video_project_read；精剪中读取 video_analyze_workspace、观察记录和实际源画面，先取得剪辑思路批准。确定动作对应的句子、实际关键词、源片段 ID、源时间、剪后时间和需要避让的人脸、手势或代码区域。有真实时间证据再绑定 anchor.clipId 和 anchor.sourceTime。字幕句边只支持句级落点。用户要求全屏图解时使用 fullscreen，保留人物或屏幕时使用透明 overlay。先剪掉的语句无需制作动画。

在 story 写清这一小段要解释的关系、主体起点与终点、触发动作的原声、结果停留和转场承接物。持续出现的任务单、节点、数字或界面组件可沿用同一对象 ID。每个时刻突出一个主要变化，让拆分、传递、对齐、缩放或划除解释内容。给观众读完结果的时间。图表共用真实数据，模拟产品画面标注为示意；截图、字幕和大字分担信息。

## 按对象在预览中画出来

1. 用 video_motion_read 读取待修改对象及版本。用 video_motion_begin 建立一个场景。新场景 expectedVersion=0，修订沿用现有 ID 和版本。普通工程提供 expectedRevision；精剪提供 runId 与 expectedGeneration。
2. 每完成一个可理解的对象就立即调用 video_motion_object，将 HTML、SVG 或 canvas 内容、draw 函数体、bounds 和文字标记一起提交。不要等整场做完才把所有东西塞进一个对象。按主体、解释关系、结果的顺序构建；修改某个对象时用其原 ID，其他对象保留。每次请求使用上一步返回的 workId 和最新 seq 作为 expectedSeq。
3. bounds 是对象外层在画布中的 x/y/width/height。内部 HTML 使用局部坐标。draw 接收 root、秒 t、整数 frame 和本地 gsap。t 与 frame 属于场景源时钟，包含修剪后的 sourceInFrame；markers.frame 也是这个时钟。工具可另传绝对工程帧 frame，定位用户正在看的制作步骤；endFrame 可限定本次局部试播的结束帧（不含）。编号勿混用。
4. 每次采样都要从给定时间完整算出属性。可用 gsap.set 或建立 paused:true 的时间线并显式 seek(t)。canvas 每帧清空后重画。使用 root.querySelector 寻找当前对象的子元素。保留字幕安全区；透明叠加物默认只占讲解需要的面积。无需联网；图片材料仅用工程内容的内嵌 data URI。避免外部资源、系统 API、网络、定时器、播放历史、实时钟和未固定的随机布局。图表、连线、路径或数值优先用代码绘制。

例如将一条路径画到原声落点，可给 path 设置 pathLength="1"、stroke-dasharray="1"，然后在 draw 内执行：

    const p = Math.max(0, Math.min(1, (t - 0.2) / 0.65));
    root.querySelector('path').style.strokeDashoffset = String(1 - p);

5. 阅读结果的停留帧、峰值动作和对象交接处应可任意跳转。完成后调用 video_motion_finish，把场景写成一个可撤销修改或加入获批精剪草稿。用户取消或设计放弃时用 video_motion_cancel。若渲染出错，先根据报错修正代码，再按当前版本重建。精剪草稿仍需运行 video_review_draft 并检查渲染画面；专门检查转场前中后和字幕遮挡，再走正常交付流程。
