import { Menu } from 'obsidian'
import { t, type TableAlignment, type TableColumnAlignment } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'
import type PMPlugin from '#main'

const choices = [
  { value: 'left', icon: 'align-left', label: 'table.alignLeft' },
  { value: 'center', icon: 'align-center', label: 'table.alignCenter' },
  { value: 'right', icon: 'align-right', label: 'table.alignRight' }
] as const

function setAlignment(el: HTMLElement, value: TableAlignment | undefined): void {
  if (value) el.dataset.pmAlign = value
  else delete el.dataset.pmAlign
}

export function attachColumnAlignment(header: HTMLTableCellElement, id: string, plugin: PMPlugin, scope: string): void {
  const alignments = () => plugin.settings.tableColumnAlignments?.[scope]?.[id]
  const paint = (values: TableColumnAlignment | undefined) => {
    setAlignment(header, values?.header)
    if (values?.cell) header.dataset.pmCellAlign = values.cell
    else delete header.dataset.pmCellAlign
  }
  paint(alignments())

  const open = () => {
    const values = alignments()
    const menu = new Menu()
    for (const target of ['header', 'cell'] as const) {
      if (target === 'cell') menu.addSeparator()
      for (const { value, icon, label } of choices) {
        const alignment = t(label)
        menu.addItem((item) => {
          item
            .setTitle(t(target === 'header' ? 'table.alignHeader' : 'table.alignCell', { alignment }))
            .setIcon(icon)
            .setChecked((values?.[target] ?? 'left') === value)
            .onClick(
              safeAsync(async () => {
                const settings = (plugin.settings.tableColumnAlignments ??= {})
                const columns = (settings[scope] ??= {})
                const next = (columns[id] = { ...columns[id], [target]: value })
                paint(next)
                const table = header.closest('table')
                if (table) syncTableCellAlignment(table)
                await plugin.saveSettings()
              })
            )
        })
      }
    }
    return menu
  }
  header.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    open().showAtMouseEvent(event)
  })
  header.addEventListener('keydown', (event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    const { left, bottom } = header.getBoundingClientRect()
    open().showAtPosition({ x: left, y: bottom })
  })
}

/** The virtual table calls this again whenever it paints a new batch of rows. */
export function syncTableCellAlignment(table: HTMLTableElement): void {
  const headers = table.tHead?.querySelectorAll<HTMLTableCellElement>('th[data-pm-cell-align]')
  if (!headers?.length) return
  const rows = table.tBodies[0]?.querySelectorAll<HTMLTableRowElement>('tr.pm-table-row')
  for (const row of rows ?? []) {
    for (const header of headers) {
      const cell = row.cells[header.cellIndex]
      if (cell) setAlignment(cell, header.dataset.pmCellAlign as TableAlignment)
    }
  }
}
