import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type Ref,
} from 'vue'
import { useResizable } from '../../composables/useResizable'

const STORAGE_KEY = 'cutroom.editor.layout.v1'
const GUTTER = 6
const LIBRARY_MIN = 220
const SIDE_MIN = 300
const PREVIEW_MIN = 360
const TIMELINE_MIN = 170

interface LayoutPreferences {
  libraryWidth: number
  sideWidth: number
  timelineHeight: number | null
  libraryOpen: boolean
  sideOpen: boolean
}

function readPreferences(): LayoutPreferences {
  const defaults: LayoutPreferences = {
    libraryWidth: 260,
    sideWidth: 400,
    timelineHeight: null,
    libraryOpen: true,
    sideOpen: true,
  }
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return defaults
    for (const key of ['libraryWidth', 'sideWidth', 'timelineHeight'] as const)
      if (Number.isFinite(saved[key]) && saved[key] > 0)
        defaults[key] = saved[key]
    for (const key of ['libraryOpen', 'sideOpen'] as const)
      if (typeof saved[key] === 'boolean') defaults[key] = saved[key]
  } catch {
    /* Storage is optional, including in browser previews. */
  }
  return defaults
}

export function useEditorLayout(body: Ref<HTMLElement | null>) {
  const preferences = reactive(readPreferences())
  function persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
    } catch {
      /* Keep the current layout if storage is unavailable. */
    }
  }

  const viewportWidth = ref(window.innerWidth)
  const availableWidth = ref(window.innerWidth - 12)
  const availableHeight = ref(window.innerHeight - 49)
  const measure = () => {
    viewportWidth.value = window.innerWidth
    availableWidth.value = body.value?.clientWidth || window.innerWidth - 12
    availableHeight.value = body.value?.clientHeight || window.innerHeight - 49
  }
  onMounted(() => window.addEventListener('resize', measure))
  onBeforeUnmount(() => window.removeEventListener('resize', measure))
  watch(
    body,
    (element, _, onCleanup) => {
      if (!element) return
      measure()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      onCleanup(() => observer.disconnect())
    },
    { flush: 'post' },
  )

  const layout = computed(() =>
    viewportWidth.value >= 1200
      ? 'wide'
      : viewportWidth.value >= 900
        ? 'compact'
        : 'narrow',
  )
  const drawer = ref<'assets' | 'side' | null>(null)
  // Folding a docked panel is a preference. A drawer belongs to its current viewport.
  watch(
    layout,
    () => {
      drawer.value = null
    },
    { flush: 'sync' },
  )
  const assetsDocked = computed(
    () => layout.value === 'wide' && preferences.libraryOpen,
  )
  const sideDocked = computed(
    () => layout.value !== 'narrow' && preferences.sideOpen,
  )
  const assetsOpen = computed(
    () => assetsDocked.value || drawer.value === 'assets',
  )
  const rightOpen = computed(() => sideDocked.value || drawer.value === 'side')

  function setAssetsOpen(open: boolean): void {
    if (layout.value !== 'wide') {
      drawer.value = open ? 'assets' : null
      return
    }
    preferences.libraryOpen = open
    persist()
  }
  function setRightOpen(open: boolean): void {
    if (layout.value === 'narrow') {
      drawer.value = open ? 'side' : null
      return
    }
    drawer.value = null
    preferences.sideOpen = open
    persist()
  }

  const sideMax = () =>
    Math.max(
      SIDE_MIN,
      availableWidth.value -
        PREVIEW_MIN -
        GUTTER -
        (assetsDocked.value ? LIBRARY_MIN + GUTTER : 0),
    )
  const rightPanelWidth = computed({
    get: () => Math.min(sideMax(), Math.max(SIDE_MIN, preferences.sideWidth)),
    set: (value: number) => {
      preferences.sideWidth = Math.round(value)
    },
  })
  const libraryMax = () =>
    Math.max(
      LIBRARY_MIN,
      availableWidth.value -
        PREVIEW_MIN -
        GUTTER -
        (sideDocked.value ? rightPanelWidth.value + GUTTER : 0),
    )
  const leftPanelWidth = computed({
    get: () =>
      Math.min(libraryMax(), Math.max(LIBRARY_MIN, preferences.libraryWidth)),
    set: (value: number) => {
      preferences.libraryWidth = Math.round(value)
    },
  })
  const timelineMax = () =>
    Math.max(TIMELINE_MIN, availableHeight.value - 210 - GUTTER)
  const timelineHeight = computed({
    get: () =>
      Math.min(
        timelineMax(),
        Math.max(
          TIMELINE_MIN,
          preferences.timelineHeight ??
            Math.round(availableHeight.value * 0.36),
        ),
      ),
    set: (value: number) => {
      preferences.timelineHeight = Math.round(value)
    },
  })
  const common = { onCommit: persist, resizingClass: 'editor-resizing' }
  const leftPanelResize = useResizable({
    ...common,
    size: leftPanelWidth,
    min: LIBRARY_MIN,
    max: libraryMax,
    edge: 'right',
  })
  const rightPanelResize = useResizable({
    ...common,
    size: rightPanelWidth,
    min: SIDE_MIN,
    max: sideMax,
    edge: 'left',
  })
  const timelineResize = useResizable({
    ...common,
    size: timelineHeight,
    min: TIMELINE_MIN,
    max: timelineMax,
    edge: 'top',
  })
  return {
    layout,
    drawer,
    assetsDocked,
    sideDocked,
    assetsOpen,
    rightOpen,
    setAssetsOpen,
    setRightOpen,
    leftPanelWidth,
    rightPanelWidth,
    timelineHeight,
    leftPanelResize,
    rightPanelResize,
    timelineResize,
  }
}
