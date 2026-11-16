import { Platform } from 'obsidian'
import type { AgendaNoticeEdge } from '@dotpm/core'
import type PMPlugin from '#main'
import { glassProperties, glassValue } from './agendaGlass'
import { AgendaWindowCapture, type WindowSource, type WindowFrame } from './agendaWindowCapture'
import { paintWindowFrameScript, WINDOW_REFRACTION_CSS } from './agendaWindowRefraction'
import { createAgendaNoticeCard } from './agendaNoticeCard'

type Bounds = { x: number; y: number; width: number; height: number }
type AcrylicWindow = {
  destroy(): void
  hide(): void
  isDestroyed(): boolean
  isVisible(): boolean
  setBounds(bounds: Bounds): void
  setShape(rectangles: Bounds[]): void
  setIgnoreMouseEvents(ignore: boolean): void
  setBackgroundMaterial(material: 'acrylic'): void
  setAlwaysOnTop(on: boolean, level: 'pop-up-menu'): void
  showInactive(): void
}
type Display = { id: number; bounds: Bounds; workArea: Bounds }
type ScreenEdge = Exclude<AgendaNoticeEdge, 'side' | 'nearest'>
type RemoteWindow = {
  id: number
  webContents: {
    executeJavaScript(code: string): Promise<unknown>
    getZoomFactor(): number
    setZoomFactor(factor: number): void
  }
  loadURL(url: string): Promise<void>
  getBounds(): Bounds
  setBounds(bounds: Bounds): void
  setIgnoreMouseEvents(ignore: boolean): void
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  isAlwaysOnTop(): boolean
  setAlwaysOnTop(on: boolean, level?: 'pop-up-menu'): void
  showInactive(): void
  moveTop(): void
  destroy(): void
  restore(): void
  focus(): void
  on(event: 'page-title-updated', listener: (event: unknown, title: string) => void): void
  on(event: 'will-move' | 'moved' | 'blur' | 'closed', listener: () => void): void
}
type FocusEvent = 'browser-window-focus' | 'browser-window-blur'
type Desktop = {
  BrowserWindow: {
    new (options: object): RemoteWindow
    getFocusedWindow(): RemoteWindow | null
  }
  app: {
    on(event: FocusEvent, listener: () => void): void
    removeListener(event: FocusEvent, listener: () => void): void
  }
  BaseWindow?: new (options: object) => AcrylicWindow
  getCurrentWindow(): RemoteWindow
  screen: {
    getDisplayMatching(bounds: Bounds): Display
    getAllDisplays(): Display[]
    dipToScreenRect(window: RemoteWindow, bounds: Bounds): Bounds
  }
}

type Reminder = {
  message: string
  snoozeLabel?: string
  open?: () => void
  snooze?: () => void
  confirm?: () => void
  fallback?: () => void
}

const POSITION_KEY = 'dotpm-agenda-float-position'

function desktopBridge(): Desktop | undefined {
  const nodeRequire = (window as Window & { require?: (id: string) => unknown }).require
  return Platform.isWin ? (nodeRequire?.('@electron/remote') as Desktop | undefined) : undefined
}

export function watchAgendaFocus(onFocus: (focusedId: number | undefined) => void): (() => void) | undefined {
  const desktop = desktopBridge()
  if (!desktop) return
  let timer: number | undefined
  const check = () => {
    const focused = desktop.BrowserWindow.getFocusedWindow()
    onFocus(focused?.isVisible() && !focused.isMinimized() ? focused.id : undefined)
  }
  // A blur followed by focus in another Obsidian window is a single foreground transition.
  const schedule = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      check()
    }, 100)
  }
  const events = ['browser-window-focus', 'browser-window-blur'] as const
  for (const event of events) desktop.app.on(event, schedule)
  check()
  // Windows can keep returning a minimized window without a fresh blur event.
  const poll = window.setInterval(() => {
    if (timer === undefined) check()
  }, 200)
  return () => {
    window.clearInterval(poll)
    window.clearTimeout(timer)
    for (const event of events) desktop.app.removeListener(event, schedule)
  }
}
const WIDTH = 350
const MARGIN = 12

