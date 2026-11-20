/** Read the decoded media synchronously, before playback advances to another frame. */
export function capturePreviewFrame(
  monitor: HTMLElement,
  time: number,
): Promise<File> {
  const bounds = monitor.getBoundingClientRect()
  if (!bounds.width || !bounds.height) throw new Error('播放器尚未就绪。')
  if (
    monitor.querySelector(
      '.monitor-empty, .media-error, [data-preview-active="true"] .layer-status',
    )
  )
    throw new Error('当前帧尚未就绪，请等待播放器显示画面。')
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = Math.round((canvas.width * bounds.height) / bounds.width)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法读取当前帧。')
  ctx.scale(canvas.width / bounds.width, canvas.height / bounds.height)
  ctx.translate(-bounds.x, -bounds.y)
  ctx.fillStyle = getComputedStyle(monitor).backgroundColor
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)

  function drawMedia(el: HTMLVideoElement | HTMLImageElement) {
    const video = el instanceof HTMLVideoElement
    if (video ? el.readyState < 2 || el.seeking : !el.complete)
      throw new Error('当前帧正在加载，请稍后重试。')
    const width = video ? el.videoWidth : el.naturalWidth
    const height = video ? el.videoHeight : el.naturalHeight
    if (!width || !height) throw new Error('当前帧尚未解码。')
    const box = el.getBoundingClientRect()
    const ratio =
      getComputedStyle(el).objectFit === 'cover'
        ? Math.max(box.width / width, box.height / height)
        : Math.min(box.width / width, box.height / height)
    const w = width * ratio,
      h = height * ratio
    ctx!.save()
    ctx!.beginPath()
    ctx!.rect(box.x, box.y, box.width, box.height)
    ctx!.clip()
    ctx!.drawImage(
      el,
      box.x + (box.width - w) / 2,
      box.y + (box.height - h) / 2,
      w,
      h,
    )
    ctx!.restore()
  }

  const layers = [
    ...monitor.querySelectorAll<HTMLElement>('[data-preview-active="true"]'),
  ].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex))
  for (const layer of layers) {
    const media = layer.querySelector<HTMLVideoElement | HTMLImageElement>(
      'video, img',
    )
    if (media) drawMedia(media)
  }
  for (const scene of monitor.querySelectorAll<HTMLElement>(
    '.motion-stack .motion-image',
  )) {
    const bitmap = scene.querySelector('img')
    if (!bitmap) throw new Error('动效帧正在绘制，请稍后重试。')
    drawMedia(bitmap)
  }
  for (const annotation of monitor.querySelectorAll<HTMLElement>(
    '.annotation-box',
  )) {
    const box = annotation.getBoundingClientRect()
    const style = getComputedStyle(annotation)
    ctx.lineWidth = parseFloat(style.borderTopWidth)
    ctx.strokeStyle = style.borderTopColor
    const inset = ctx.lineWidth / 2
    ctx.strokeRect(
      box.x + inset,
      box.y + inset,
      box.width - 2 * inset,
      box.height - 2 * inset,
    )
  }
  const caption = monitor.querySelector<HTMLElement>('.subtitle-overlay span')
  if (caption) {
    const style = getComputedStyle(caption)
    const box = caption.getBoundingClientRect()
    ctx.fillStyle = style.backgroundColor
    ctx.fillRect(box.x, box.y, box.width, box.height)
    ctx.font = [
      style.fontStyle,
      style.fontWeight,
      style.fontSize,
      style.fontFamily,
    ].join(' ')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = style.color
    ctx.strokeStyle = style.webkitTextStrokeColor
    const stroke = parseFloat(style.webkitTextStrokeWidth)
    const lineHeight = parseFloat(style.lineHeight)
    for (const [i, line] of (caption.textContent ?? '').split('\n').entries()) {
      const x = box.x + box.width / 2
      const y = box.y + parseFloat(style.paddingTop) + (i + 0.5) * lineHeight
      if (stroke > 0) {
        ctx.lineWidth = stroke
        ctx.strokeText(line, x, y)
      }
      ctx.fillText(line, x, y)
    }
  }
  const name = '预览帧-' + Math.round(time * 1000) + 'ms.png'
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], name, { type: 'image/png' }))
      else reject(new Error('无法保存当前帧。'))
    }, 'image/png'),
  )
}
