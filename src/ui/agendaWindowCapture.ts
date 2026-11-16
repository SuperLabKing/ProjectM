import { FileSystemAdapter, Platform, SuggestModal } from 'obsidian'
import { t } from '@dotpm/core'
import type PMPlugin from '#main'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export type WindowSource = { handle: string; pid: number; started: string; title: string; application: string }
export type FrameBounds = { x: number; y: number; width: number; height: number }
export type WindowFrame = FrameBounds & { image: string }

function executable(plugin: PMPlugin): string | undefined {
  const adapter = plugin.app.vault.adapter
  if (!Platform.isWin || !(adapter instanceof FileSystemAdapter) || !plugin.manifest.dir) return
  return join(adapter.getBasePath(), plugin.manifest.dir, 'agenda-window-capture.exe')
}

export async function listAgendaWindows(plugin: PMPlugin): Promise<WindowSource[]> {
  const file = executable(plugin)
  if (!file) return []
  return new Promise((resolve, reject) => {
    execFile(file, ['list'], { windowsHide: true, timeout: 3000 }, (error, output) => {
      if (error) return reject(error)
      try {
        resolve(JSON.parse(output) as WindowSource[])
      } catch (error) {
        reject(error)
      }
    })
  })
}

export class AgendaWindowPicker extends SuggestModal<WindowSource> {
  constructor(
    plugin: PMPlugin,
    private readonly sources: WindowSource[],
    private readonly select: (source: WindowSource) => void
  ) {
    super(plugin.app)
    this.setPlaceholder(t('settings.agendaWindowRefraction.choose'))
  }

  getSuggestions(query: string): WindowSource[] {
    const text = query.trim().toLowerCase()
    return this.sources.filter(({ title, application }) => (title + ' ' + application).toLowerCase().includes(text))
  }

  renderSuggestion(source: WindowSource, el: HTMLElement): void {
    el.createDiv({ text: source.title })
    el.createDiv({ text: source.application + ' · ' + source.handle, cls: 'suggestion-note' })
  }

  onChooseSuggestion(source: WindowSource): void {
    this.select(source)
  }
}

export class AgendaWindowCapture {
  private readonly child: ChildProcessWithoutNullStreams
  private pending?: (frame: WindowFrame | null) => void
  private timeout?: number
  private stopped = false

  constructor(
    plugin: PMPlugin,
    source: WindowSource,
    private readonly onStop: () => void
  ) {
    const file = executable(plugin)
    if (!file) throw new Error('Window capture is unavailable')
    this.child = spawn(file, ['capture', Buffer.from(JSON.stringify(source)).toString('base64')], { windowsHide: true })
    this.child.on('error', () => this.stop())
    this.child.on('close', () => this.stop())
    this.child.stdin.on('error', () => this.stop())
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      try {
        this.complete(JSON.parse(line) as WindowFrame | null)
      } catch {
        this.stop()
      }
    })
  }

  read(crop: FrameBounds, viewport: FrameBounds): Promise<WindowFrame | null> {
    if (this.stopped || this.pending) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.pending = resolve
      this.timeout = window.setTimeout(() => this.stop(), 1200)
      const coords = ({ x, y, width, height }: FrameBounds) => [x, y, width, height]
      this.child.stdin.write([...coords(crop), ...coords(viewport)].join(',') + '\n')
    })
  }

  private complete(frame: WindowFrame | null): void {
    window.clearTimeout(this.timeout)
    const resolve = this.pending
    this.pending = undefined
    resolve?.(frame)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.child.kill()
    this.complete(null)
    this.onStop()
  }
}