function roundedShape(width: number, height: number, radius: number): Bounds[] {
  const shape = [{ x: 0, y: radius, width, height: height - radius * 2 }]
  for (let y = 0; y < radius; y++) {
    const x = Math.ceil(radius - Math.sqrt(radius ** 2 - (radius - y - 0.5) ** 2))
    shape.push({ x, y, width: width - x * 2, height: 1 })
    shape.push({ x, y: height - y - 1, width: width - x * 2, height: 1 })
  }
  return shape
}

function screenExit(at: Bounds, display: Display, others: Display[], preference: AgendaNoticeEdge): Bounds | undefined {
  const edge = display.bounds
  const edges = {
    right: { ...at, x: edge.x + edge.width },
    left: { ...at, x: edge.x - at.width },
    top: { ...at, y: edge.y - at.height },
    bottom: { ...at, y: edge.y + edge.height }
  }
  // The slide viewport ends at the selected display boundary, even if another display touches it.
  if (preference === 'left' || preference === 'right' || preference === 'top' || preference === 'bottom') {
    return edges[preference]
  }
  const distance = (to: Bounds) => Math.abs(to.x - at.x) + Math.abs(to.y - at.y)
  const priority = (to: Bounds) => Number(preference === 'side' && to.x === at.x)
  return Object.values(edges)
    .sort((a, b) => priority(a) - priority(b) || distance(a) - distance(b))
    .find((to) => {
      const left = Math.min(at.x, to.x)
      const right = Math.max(at.x, to.x) + at.width
      const top = Math.min(at.y, to.y)
      const bottom = Math.max(at.y, to.y) + at.height
      return !others.some(
        ({ id, bounds }) =>
          id !== display.id &&
          left < bounds.x + bounds.width &&
          right > bounds.x &&
          top < bounds.y + bounds.height &&
          bottom > bounds.y
      )
    })
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>ProjectM</title>
<style>
  :root { color-scheme: light dark; font: 13px system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  main { position: absolute; top: 0; left: 0; width: ${WIDTH}px;
    font-family: var(--pm-notice-font); font-size: var(--pm-notice-size);
    line-height: var(--pm-notice-leading); }
  main[data-align="right"] { left: auto; right: 0; }
  main[data-align="bottom"] { top: auto; bottom: 0; }
  main:not([data-visible]) { visibility: hidden; }
  #cards { display: grid; align-content: start; gap: 8px; padding: 8px 12px 24px;
    max-height: var(--card-limit); overflow: auto; overscroll-behavior: contain; }
  ${__AGENDA_NOTICE_CSS__}
  main.pm-agenda-notice-stack[data-notice-style] .pm-agenda-notice { backdrop-filter: none; }
  main.pm-agenda-notice-stack .pm-agenda-notice[data-native-acrylic][data-pm-liquid-glass] {
    --pm-liquid-fill: 84%;
  }
  .pm-agenda-notice[data-native-acrylic]::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 16px calc(var(--pm-native-acrylic-inset) + 8px)
      color-mix(in srgb, var(--background-primary) 60%, transparent);
  }
  .pm-agenda-notice[data-native-acrylic] > * { position: relative; }
  .pm-agenda-notice-header { -webkit-app-region: drag; }
  ${WINDOW_REFRACTION_CSS}
