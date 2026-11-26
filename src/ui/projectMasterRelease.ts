import { Platform, requestUrl, requireApiVersion, type App, type Plugin } from 'obsidian'
import { compareVersions } from '@dotpm/core'

const repository = 'SuperLabKing/ProjectM'
const pluginId = 'projectmaster'
export const releases = `https://github.com/${repository}/releases`
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const files = ['main.js', 'styles.css', 'manifest.json'] as const
type FileName = typeof files[number]

interface ReleaseAsset {
  name: string
  size: number
  digest: string
}

interface Release {
  version: string
  tag: string
  manifest: ArrayBuffer
  minAppVersion: string
  desktopOnly: boolean
  assets: Record<FileName, ReleaseAsset>
}

type PluginApp = App & {
  plugins?: {
    disablePlugin: (id: string) => Promise<unknown>
    loadManifests: () => Promise<unknown>
    enablePlugin: (id: string) => Promise<unknown>
    getPlugin: (id: string) => { manifest: { version: string } } | null
  }
  setting?: {
    isOpen?: boolean
    activeTab?: { id: string }
    openTabById: (id: string) => unknown
  }
}

const installing = new WeakSet<App>()

async function download(tag: string, asset: ReleaseAsset): Promise<ArrayBuffer> {
  const { arrayBuffer } = await requestUrl({ url: `${releases}/download/${tag}/${asset.name}` })
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer)
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (arrayBuffer.byteLength !== asset.size || asset.digest !== `sha256:${hash}`) {
    throw new Error(`ProjectMaster asset verification failed for ${asset.name}`)
  }
  return arrayBuffer
}

export async function checkProjectMasterRelease(installed: string): Promise<Release | undefined> {
  const response = await requestUrl({
    url: `https://api.github.com/repos/${repository}/releases/latest`,
    headers: { Accept: 'application/vnd.github+json' }
  })
  const release = response.json as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] }
  const tag = release.tag_name ?? ''
  const version = tag.replace(/^v/, '')
  if (release.draft || release.prerelease || !versionPattern.test(version)) throw new Error('Invalid ProjectMaster release')
  if (compareVersions(version, installed) <= 0) return undefined

  const assets = {} as Record<FileName, ReleaseAsset>
  for (const name of files) {
    const asset = release.assets?.find((item) => item.name === name)
    if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 20 * 1024 * 1024 ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`Missing verified release asset ${name}`)
    assets[name] = asset
  }
  const manifest = await download(tag, assets['manifest.json'])
  const parsed = JSON.parse(new TextDecoder().decode(manifest)) as Record<string, unknown>
  if (parsed.id !== pluginId || parsed.version !== version ||
      typeof parsed.minAppVersion !== 'string' || !versionPattern.test(parsed.minAppVersion)) {
    throw new Error('Unexpected ProjectMaster release manifest')
  }
  return { version, tag, manifest, minAppVersion: parsed.minAppVersion, desktopOnly: parsed.isDesktopOnly === true, assets }
}

export function isCompatibleRelease(release: Release): boolean {
  return requireApiVersion(release.minAppVersion) && (!release.desktopOnly || Platform.isDesktopApp)
}

export class ProjectMasterUpdateRecoveryError extends Error {
  constructor(readonly backup: string, cause: unknown) {
    super('Could not restore ProjectMaster after an unsuccessful update', { cause })
  }
}

export async function installProjectMasterRelease(plugin: Plugin, release: Release): Promise<void> {
  const app = plugin.app as PluginApp
  const manager = app.plugins
  const root = plugin.manifest.dir?.replace(/\\/g, '/')
  if (!root || root.includes(':') || root.split('/').some((part) => !part || part === '.' || part === '..') ||
      plugin.manifest.id !== pluginId || !isCompatibleRelease(release) ||
      compareVersions(release.version, plugin.manifest.version) <= 0 ||
      typeof manager?.disablePlugin !== 'function' || typeof manager.loadManifests !== 'function' ||
      typeof manager.enablePlugin !== 'function' || typeof manager.getPlugin !== 'function' ||
      manager.getPlugin(pluginId) !== plugin || installing.has(app)) {
    throw new Error('ProjectMaster update is unavailable')
  }
  installing.add(app)
  const id = crypto.randomUUID()
  const stage = `${root}/.update-stage-${id}`
  const backupRoot = `${root}/.update-backup`
  const backup = `${backupRoot}/${plugin.manifest.version}-${id}`
  const { adapter } = app.vault
  const original = new Map<FileName, ArrayBuffer | null>()
  const previousVersion = plugin.manifest.version
  const reopen = app.setting?.isOpen && app.setting.activeTab?.id === pluginId
  let reloadNeeded = false
  let replaced = false
  let staged = false
  const load = async (version: string) => {
    await manager.loadManifests()
    const enabled = await manager.enablePlugin(pluginId)
    if (enabled === false || manager.getPlugin(pluginId)?.manifest.version !== version) {
      throw new Error(`Could not load ProjectMaster ${version}`)
    }
  }

  try {
    const [main, css] = await Promise.all([
      download(release.tag, release.assets['main.js']),
      download(release.tag, release.assets['styles.css'])
    ])
    const contents = { 'main.js': main, 'styles.css': css, 'manifest.json': release.manifest }
    if (!await adapter.exists(backupRoot)) await adapter.mkdir(backupRoot)
    await adapter.mkdir(backup)
    await adapter.mkdir(stage)
    staged = true
    for (const name of files) {
      const file = `${root}/${name}`
      const prior = await adapter.exists(file) ? await adapter.readBinary(file) : null
      original.set(name, prior)
      if (prior) await adapter.writeBinary(`${backup}/${name}`, prior)
      await adapter.writeBinary(`${stage}/${name}`, contents[name])
    }
    if (manager.getPlugin(pluginId) !== plugin) throw new Error('ProjectMaster changed while preparing the update')
    reloadNeeded = true
    await manager.disablePlugin(pluginId)
    for (const name of files) {
      replaced = true
      if (original.get(name)) await adapter.rename(`${root}/${name}`, `${stage}/previous-${name}`)
      await adapter.rename(`${stage}/${name}`, `${root}/${name}`)
    }
    await load(release.version)
  } catch (error) {
    if (reloadNeeded) {
      try {
        if (manager.getPlugin(pluginId)) await manager.disablePlugin(pluginId)
        if (replaced) {
          for (const [name, prior] of original) {
            const file = `${root}/${name}`
            if (prior) await adapter.writeBinary(file, prior)
            else if (await adapter.exists(file)) await adapter.remove(file)
          }
        }
        await load(previousVersion)
      } catch (restoreError) {
        throw new ProjectMasterUpdateRecoveryError(backup, restoreError)
      }
    }
    throw error
  } finally {
    try {
      if (staged) await adapter.rmdir(stage, true)
    } catch (error) {
      console.warn('[PM] Could not clean the update staging directory', error)
    }
    installing.delete(app)
    if (reloadNeeded && reopen && app.setting?.isOpen && manager.getPlugin(pluginId)) {
      try { await app.setting.openTabById(pluginId) }
      catch (error) { console.warn('[PM] Could not reopen the settings tab', error) }
    }
  }
}
