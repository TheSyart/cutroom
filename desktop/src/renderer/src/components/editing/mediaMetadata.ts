import type { VideoAsset } from '@emperor/core/editing'
import { core } from '../../api/http'

export interface LocalMediaMetadata {
  duration: number | null
  width: number | null
  height: number | null
}

/** Read metadata through Core's expiring media grant, never a raw file:// URL. */
export async function readLocalMediaMetadata(
  sessionId: string,
  asset: VideoAsset,
  timeoutMs = 15_000,
): Promise<LocalMediaMetadata> {
  const { url } = await core('files.mediaUrl', {
    source: 'project',
    sessionId,
    path: asset.path,
  })
  return new Promise<LocalMediaMetadata>((resolve, reject) => {
    const media = document.createElement(
      asset.kind !== 'image' ? 'video' : 'img',
    )
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      media.removeAttribute('src')
      action()
    }
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`读取 ${asset.displayName} 的媒体信息超时。`)),
        ),
      timeoutMs,
    )
    media.addEventListener(
      'error',
      () =>
        finish(() =>
          reject(
            new Error(`无法读取 ${asset.displayName}，可能是不受支持的编码。`),
          ),
        ),
      { once: true },
    )
    if (media instanceof HTMLVideoElement) {
      media.preload = 'metadata'
      media.addEventListener(
        'loadedmetadata',
        () => {
          const metadata = {
            duration: media.duration,
            width: asset.kind === 'audio' ? null : media.videoWidth,
            height: asset.kind === 'audio' ? null : media.videoHeight,
          }
          if (
            !Number.isFinite(metadata.duration) ||
            metadata.duration <= 0 ||
            (asset.kind !== 'audio' && (!metadata.width || !metadata.height))
          ) {
            finish(() =>
              reject(new Error(`${asset.displayName} 没有有效的视频信息。`)),
            )
            return
          }
          finish(() => resolve(metadata))
        },
        { once: true },
      )
    } else {
      media.addEventListener(
        'load',
        () => {
          const metadata = {
            duration: null,
            width: media.naturalWidth,
            height: media.naturalHeight,
          }
          if (metadata.width <= 0 || metadata.height <= 0) {
            finish(() =>
              reject(new Error(`${asset.displayName} 没有有效的图片尺寸。`)),
            )
            return
          }
          finish(() => resolve(metadata))
        },
        { once: true },
      )
    }
    media.src = url
    if (media instanceof HTMLVideoElement) media.load()
  })
}
