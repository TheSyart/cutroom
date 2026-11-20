import type { IconComponent } from '../icons'

export type CapabilityTone =
  'red' | 'cyan' | 'blue' | 'slate' | 'gold' | 'green' | 'violet'

export type CapabilityPickerAction =
  | 'files'
  | 'insert_command'
  /** A skill chip. */
  | 'insert_reference'
  | 'activate_plan'

export interface CapabilityPickerItem {
  id: string
  action: CapabilityPickerAction
  label: string
  description: string
  meta?: string
  completion?: string
  /** What `insert_reference` inserts. */
  reference?: { kind: 'skill'; id: string; label: string }
  /** Greyed: selecting it does not insert anything. */
  disabled?: boolean
  icon: IconComponent
  tone?: CapabilityTone
}

export interface CapabilityPickerGroup {
  label: string
  items: CapabilityPickerItem[]
}