</style>
<main class="pm-agenda-notice-stack"><div id="cards" role="log"></div></main>`

export class AgendaFloatWindow {
  private surface?: RemoteWindow
  private ready?: Promise<void>
  private reminders = new Map<number, Reminder>()
  private enabled = true
  private nextId = 0
  private revision = 0
  private screen?: Desktop['screen']
  private owner?: RemoteWindow
  private motion?: { rest: Bounds; outside: Bounds; entering: boolean }
  private enteredFrom?: ScreenEdge
  private zoom = 1
  private Acrylic?: Desktop['BaseWindow']
  private acrylicLayers: AcrylicWindow[] = []
  windowSource?: WindowSource
  private capture?: AgendaWindowCapture
  private captureMotion?: number
  private captureVisible = false
  private acrylicAreas: (Bounds & { radius: number })[] = []

  private get width(): number {
    return Math.ceil(WIDTH * this.zoom)
  }

  constructor(
    private plugin: PMPlugin,
    private previewEdge?: AgendaNoticeEdge
  ) {}

  show(reminder: Reminder): number {
    const id = ++this.nextId
    this.reminders.set(id, reminder)
    this.update()
    return id
  }

  ownsWindow(id: number): boolean {
    return this.surface?.id === id
  }

  setVisible(visible: boolean): void {
    if (this.enabled === visible) return
    this.enabled = visible
    if (visible) this.refresh()
    else this.exit()
  }

  remove(id: number): void {
    if (!this.reminders.delete(id) || !this.enabled) return
    if (this.reminders.size) this.update()
    else this.exit()
  }

  refresh(): void {
    if (this.reminders.size) this.update()
  }

  clear(): void {
    this.reminders.clear()
    this.close()
  }

  setWindowSource(source?: WindowSource): void {
    this.stopCapture()
    this.windowSource = source
    this.refresh()
  }

  private stopCapture(): void {
    const active = this.capture
    this.capture = undefined
    this.captureVisible = false
    window.clearInterval(this.captureMotion)
    active?.stop()
    const surface = this.surface
    if (!surface || surface.isDestroyed()) return
    void surface.webContents
      .executeJavaScript(paintWindowFrameScript({ x: 0, y: 0, width: 0, height: 0 }, null, null, 0))
      .catch(() => {})
  }

  private get windowRefraction(): boolean {
    return (
      !!this.windowSource &&
      this.plugin.settings.agendaWindowRefraction &&
      this.plugin.settings.agendaNoticeStyle === 'liquid' &&
      !window.matchMedia('(prefers-reduced-transparency: reduce)').matches
    )
  }

  private startCapture(surface: RemoteWindow): void {
    const screen = this.screen
    const source = this.windowSource
    if (this.capture || !screen || !source || !this.windowRefraction || !surface.isVisible()) return
    const capture = new AgendaWindowCapture(this.plugin, source, () => {
      if (this.capture !== capture) return
      this.setWindowSource()
    })
    this.capture = capture
    let frame: WindowFrame | null = null
    let crop: Bounds | undefined
    let origin: Bounds
    let lastPosition = ''
    let paintSequence = 0
    const physicalBounds = () => screen.dipToScreenRect(surface, surface.getBounds())
    const paint = async (image: string | null) => {
      const sequence = ++paintSequence
      const bounds = physicalBounds()
      const { x, y, width, height } = frame ?? bounds
      const strength = glassValue('agendaGlassRefraction', this.plugin.settings.agendaGlassRefraction)
      lastPosition = bounds.x + ',' + bounds.y
      const visible = await surface.webContents.executeJavaScript(
        paintWindowFrameScript(bounds, frame ? { x, y, width, height } : null, image, strength)
      )
      if (this.capture !== capture || sequence !== paintSequence) return
      if (visible === true) {
        this.captureVisible = true
        this.hideAcrylic()
      } else {
        frame = null
        this.captureVisible = false
        this.syncAcrylic(surface)
      }
    }
    this.captureMotion = window.setInterval(() => {
      if (this.capture !== capture || this.motion || surface.isDestroyed() || !frame) return
      const { x, y } = physicalBounds()
      if (lastPosition !== x + ',' + y) void paint(null).catch(() => capture.stop())
    }, 16)
    const stream = async () => {
      while (this.capture === capture && !surface.isDestroyed()) {
        if (this.motion) {
          await new Promise((resolve) => window.setTimeout(resolve, 30))
          continue
        }
        origin = physicalBounds()
        if (
          !crop ||
          origin.x < crop.x + 30 ||
          origin.y < crop.y + 30 ||
          origin.x + origin.width > crop.x + crop.width - 30 ||
          origin.y + origin.height > crop.y + crop.height - 30
        ) {
          crop = { x: origin.x - 140, y: origin.y - 110, width: origin.width + 280, height: origin.height + 220 }
        }
        const next = await capture.read(crop, origin)
        if (this.capture !== capture || surface.isDestroyed()) return
        if (next?.image !== frame?.image || next?.x !== frame?.x || next?.y !== frame?.y) {
          frame = next
          await paint(frame?.image ?? null)
        }
        // A minimized window or a card outside the source needs no rapid polling.
        await new Promise((resolve) => window.setTimeout(resolve, frame ? 0 : 180))
      }
    }
    void stream().catch(() => capture.stop())
  }

  private close(): void {
    this.stopCapture()
    const surface = this.surface
    this.surface = undefined
    this.ready = undefined
    this.motion = undefined
    this.enteredFrom = undefined
    this.clearAcrylic()
    if (surface && !surface.isDestroyed()) surface.destroy()
  }

  private clearAcrylic(): void {
    for (const layer of this.acrylicLayers) if (!layer.isDestroyed()) layer.destroy()
    this.acrylicLayers = []
    this.acrylicAreas = []
  }

  private hideAcrylic(): void {
    for (const layer of this.acrylicLayers) if (!layer.isDestroyed() && layer.isVisible()) layer.hide()
  }

  private syncAcrylic(surface: RemoteWindow): void {
    if (!this.Acrylic || this.captureVisible || this.motion || !surface.isVisible()) return
    const origin = surface.getBounds()
    let raisedLayers = false
    try {
      while (this.acrylicLayers.length > this.acrylicAreas.length) this.acrylicLayers.pop()?.destroy()
      for (const [i, area] of this.acrylicAreas.entries()) {
        let layer = this.acrylicLayers[i]
        if (!layer) {
          layer = new this.Acrylic({
            title: 'ProjectM acrylic backdrop',
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            skipTaskbar: true,
            focusable: false,
            resizable: false
          })
          this.acrylicLayers.push(layer)
          layer.setIgnoreMouseEvents(true)
          layer.setBackgroundMaterial('acrylic')
        }
        const { x, y, width, height, radius } = area
        layer.setBounds({ x: origin.x + x, y: origin.y + y, width, height })
        layer.setShape(roundedShape(width, height, radius))
        if (!layer.isVisible()) {
          layer.showInactive()
          layer.setAlwaysOnTop(true, 'pop-up-menu')
          raisedLayers = true
        }
      }
      if (raisedLayers) surface.moveTop()
    } catch {
      this.clearAcrylic()
    }
  }

  private fallback(): void {
    this.close()
    if (!this.previewEdge) return
    for (const reminder of this.reminders.values()) reminder.fallback?.()
    this.reminders.clear()
  }

  private create(): RemoteWindow {
    const nodeRequire = (window as Window & { require?: (id: string) => unknown }).require
    const desktop = desktopBridge()
    if (!desktop) throw new Error('Windows reminder window unavailable')
    this.screen = desktop.screen
    this.owner = desktop.getCurrentWindow()
    const release = nodeRequire?.('node:os') as { release(): string } | undefined
    if (Number(release?.release().split('.')[2]) >= 22621) this.Acrylic = desktop.BaseWindow
    this.zoom = this.owner.webContents.getZoomFactor()
    const display = this.screen.getDisplayMatching(this.owner.getBounds()).workArea
    const saved = this.plugin.app.loadLocalStorage(POSITION_KEY) as { x?: number; y?: number } | null
    const x =
      typeof saved?.x === 'number' && Number.isFinite(saved.x)
        ? saved.x
        : display.x + display.width - this.width - MARGIN
    const y = typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : display.y + MARGIN
    const surface = new desktop.BrowserWindow({
      x,
      y,
      width: this.width,
      height: 144,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    this.surface = surface
    const pin = () => {
      if (this.surface === surface && !surface.isAlwaysOnTop()) {
        surface.setAlwaysOnTop(false)
        surface.setAlwaysOnTop(true, 'pop-up-menu')
      }
    }
    surface.on('will-move', () => this.hideAcrylic())
    surface.on('moved', () => {
      if (this.surface !== surface || surface.isDestroyed() || this.motion) return
      const { x, y } = surface.getBounds()
      this.plugin.app.saveLocalStorage(POSITION_KEY, { x, y })
      pin()
      this.syncAcrylic(surface)
    })
    surface.on('blur', pin)
    surface.on('closed', () => {
      if (this.surface === surface) this.fallback()
    })
    surface.on('page-title-updated', (_event, title) => {
      if (this.surface === surface) this.handleAction(title)
    })
    this.ready = surface.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).then(() => {
      if (this.surface === surface) surface.webContents.setZoomFactor(this.zoom)
    })
    return surface
  }

  private handleAction(title: string): void {
    const match = /^pm:(open|snooze|confirm):(\d+):\d+$/.exec(title)
    if (!match) return
    const id = Number(match[2])
    const reminder = this.reminders.get(id)
    if (!reminder) return
    if (match[1] === 'open') {
      if (!reminder.open) return
      if (this.owner?.isMinimized()) this.owner.restore()
      this.owner?.focus()
      reminder.open()
      return
    }
    if (match[1] === 'snooze') {
      reminder.snooze?.()
      return
    }
    if (reminder.confirm) reminder.confirm()
    else this.remove(id)
  }

  private outside(rest: Bounds, direction: AgendaNoticeEdge): Bounds | undefined {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !this.screen) return
    return screenExit(rest, this.screen.getDisplayMatching(rest), this.screen.getAllDisplays(), direction)
  }

  private settle(surface: RemoteWindow, rest: Bounds): void {
    surface.setBounds(rest)
    surface.setIgnoreMouseEvents(false)
  }

  private async slide(
    surface: RemoteWindow,
    rest: Bounds,
    outside: Bounds,
    entering: boolean,
    currentTransform?: string
  ): Promise<void> {
    this.hideAcrylic()
    const motion = { rest, outside, entering }
    this.motion = motion
    const dx = outside.x - rest.x
    const dy = outside.y - rest.y
    if (entering) this.enteredFrom = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'top' : 'bottom'
    const alignment = dx < 0 ? 'right' : dy < 0 ? 'bottom' : ''
    const viewport = {
      x: dx < 0 ? outside.x + rest.width : rest.x,
      y: dy < 0 ? outside.y + rest.height : rest.y,
      width: Math.max(rest.width, Math.abs(dx)),
      height: Math.max(rest.height, Math.abs(dy))
    }
    surface.setIgnoreMouseEvents(true)
    surface.setBounds(viewport)
    const animated = surface.webContents.executeJavaScript(`(async () => {
      const main = document.querySelector('main');
      const previous = main.getAnimations().find(animation => animation.id === 'edge-slide');
      const current = ${JSON.stringify(currentTransform ?? null)} ??
        (previous ? getComputedStyle(main).transform : null);
      previous?.cancel();
      main.style.removeProperty('transform');
      main.dataset.align = ${JSON.stringify(alignment)};
      const off = { transform: 'translate3d(${dx / this.zoom}px, ${dy / this.zoom}px, 0)' };
      const atRest = { transform: 'translate3d(0, 0, 0)' };
      const start = current ? { transform: current } : ${entering ? 'off' : 'atRest'};
      const motion = main.animate([start, ${entering ? 'atRest' : 'off'}], {
        duration: ${entering ? 390 : 315},
        easing: '${entering ? 'cubic-bezier(.22,.68,.28,1)' : 'cubic-bezier(.45,0,.72,.86)'}',
        fill: 'both'
      });
      motion.id = 'edge-slide';
      main.dataset.visible = '';
      await motion.finished.catch(() => {});
      if (${entering}) motion.cancel();
    })()`)
    if (entering && !surface.isVisible()) {
      surface.showInactive()
      surface.setAlwaysOnTop(true, 'pop-up-menu')
    }
    await animated
    if (entering && this.surface === surface && this.motion === motion) {
      this.motion = undefined
      this.settle(surface, rest)
      this.syncAcrylic(surface)
      this.startCapture(surface)
    }
  }

  private exit(): void {
    const surface = this.surface
    if (!surface) return
    const revision = ++this.revision
    this.stopCapture()
    const finish = () => {
      if (surface === this.surface && revision === this.revision && (!this.enabled || !this.reminders.size))
        this.close()
    }
    if (!surface.isVisible() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    const rest = this.motion?.rest ?? surface.getBounds()
    const outside = this.enteredFrom && this.outside(rest, this.enteredFrom)
    if (outside) {
      void this.slide(surface, rest, outside, false).then(finish, finish)
      return
    }
    surface.setIgnoreMouseEvents(true)
    void surface.webContents
      .executeJavaScript(`(() => {
      const main = document.querySelector('main');
      const fade = main.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 170, easing: 'ease-out', fill: 'forwards'
      });
      fade.id = 'edge-slide';
      return fade.finished;
    })()`)
      .then(finish, finish)
  }

  private update(): void {
    if (!this.enabled) return
    const revision = ++this.revision
    void this.render(revision).catch(() => {
      if (revision === this.revision && this.reminders.size) this.fallback()
    })
  }

  private async render(revision: number): Promise<void> {
    const surface = this.surface ?? this.create()
    await this.ready
    if (this.surface !== surface || revision !== this.revision) return
    const motion = this.motion
    const interrupted = motion && !motion.entering ? motion : undefined
    const bounds = motion?.rest ?? surface.getBounds()
    const area = this.screen!.getDisplayMatching(bounds).workArea
    this.stopCapture()
    const theme = getComputedStyle(document.body)
    const style = this.plugin.settings.agendaNoticeStyle ?? 'plain'
    const themeProperties = [
      '--interactive-accent',
      '--interactive-accent-hover',
      '--background-primary',
      '--background-modifier-border',
      '--text-normal',
      '--text-accent',
      '--text-on-accent',
      '--font-ui-small',
      '--font-medium'
    ]
    const data = {
      style,
      nativeAcrylic: !!this.Acrylic,
      zoom: this.zoom,
      properties: {
        ...Object.fromEntries(themeProperties.map((key) => [key, theme.getPropertyValue(key).trim()])),
        ...glassProperties(this.plugin.settings),
        '--pm-notice-font': theme.fontFamily,
        '--pm-notice-size': theme.fontSize,
        '--pm-notice-leading': String(parseFloat(theme.lineHeight) / parseFloat(theme.fontSize) || 1.3)
      },
      dark: document.body.classList.contains('theme-dark'),
      limit: Math.min(490, (area.height - 2 * MARGIN - 44) / this.zoom),
      cards: [...this.reminders].map(([id, reminder]) => ({
        id,
        html: createAgendaNoticeCard(document, { ...reminder, preview: !!this.previewEdge }).card.outerHTML
      }))
    }
    // Text stays in the isolated page. Its title only reports a known action and a numeric ID.
    const layout = (await surface.webContents.executeJavaScript(`(() => {
      const data = ${JSON.stringify(data)};
      const main = document.querySelector('main');
      const cards = document.querySelector('#cards');
      const returning = ${!!interrupted};
      const animation = main.getAnimations().find(animation => animation.id === 'edge-slide');
      const transform = returning && animation ? getComputedStyle(main).transform : null;
      animation?.cancel();
      if (transform) main.style.transform = transform;
      main.dataset.noticeStyle = data.style;
      main.classList.toggle('theme-dark', data.dark);
      main.style.colorScheme = data.dark ? 'dark' : 'light';
      for (const [key, value] of Object.entries(data.properties)) main.style.setProperty(key, value);
      main.style.setProperty('--card-limit', data.limit + 'px');
      const scroll = cards.scrollTop;
      const focused = document.activeElement?.dataset.action;
      cards.replaceChildren();
      for (const item of data.cards) {
        const card = new DOMParser().parseFromString(item.html, 'text/html').body.firstElementChild;
        card.toggleAttribute('data-pm-liquid-glass', data.style === 'liquid');
        const bind = (action, selector) => {
          const el = card.querySelector(selector);
          if (!el) return;
          el.dataset.action = action + ':' + item.id;
          const report = () => {
            window.pmActionSequence = (window.pmActionSequence || 0) + 1;
            document.title = 'pm:' + el.dataset.action + ':' + window.pmActionSequence;
          };
          el.onclick = () => {
            if (action !== 'open') el.disabled = true;
            report();
          };
        };
        bind('open', 'button.pm-agenda-notice-action');
        bind('snooze', 'button.pm-agenda-notice-snooze');
        bind('confirm', 'button.pm-agenda-notice-confirm');
        cards.append(card);
      }
      const restore = Array.from(cards.querySelectorAll('button')).find(el => el.dataset.action === focused);
      restore?.focus({ preventScroll: true });
      cards.scrollTop = scroll;
      const root = main.getBoundingClientRect();
      const acrylic = data.nativeAcrylic && data.style !== 'plain' &&
        !matchMedia('(prefers-reduced-transparency: reduce)').matches &&
        cards.scrollHeight <= cards.clientHeight;
      const areas = acrylic ? Array.from(cards.children, (card) => {
        const rect = card.getBoundingClientRect();
        const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius);
        const inset = Math.ceil(radius * data.zoom * (1 - Math.SQRT1_2)) + 1;
        card.dataset.acrylicAvailable = '';
        card.dataset.nativeAcrylic = '';
        card.style.setProperty('--pm-native-acrylic-inset', inset / data.zoom + 'px');
        return { x: rect.left - root.left, y: rect.top - root.top, width: rect.width, height: rect.height,
          radius, inset };
      }) : [];
      return { height: root.height, areas, transform };
    })()`)) as { height: number; areas: (Bounds & { radius: number; inset: number })[]; transform?: string }
    if (this.surface !== surface || revision !== this.revision || typeof layout?.height !== 'number') return
    this.acrylicAreas = layout.areas.flatMap(({ x, y, width, height, radius, inset }) => {
      const zoom = this.zoom
      // Even a rectangular DWM backing must fit within the CSS card's rounded outline.
      const right = Math.floor((x + width) * zoom) - inset
      const bottom = Math.floor((y + height) * zoom) - inset
      x = Math.ceil(x * zoom) + inset
      y = Math.ceil(y * zoom) + inset
      width = right - x
      height = bottom - y
      radius = Math.max(0, Math.min(Math.floor(radius * zoom) - inset, (height - 1) >> 1, (width - 1) >> 1))
      return width > 0 && height > 0 ? [{ x, y, width, height, radius }] : []
    })
    const nativeHeight = Math.ceil(layout.height * this.zoom)
    const rest = {
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - this.width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - nativeHeight)),
      width: this.width,
      height: nativeHeight
    }
    const entering = !surface.isVisible()
    const direction = this.previewEdge ?? this.plugin.settings.agendaNoticeEdge ?? 'side'
    const outside =
      entering || interrupted
        ? this.outside(rest, interrupted ? (this.enteredFrom ?? direction) : direction)
        : undefined
    if (outside) {
      await this.slide(surface, rest, outside, true, layout.transform)
      return
    }
    this.motion = undefined
    this.settle(surface, rest)
    await surface.webContents.executeJavaScript(`
      const main = document.querySelector('main');
      main.dataset.align = '';
      main.style.removeProperty('transform');
      main.dataset.visible = '';
      void 0;
    `)
    if (this.surface !== surface || revision !== this.revision) return
    if (entering) {
      surface.showInactive()
      surface.setAlwaysOnTop(true, 'pop-up-menu')
    }
    this.syncAcrylic(surface)
    this.startCapture(surface)
  }
}
