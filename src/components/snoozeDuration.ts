import { tn } from '@dotpm/core'

export const SNOOZE_PRESETS = [5, 10, 15, 30, 60, 120]
export const MAX_SNOOZE_MINUTES = 1440

export function isSnoozeDuration(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SNOOZE_MINUTES
}

export function snoozeDuration(value: number): number {
  return isSnoozeDuration(value) ? value : 10
}

export function snoozeDurationLabel(minutes: number): string {
  return minutes % 60 === 0 ? tn('agenda.hours', minutes / 60) : tn('agenda.minutes', minutes)
}
