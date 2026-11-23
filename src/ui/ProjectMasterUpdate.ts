import { requestUrl, requireApiVersion, type App, type Setting } from 'obsidian'
import { compareVersions, t } from '@dotpm/core'
import type PMPlugin from '../main'

const repository = 'SuperLabKing/ProjectM'
const pluginId = 'projectmaster'
const releases = `https://github.com/${repository}/releases`
const stableVersion = /^\d+\.\d+\.\d+$/

interface Brat {
  settings: {
    pluginList: string[]
    pluginSubListFrozenVersion?: Array<{ repo: string; version: string }>
  }
  betaPlugins?: {
    validateRepository(repo: string, includePrereleases: boolean): Promise<unknown>
    updatePlugin(repo: string): Promise<boolean>
  }
}

type PluginApp = App & {
  plugins?: {
    plugins: Record<string, unknown>
    manifests: Record<string, { version: string }>
  }
}

function updateManager(app: PluginApp): Brat['betaPlugins'] {
  const brat = app.plugins?.plugins['obsidian42-brat'] as Brat | undefined
  const manager = brat?.betaPlugins
  if (typeof manager?.updatePlugin !== 'function' || typeof manager.validateRepository !== 'function') return
  const matches = (repo: string) => repo.toLowerCase() === repository.toLowerCase()
  const frozen = brat?.settings?.pluginSubListFrozenVersion?.some(({ repo, version }) =>
    matches(repo) && Boolean(version) && version !== 'latest'
  )
  if (brat?.settings?.pluginList?.some(matches) && !frozen) return manager
}

function releaseManifest(value: unknown): { version: string; minAppVersion?: string } {
  if (!value || typeof value !== 'object' || !('id' in value) || value.id !== pluginId ||
      !('version' in value) || typeof value.version !== 'string' || !stableVersion.test(value.version)) {
    throw new Error('Unexpected ProjectMaster release manifest')
  }
  return {
    version: value.version,
    minAppVersion: 'minAppVersion' in value && typeof value.minAppVersion === 'string' ? value.minAppVersion : undefined
  }
}

export function renderProjectMasterUpdate(setting: Setting, plugin: PMPlugin): void {
  const app = plugin.app as PluginApp
  const installed = plugin.manifest.version
  setting.setDesc(t('settings.update.current', { version: installed }))
  setting.addButton((button) => {
    button.setButtonText(t('settings.update.check')).onClick(async () => {
      setting.controlEl.querySelector('.pm-update-action')?.remove()
      button.setDisabled(true).setButtonText(t('settings.update.checking'))
      try {
        const response = await requestUrl({ url: `${releases}/latest/download/manifest.json` })
        const { version, minAppVersion } = releaseManifest(response.json)
        if (compareVersions(version, installed) <= 0) {
          setting.setDesc(t('settings.update.latest', { version: installed }))
          return
        }

        setting.setDesc(t('settings.update.available', { version }))
        const manager = updateManager(app)
        let canInstall = Boolean(manager) && (!minAppVersion || requireApiVersion(minAppVersion))
        setting.addButton((action) => {
          action.buttonEl.addClass('pm-update-action')
          action.setButtonText(t(canInstall ? 'settings.update.install' : 'settings.update.view')).onClick(async () => {
            if (!canInstall || !manager) {
              window.open(releases, '_blank', 'noopener')
              return
            }
            action.setDisabled(true)
            button.setDisabled(true)
            setting.setDesc(t('settings.update.installing', { version }))
            try {
              const candidate = releaseManifest(await manager.validateRepository(repository, true))
              if (candidate.version !== version || !(await manager.updatePlugin(repository)) ||
                  app.plugins?.manifests[pluginId]?.version !== version) {
                throw new Error('BRAT did not install the verified ProjectMaster version')
              }
              setting.setDesc(t('settings.update.installed', { version }))
              action.buttonEl.remove()
            } catch {
              setting.setDesc(t('settings.update.installFailed'))
              canInstall = false
              action.setButtonText(t('settings.update.view'))
            } finally {
              action.setDisabled(false)
              button.setDisabled(false)
            }
          })
        })
      } catch {
        setting.setDesc(t('settings.update.checkFailed'))
      } finally {
        button.setDisabled(false).setButtonText(t('settings.update.check'))
      }
    })
  })
}
