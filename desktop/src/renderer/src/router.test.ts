import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { installRouteGuards, routeRecords, sessionLocation } from './router'

describe('Cutroom routes', () => {
  it.each([
    ['/', '/editor', {}],
    ['/git', '/editor', {}],
    ['/settings/appearance', '/editor', { settings: 'model' }],
    ['/skills/字幕', '/editor', { settings: 'skills', skill: '字幕' }],
    ['/chat/abc/trajectory', '/editor', { projectSession: 'abc' }],
    ['/tokens', '/editor', { settings: 'tokens' }],
    [
      '/editor?settings=voice&skill=x&page=old&projectSession=a',
      '/editor',
      { settings: 'voice', projectSession: 'a' },
    ],
  ] as const)('resolves %s', async (url, path, query) => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: routeRecords,
    })
    installRouteGuards(router)
    await router.push(url)
    expect(router.currentRoute.value.path).toBe(path)
    expect({ ...router.currentRoute.value.query }).toEqual(query)
  })
  it('opens an editing session by identity', () => {
    expect(sessionLocation('s')).toEqual({
      name: 'editor',
      query: { projectSession: 's' },
    })
  })
})
