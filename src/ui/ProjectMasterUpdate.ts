import { Notice, type Setting } from 'obsidian'
import { t } from '@dotpm/core'
import type PMPlugin from '../main'
import {
  checkProjectMasterRelease,
  installProjectMasterRelease,
  isCompatibleRelease,
  ProjectMasterUpdateRecoveryError,
  releases
} from './projectMasterRelease'

export function renderProjectMasterUpdate(setting: Setting, plugin: PMPlugin): void {
  const installed = plugin.manifest.version
  let candidate: Awaited<ReturnType<typeof checkProjectMasterRelease>>
  setting.setDesc(t('settings.update.current', { version: installed }))
  setting.addButton((button) => {
    button.setButtonText(t('settings.update.check')).onClick(async () => {
      if (candidate) {
        const { version, tag } = candidate
        if (!isCompatibleRelease(candidate)) {
          button.buttonEl.ownerDocument.defaultView?.open(`${releases}/tag/${tag}`, '_blank', 'noopener')
          return
        }
        button.setDisabled(true)
        setting.setDesc(t('settings.update.installing', { version }))
        try {
          await installProjectMasterRelease(plugin, candidate)
          new Notice(t('settings.update.installed', { version }))
          candidate = undefined
        } catch (error) {
          console.error('[PM] ProjectMaster update failed', error)
          const message = error instanceof ProjectMasterUpdateRecoveryError
            ? t('settings.update.recoveryFailed', { path: error.backup })
            : t('settings.update.installFailed')
          setting.setDesc(message)
          new Notice(message)
        } finally {
          button.setDisabled(false)
        }
        return
      }
      button.setDisabled(true).setButtonText(t('settings.update.checking'))
      try {
        candidate = await checkProjectMasterRelease(installed)
        if (!candidate) {
          setting.setDesc(t('settings.update.latest', { version: installed }))
        } else {
          const compatible = isCompatibleRelease(candidate)
          setting.setDesc(compatible
            ? t('settings.update.available', { version: candidate.version })
            : t('settings.update.incompatible', { version: candidate.version, minimum: candidate.minAppVersion }))
        }
      } catch (error) {
        console.warn('[PM] ProjectMaster update check failed', error)
        setting.setDesc(t('settings.update.checkFailed'))
      } finally {
        button.setDisabled(false).setButtonText(t(!candidate ? 'settings.update.check'
          : isCompatibleRelease(candidate) ? 'settings.update.install' : 'settings.update.view'))
      }
    })
  })
}
