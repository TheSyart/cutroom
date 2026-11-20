import { skillIdOf, type SlashPaletteItem } from '../commands'
import { toolIcon } from '../icons'
import type {
  CapabilityPickerGroup,
  CapabilityPickerItem,
} from './capabilityPicker'
export interface CapabilityPickerModelInput {
  commands: SlashPaletteItem[]
}

/** Skills available to insert in the current conversation. */
export function buildCapabilityPickerGroups(
  input: CapabilityPickerModelInput,
): CapabilityPickerGroup[] {
  const skillItems = input.commands
    .filter((item) => item.kind === 'skill')
    .map(skillChipItem)
  return [{ label: 'Skills', items: skillItems }].filter(
    (group) => group.items.length,
  )
}

/** A skill chip; also used by the composer's `/` lists. */
export function skillChipItem(item: SlashPaletteItem): CapabilityPickerItem {
  return {
    id: item.id,
    action: 'insert_reference',
    label: item.title,
    description: item.description,
    meta: item.tags || 'Skill',
    reference: { kind: 'skill', id: skillIdOf(item), label: item.title },
    icon: toolIcon('skill'),
    tone: 'cyan',
  }
}
