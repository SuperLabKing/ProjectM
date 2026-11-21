import type { App, Hotkey } from 'obsidian'
import type PMPlugin from '#main'

const LEGACY_ID = 'dotpm-live-desc'

type MigrationApp = App & {
  plugins: {
    plugins: Record<string, unknown>
    enabledPlugins: Set<string>
    disablePluginAndSave: (id: string) => Promise<void>
  }
  hotkeyManager?: {
    customKeys: Record<string, Hotkey[]>
    setHotkeys: (id: string, keys: Hotkey[]) => void
    save: () => Promise<void>
  }
}

export async function migrateEditingEnhancements(plugin: PMPlugin): Promise<void> {
  const app = plugin.app as MigrationApp
  if (!plugin.settings.editingEnhancements) {
    const { configDir, adapter } = app.vault
    const path = `${configDir}/plugins/${LEGACY_ID}/data.json`
    const source: unknown = (await adapter.exists(path)) ? JSON.parse(await adapter.read(path)) : {}
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('The previous description editor settings are not a JSON object.')
    }
    plugin.settings.editingEnhancements = source as Record<string, unknown>
    try {
      await plugin.saveSettings()
    } catch (error) {
      delete plugin.settings.editingEnhancements
      throw error
    }
  }

  const hotkeys = app.hotkeyManager
  if (hotkeys?.customKeys) {
    let changed = false
    for (const id of ['open-date-picker', 'toggle-dotpm-live-description', 'cleanup-dotpm-live']) {
      const oldKey = `${LEGACY_ID}:${id}`
      const newKey = `${plugin.manifest.id}:${id}`
      if (!Object.hasOwn(hotkeys.customKeys, oldKey) || Object.hasOwn(hotkeys.customKeys, newKey)) continue
      hotkeys.setHotkeys(newKey, structuredClone(hotkeys.customKeys[oldKey]))
      changed = true
    }
    if (changed) await hotkeys.save()
  }

  // Complete the migration before unloading the old copy, and unload before installing our hooks.
  if (app.plugins.enabledPlugins.has(LEGACY_ID) || app.plugins.plugins[LEGACY_ID]) {
    await app.plugins.disablePluginAndSave(LEGACY_ID)
  }
}
