export const EDITOR_SETTINGS_SECTIONS = {
  model: '剪辑模型',
  skills: 'Skills',
  voice: '语音输入',
  media: '媒体与转写',
  tokens: 'Token 用量',
} as const

export function editorSettingsSection(
  value: unknown,
): keyof typeof EDITOR_SETTINGS_SECTIONS {
  const key = Array.isArray(value) ? value[0] : value
  return typeof key === 'string' && Object.hasOwn(EDITOR_SETTINGS_SECTIONS, key)
    ? (key as keyof typeof EDITOR_SETTINGS_SECTIONS)
    : 'model'
}

export type SettingsModalSection = keyof typeof EDITOR_SETTINGS_SECTIONS
export type SettingsSectionKey = SettingsModalSection
