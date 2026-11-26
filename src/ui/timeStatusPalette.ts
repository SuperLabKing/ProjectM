import {
  DEFAULT_TIME_STATUS_COLORS,
  readColor,
  type PMSettings,
  type TimeStatus,
  type TimeStatusColorPart,
  type WorkHistoryStatus
} from '@dotpm/core'

type Palette = PMSettings['timeStatusColors']
export const timeStatuses = Object.keys(DEFAULT_TIME_STATUS_COLORS) as TimeStatus[]
export const timeStatusColorParts: readonly TimeStatusColorPart[] = ['background', 'symbol', 'text']

export function normalizeTimeStatusColors(current: Partial<Record<TimeStatus, unknown>> | undefined, legacy?: Partial<Record<TimeStatus, unknown>>): Palette {
  const colors: Palette = {}
  for (const status of timeStatuses) {
    const saved = current?.[status]
    const parts: Partial<Record<TimeStatusColorPart, string>> = {}
    for (const part of timeStatusColorParts) {
      const value = saved && typeof saved === 'object' ? (saved as Record<string, unknown>)[part] : undefined
      const color = readColor(value) ?? (part === 'background' ? readColor(saved) ?? readColor(legacy?.[status]) : null)
      if (color) parts[part] = color
    }
    if (Object.keys(parts).length) colors[status] = parts
  }
  return colors
}

export function resolveTimeStatusColors(palette: Palette, status: TimeStatus) {
  const parts = palette[status]
  const background = parts?.background ?? DEFAULT_TIME_STATUS_COLORS[status]
  const contrast = contrastInk(background)
  return {
    background,
    symbol: parts?.symbol ?? contrast,
    text: parts?.text,
    solidText: parts?.text ?? contrast
  }
}

function contrastInk(color: string): string {
  const [red, green, blue] = [1, 3, 5].map((index) => {
    const channel = parseInt(color.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.179 ? '#000000' : '#ffffff'
}

const paths: Record<WorkHistoryStatus, string> = {
  start: 'M5 4v8m6-8v8',
  completion: 'm4 8 3 3 5-6',
  hold: 'M6 3l7 5-7 5z',
  cancellation: 'm5 5 6 6m0-6-6 6'
}

function checkboxGlyph(status: WorkHistoryStatus, ink: string): string {
  const style = status === 'hold' ? `fill="${ink}"` : `fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${paths[status]}" ${style}/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export function writeTimeStatusPalette(doc: Document, palette?: Palette): void {
  for (const status of timeStatuses) {
    writeTimeStatusColor(doc.documentElement.style, palette, status)
  }
}

export function writeTimeStatusColor(style: CSSStyleDeclaration, palette: Palette | undefined, status: TimeStatus): void {
  const key = '--pm-time-' + status
  if (!palette) {
    for (const suffix of ['', '-ink', '-solid-text', '-text', '-dot', '-glyph']) style.removeProperty(key + suffix)
    return
  }
  const { background, symbol, text, solidText } = resolveTimeStatusColors(palette, status)
  style.setProperty(key, background)
  style.setProperty(key + '-ink', symbol)
  style.setProperty(key + '-solid-text', solidText)
  style.setProperty(key + '-text', text ?? '')
  style.setProperty(key + '-dot', palette[status]?.symbol ?? background)
  if (status !== 'plan') style.setProperty(key + '-glyph', checkboxGlyph(status, symbol))
}
