import { AGENDA_GLASS_PARAMS, type PMSettings } from '@dotpm/core'

export type GlassField = keyof typeof AGENDA_GLASS_PARAMS

export function glassValue(key: GlassField, value: unknown): number {
  const { initial, max } = AGENDA_GLASS_PARAMS[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : initial
}

export function glassProperties(settings: PMSettings): Record<string, string> {
  const value = (key: GlassField) => glassValue(key, settings[key])
  return {
    '--pm-glass-blur': `${value('agendaGlassBlur')}px`,
    '--pm-glass-rim-width': `${value('agendaGlassRefraction') / 100}px`,
    '--pm-glass-dispersion': `${value('agendaGlassDispersion') / 2}%`,
    '--pm-glass-shade': `${value('agendaGlassShade') * 0.08}%`
  }
}
