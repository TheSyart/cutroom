import { inject } from 'vue'
import { skillIdOf, type SlashPaletteItem } from '../../../commands'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { EMPTY_CATALOG, type ComposerCatalog } from './referenceText'

export function catalogFromCommands(
  commands: () => readonly SlashPaletteItem[],
): ComposerCatalog {
  return {
    skill: (id) =>
      commands().find((item) => item.kind === 'skill' && skillIdOf(item) === id)
        ?.title,
  }
}

export function useReferenceCatalog(): ComposerCatalog {
  const context = inject(APP_CONTEXT_KEY, null)
  return context
    ? catalogFromCommands(() => context.commands.value)
    : EMPTY_CATALOG
}
