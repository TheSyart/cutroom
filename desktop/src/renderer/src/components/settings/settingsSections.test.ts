import { describe, expect, it } from 'vitest'
import {
  EDITOR_SETTINGS_SECTIONS,
  editorSettingsSection,
} from './settingsSections'
import { settingsQuery } from './useSettingsRoute'
describe('editing settings', () => {
  it('contains the five editing sections and normalizes old selections', () => {
    expect(Object.keys(EDITOR_SETTINGS_SECTIONS)).toEqual([
      'model',
      'skills',
      'voice',
      'media',
      'tokens',
    ])
    expect(editorSettingsSection('mcp')).toBe('model')
    expect(editorSettingsSection(['tokens'])).toBe('tokens')
  })
  it('preserves the underlying session when leaving settings', () => {
    expect(
      settingsQuery(
        { settings: 'skills', skill: 'demo', projectSession: 'a' },
        null,
      ),
    ).toEqual({ projectSession: 'a' })
  })
})
