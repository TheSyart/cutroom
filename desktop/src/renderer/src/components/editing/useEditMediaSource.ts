import { onBeforeUnmount, ref, watch } from 'vue'
import type { VideoAsset } from '@emperor/core/editing'
import { invokeCore } from '../../api/backend'

type Target = {
  sessionId: string
  asset: VideoAsset
  posterTime?: number
  posterEnd?: number
}
type Kind = 'poster' | 'playback'
type Prepared = { path: string; proxy: boolean }
const preparing = new Map<string, Promise<Prepared>>()
const recentProxies = new Map<string, { path: string; expires: number }>()

function sourceKey({ sessionId, asset }: Target) {
  return JSON.stringify([
    sessionId,
    asset.id,
    asset.path,
    asset.duration,
    asset.width,
    asset.height,
  ])
}

function prepare(target: Target, kind: Kind, force: boolean) {
  const { asset, sessionId } = target
  const key = JSON.stringify([
    sessionId,
    asset.id,
    asset.path,
    kind,
    force,
    target.posterTime,
    target.posterEnd,
  ])
  let pending = preparing.get(key)
  if (!pending) {
    pending = invokeCore('videoProject.previewMedia', {
      sessionId,
      assetId: asset.id,
      kind,
      force,
      ...(target.posterEnd !== undefined
        ? { posterEnd: target.posterEnd }
        : {}),
      ...(target.posterTime !== undefined
        ? { posterTime: target.posterTime }
        : {}),
    })
    preparing.set(key, pending)
    void pending.finally(() => preparing.delete(key)).catch(() => undefined)
  }
  return pending
}

export function useEditMediaSource(
  target: () => Target | null,
  kind: Kind,
  preserveCurrentPlayback: () => boolean = () => false,
) {
  const path = ref('')
  const pending = ref(false)
  const failure = ref('')
  let generation = 0
  let usedProxy = false
  let forced = false
  let preparedPath = ''

  async function load(force = false) {
    const current = target()
    const version = ++generation
    path.value = ''
    preparedPath = ''
    failure.value = ''
    pending.value = false
    if (!current) return
    if (
      current.asset.kind !== 'video' &&
      !(
        kind === 'poster' &&
        current.asset.kind === 'audio' &&
        current.posterTime !== undefined
      )
    ) {
      path.value = current.asset.path
      return
    }
    const key = sourceKey(current)
    if (kind === 'playback' && !force) {
      const recent = recentProxies.get(key)
      usedProxy = Boolean(recent && recent.expires > Date.now())
      path.value = usedProxy ? recent!.path : current.asset.path
    }
    pending.value = true
    try {
      const result = await prepare(current, kind, force)
      if (kind === 'playback' && result.proxy) {
        if (recentProxies.size >= 32)
          recentProxies.delete(recentProxies.keys().next().value!)
        recentProxies.set(key, {
          path: result.path,
          expires: Date.now() + 300_000,
        })
      }
      if (version !== generation) return
      if (
        kind === 'playback' &&
        !force &&
        result.proxy &&
        preserveCurrentPlayback()
      )
        preparedPath = result.path
      else {
        usedProxy = result.proxy
        path.value = result.path
      }
    } catch (error) {
      if (version !== generation) return
      if (kind === 'playback' && !force) {
        recentProxies.delete(key)
        usedProxy = false
        path.value = current.asset.path
      } else
        failure.value = error instanceof Error ? error.message : String(error)
    } finally {
      if (version === generation) pending.value = false
    }
  }

  function recover(): boolean {
    const current = target()
    if (kind !== 'playback' || forced || current?.asset.kind !== 'video')
      return false
    forced = true
    if (usedProxy) {
      recentProxies.delete(sourceKey(current))
      generation++
      usedProxy = false
      pending.value = false
      path.value = current.asset.path
      return true
    }
    if (preparedPath) {
      usedProxy = true
      path.value = preparedPath
      preparedPath = ''
      return true
    }
    void load(true)
    return true
  }

  watch(
    () => {
      const current = target()
      return current
        ? JSON.stringify([
            current.sessionId,
            current.asset.id,
            current.asset.kind,
            current.asset.path,
            current.asset.width,
            current.asset.height,
            current.posterTime,
            current.posterEnd,
          ])
        : ''
    },
    () => {
      forced = false
      usedProxy = false
      void load()
    },
    { immediate: true },
  )
  watch(preserveCurrentPlayback, (preserve) => {
    if (preserve || !preparedPath) return
    usedProxy = true
    path.value = preparedPath
    preparedPath = ''
  })
  onBeforeUnmount(() => {
    generation++
  })
  return { path, pending, failure, recover }
}
