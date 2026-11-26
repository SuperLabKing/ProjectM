// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { DEFAULT_TIME_STATUS_COLORS } from '@dotpm/core'
import { normalizeTimeStatusColors, resolveTimeStatusColors, writeTimeStatusPalette } from './timeStatusPalette'

describe('time status palette', () => {
  it('preserves legacy review colors and prioritizes valid values from the shared palette', () => {
    const colors = normalizeTimeStatusColors(
      { start: '#abc', hold: { background: 'invalid', symbol: '#123456', text: '#fee' } },
      { start: '#112233', hold: '#998877', cancellation: '#778899' }
    )
    expect(colors).toEqual({
      start: { background: '#aabbcc' },
      hold: { background: '#998877', symbol: '#123456', text: '#ffeeee' },
      cancellation: { background: '#778899' }
    })
    expect(resolveTimeStatusColors(colors, 'plan').background).toBe(DEFAULT_TIME_STATUS_COLORS.plan)
  })

  it('publishes matching states and legible glyphs for both dark and light fills', () => {
    const doc = document.implementation.createHTMLDocument()
    const { style } = doc.documentElement
    writeTimeStatusPalette(doc, {
      start: { background: '#000000' },
      completion: { background: '#ffffff', symbol: '#345678', text: '#102030' }
    })
    expect(style.getPropertyValue('--pm-time-start-ink')).toBe('#ffffff')
    expect(style.getPropertyValue('--pm-time-completion-ink')).toBe('#345678')
    expect(style.getPropertyValue('--pm-time-completion-solid-text')).toBe('#102030')
    expect(style.getPropertyValue('--pm-time-completion-text')).toBe('#102030')
    expect(style.getPropertyValue('--pm-time-completion-glyph')).toContain('%23345678')
    expect(style.getPropertyValue('--pm-time-start-text')).toBe('')
    expect(style.getPropertyValue('--pm-time-start-solid-text')).toBe('#ffffff')
    expect(style.getPropertyValue('--pm-time-start-glyph')).toContain('%23ffffff')
    expect(style.getPropertyValue('--pm-time-plan')).toBe(DEFAULT_TIME_STATUS_COLORS.plan)
    writeTimeStatusPalette(doc)
    expect(style.getPropertyValue('--pm-time-start-glyph')).toBe('')
    expect(style.getPropertyValue('--pm-time-plan')).toBe('')
    expect(style.getPropertyValue('--pm-time-completion-text')).toBe('')
  })
})
