let nextFilterId = 0

export function displacementMap(canvas: HTMLCanvasElement, width: number, height: number, radius: number): string | undefined {
  canvas.width = Math.ceil(width / 2)
  canvas.height = Math.ceil(height / 2)
  const context = canvas.getContext('2d')
  if (!context) return
  const image = context.createImageData(canvas.width, canvas.height)
  const halfWidth = width / 2
  const halfHeight = height / 2
  const band = Math.min(22, radius)
  for (let y = 0, index = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++, index += 4) {
      const px = ((x + 0.5) / canvas.width) * width - halfWidth
      const py = ((y + 0.5) / canvas.height) * height - halfHeight
      const qx = Math.abs(px) - halfWidth + radius
      const qy = Math.abs(py) - halfHeight + radius
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
      const depth = radius - outside - Math.min(Math.max(qx, qy), 0)
      const t = band ? Math.max(0, Math.min(1, depth / band)) : 1
      const strength = (1 - t) ** 2 * (1 + 2 * t) * 108
      const nx = outside ? Math.max(0, qx) / outside : Number(qx > qy)
      const ny = outside ? Math.max(0, qy) / outside : Number(qy >= qx)
      image.data[index] = 128 - strength * nx * Math.sign(px)
      image.data[index + 1] = 128 - strength * ny * Math.sign(py)
      image.data[index + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

export class AgendaRefraction {
  private readonly svg: SVGSVGElement
  private readonly displacement: SVGFEDisplacementMapElement
  private readonly observer: ResizeObserver

  constructor(private readonly card: HTMLElement) {
    const doc = card.ownerDocument
    const id = `pm-agenda-refraction-${++nextFilterId}`
    this.svg = doc.body.createSvg('svg', {
      attr: { width: '0', height: '0', 'aria-hidden': 'true', class: 'pm-agenda-refraction-svg' }
    })
    const filter = this.svg.createSvg('filter', {
      attr: { id, x: '0%', y: '0%', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' }
    })
    const map = filter.createSvg('feImage', { attr: { result: 'map', preserveAspectRatio: 'none', x: '0', y: '0' } })
    this.displacement = filter.createSvg('feDisplacementMap', {
      attr: { in: 'SourceGraphic', in2: 'map', xChannelSelector: 'R', yChannelSelector: 'G' }
    })
    const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement
    const win = doc.defaultView
    let measuredWidth = 0
    let measuredHeight = 0
    const resize = () => {
      const { offsetWidth: width, offsetHeight: height } = card
      if (!width || !height || (width === measuredWidth && height === measuredHeight)) return
      const radius = Math.min(
        parseFloat(win?.getComputedStyle(card).borderTopLeftRadius ?? '') || 0,
        width / 2,
        height / 2
      )
      const href = displacementMap(canvas, width, height, radius)
      if (!href) return
      map.setAttribute('width', String(width))
      map.setAttribute('height', String(height))
      map.setAttribute('href', href)
      card.style.setProperty('--pm-glass-refraction-filter', `url(#${id})`)
      card.dataset.glassRefracted = ''
      measuredWidth = width
      measuredHeight = height
    }
    resize()
    const Observer = win?.ResizeObserver ?? ResizeObserver
    this.observer = new Observer(resize)
    this.observer.observe(card)
  }

  setStrength(strength: number): void {
    this.displacement.setAttribute('scale', String(strength * 0.12))
  }

  destroy(): void {
    this.observer.disconnect()
    this.svg.remove()
    this.card.style.removeProperty('--pm-glass-refraction-filter')
    delete this.card.dataset.glassRefracted
  }
}
