import type { Plugin, SettingDefinitionRender } from 'obsidian'

export class EditingEnhancements {
  constructor(host: Plugin, storage: {
    load: () => Record<string, unknown> | undefined
    save: (settings: Record<string, unknown>) => Promise<void>
  })
  start(): Promise<void>
  stop(): void
}

export function editingDefinitions(plugin: EditingEnhancements): SettingDefinitionRender[]
