import { t } from '@dotpm/core'
import { getIconIds, setIcon } from '#platform'
import { Popover } from '#primitives/Popover'
import { commonProjectIcons, makeIconSearch } from './iconSearch'
import { renderGlyph, renderOptionRow } from './optionList'

export interface IconControlOpts {
  container: HTMLElement
  value: string
  onChange: (icon: string) => void
  /** Tints the preview. */
  color?: string
  history?: {
    read(): readonly { id: string; count: number }[]
    remember(id: string): void
  }
}

const GRID_LIMIT = 96

function isGlyphQuery(query: string): boolean {
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}]*$/u.test(query)
}

/** An icon preview that opens a searchable grid of every icon Obsidian knows. */
export function renderIconControl(opts: IconControlOpts): void {
  let value = opts.value
  const trigger = opts.container.createEl('button', { cls: 'pm-prop-inline pm-icon-trigger' })

  const drawTrigger = (): void => {
    trigger.empty()
    trigger.toggleClass('pm-prop-inline--empty', !value)
    if (value) renderGlyph(trigger, { icon: value, color: opts.color })
    else setIcon(trigger.createSpan({ cls: 'pm-glyph-icon' }), 'plus')
    const chevron = trigger.createSpan({ cls: 'pm-prop-chevron' })
    setIcon(chevron, 'chevron-down')
  }
  drawTrigger()

  let pop: Popover | null = null
  trigger.addEventListener('click', () => {
    if (pop?.isOpen) {
      pop.close()
      return
    }
    const popover = new Popover({ anchor: trigger, width: 304, onClose: () => (pop = null) })
    pop = popover
    const icons = makeIconSearch(getIconIds())

    const commit = (icon: string): void => {
      value = icon
      drawTrigger()
      const id = icons.resolve(icon)
      if (id) opts.history?.remember(id)
      popover.close()
      opts.onChange(icon)
    }

    const search = popover.contentEl.createEl('input', {
      cls: 'pm-pop-field',
      attr: { placeholder: t('property.searchIcons'), 'aria-label': t('property.searchIcons'), spellcheck: 'false' }
    })
    const clearRow = popover.contentEl.createDiv()
    renderOptionRow(clearRow, {
      label: t('property.noIcon'),
      icon: 'ban',
      selected: !value,
      onPick: () => commit('')
    })
    const shortcuts = popover.contentEl.createDiv('pm-icon-shortcuts')
    const grid = popover.contentEl.createDiv('pm-icon-grid')
    const hint = popover.contentEl.createDiv({ cls: 'pm-icon-grid-hint', attr: { role: 'status' } })
    const more = popover.contentEl.createEl('button', { cls: 'pm-pop-item pm-icon-more', text: t('property.moreIcons'), type: 'button' })

    const addIcon = (parent: HTMLElement, id: string): void => {
      const name = id.replace(/^lucide-/, '')
      const cell = parent.createEl('button', { cls: 'pm-icon-cell', type: 'button', attr: { 'aria-label': name, title: name } })
      const selected = id === icons.resolve(value)
      cell.toggleClass('pm-icon-cell--selected', selected)
      cell.setAttribute('aria-pressed', String(selected))
      setIcon(cell, id)
      cell.addEventListener('click', () => commit(id))
    }
    if (opts.history) {
      const history = opts.history.read()
      const recent = history.map(({ id }) => id)
      const frequent = history.filter(({ count }) => count > 1).sort((a, b) => b.count - a.count).map(({ id }) => id)
      const candidates = [...recent.slice(0, 4), ...frequent, ...recent.slice(4), ...commonProjectIcons]
      const entries = [...new Set(candidates.flatMap((id) => icons.resolve(id) ?? []))].slice(0, 8)
      if (entries.length) {
        shortcuts.createDiv({ cls: 'pm-icon-section-label', text: t('property.quickIcons') })
        const row = shortcuts.createDiv('pm-icon-grid')
        for (const id of entries) addIcon(row, id)
      }
    }
    let found: string[] = []
    let shown = 0
    const showNext = (): void => {
      const page = found.slice(shown, shown + GRID_LIMIT)
      for (const id of page) addIcon(grid, id)
      shown += page.length
      more.hidden = shown >= found.length
      hint.setText(shown < found.length ? t('property.iconsShowing', { shown, total: found.length }) : '')
    }
    more.addEventListener('click', () => {
      const previous = grid.children.length
      showNext()
      grid.querySelectorAll('button')[previous]?.focus()
    })

    const renderGrid = (): void => {
      const query = search.value.trim()
      grid.empty()
      shortcuts.hidden = !!query
      found = icons.match(query)
      shown = 0
      const glyph = isGlyphQuery(query)
      if (glyph) {
        const cell = grid.createEl('button', { cls: 'pm-icon-cell pm-icon-cell--glyph', text: query })
        cell.toggleClass('pm-icon-cell--selected', query === value)
        cell.setAttribute('aria-label', t('property.useGlyph', { glyph: query }))
        cell.addEventListener('click', () => commit(query))
      }

      showNext()
      if (!found.length && !glyph) {
        hint.setText(t('property.noIconMatch'))
      }
    }

    search.addEventListener('input', () => renderGrid())
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      const query = search.value.trim()
      if (isGlyphQuery(query)) commit(query)
      else if (query) {
        const first = found[0]
        if (first) commit(first)
      }
    })

    renderGrid()
    popover.open()
    search.focus()
  })
}
