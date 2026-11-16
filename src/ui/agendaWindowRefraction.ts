import type { FrameBounds, WindowFrame } from './agendaWindowCapture'
import { displacementMap } from './agendaRefraction'

function paintWindowFrame(
  origin: FrameBounds,
  frame: Omit<WindowFrame, 'image'> | null,
  image: string | null,
  strength: number,
  map: typeof displacementMap
): boolean {
  // Runs in the isolated reminder page. Only the selected window's cropped frame is supplied.
  const cards = document.querySelectorAll<HTMLElement>('#cards .pm-agenda-notice')
  if (image) document.body.dataset.windowFrame = image
  for (const [i, card] of [...cards].entries()) {
    let layer = card.querySelector<HTMLElement>('.pm-agenda-window-image')
    const bounds = card.getBoundingClientRect()
    const scale = window.devicePixelRatio
    const x = origin.x + bounds.left * scale
    const y = origin.y + bounds.top * scale
    const data = document.body.dataset.windowFrame
    if (
      !frame ||
      !data ||
      x < frame.x - 1 ||
      y < frame.y - 1 ||
      x + bounds.width * scale > frame.x + frame.width + 1 ||
      y + bounds.height * scale > frame.y + frame.height + 1
    ) {
      layer?.remove()
      delete card.dataset.windowRefraction
      continue
    }
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'pm-agenda-window-image'
      layer.setAttribute('aria-hidden', 'true')
      const texture = document.createElement('img')
      texture.alt = ''
      const glass = document.createElement('div')
      const width = card.clientWidth
      const height = card.clientHeight
      const radius = Math.min(parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0, width / 2, height / 2)
      const href = map(document.createElement('canvas'), width, height, radius)
      const id = 'pm-window-filter-' + i
      if (href) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('width', '0')
        svg.setAttribute('height', '0')
        svg.innerHTML =
          '<filter id="' +
          id +
          '" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">' +
          '<feImage result="map" preserveAspectRatio="none" width="' +
          width +
          '" height="' +
          height +
          '" href="' +
          href +
          '"/>' +
          '<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" scale="' +
          strength * 0.12 +
          '"/>' +
          '</filter>'
        layer.append(svg)
        glass.style.setProperty('--pm-glass-refraction-filter', 'url(#' + id + ')')
      }
      layer.append(texture, glass)
      card.prepend(layer)
    }
    const texture = layer.querySelector('img')!
    const url = 'data:image/jpeg;base64,' + data
    if (texture.getAttribute('src') !== url) texture.src = url
    Object.assign(texture.style, {
      left: (frame.x - x) / scale + 'px',
      top: (frame.y - y) / scale + 'px',
      width: frame.width / scale + 'px',
      height: frame.height / scale + 'px'
    })
    card.dataset.windowRefraction = ''
  }
  const refracted = document.querySelector('[data-window-refraction]') !== null
  for (const card of cards) {
    card.toggleAttribute('data-native-acrylic', !refracted && card.hasAttribute('data-acrylic-available'))
  }
  if (!refracted) delete document.body.dataset.windowFrame
  return refracted
}

export function paintWindowFrameScript(
  origin: FrameBounds,
  frame: Omit<WindowFrame, 'image'> | null,
  image: string | null,
  strength: number
): string {
  return (
    '(' +
    paintWindowFrame.toString() +
    ')(' +
    JSON.stringify(origin) +
    ',' +
    JSON.stringify(frame) +
    ',' +
    JSON.stringify(image) +
    ',' +
    strength +
    ',' +
    displacementMap.toString() +
    ')'
  )
}

export const WINDOW_REFRACTION_CSS =
  /* css */
  '.pm-agenda-notice[data-window-refraction] { isolation: isolate; }' +
  '.pm-agenda-notice[data-window-refraction] > :not(.pm-agenda-window-image) { position: relative; z-index: 1; }' +
  '.pm-agenda-window-image { position: absolute; overflow: hidden; border-radius: inherit; pointer-events: none; inset: 0; }' +
  '.pm-agenda-window-image > img { position: absolute; max-width: none; }' +
  '.pm-agenda-window-image > div { position: absolute; inset: 0; border-radius: inherit;' +
  'background: color-mix(in srgb, var(--background-primary) 28%, transparent);' +
  'backdrop-filter: var(--pm-glass-refraction-filter, saturate(1.2)) blur(var(--pm-glass-blur)) saturate(1.2); }'
