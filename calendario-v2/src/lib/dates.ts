import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isSameDay,
  addMonths,
} from 'date-fns'
import { es } from 'date-fns/locale'

export const SPANISH_LOCALE = es

/**
 * Devuelve la matriz 6×7 de días para pintar el calendario mensual,
 * empezando en lunes (estilo europeo).
 */
export function buildMonthGrid(date: Date): Date[] {
  const monthStart = startOfMonth(date)
  const monthEnd = endOfMonth(date)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
  return eachDayOfInterval({ start: gridStart, end: gridEnd })
}

export function formatMonthYear(date: Date): string {
  // p.ej. "mayo 2026"
  return format(date, 'MMMM yyyy', { locale: SPANISH_LOCALE })
}

export function formatDayNumber(date: Date): string {
  return format(date, 'd')
}

export function isInMonth(date: Date, monthAnchor: Date): boolean {
  return isSameMonth(date, monthAnchor)
}

export function isToday(date: Date, today = new Date()): boolean {
  return isSameDay(date, today)
}

export function shiftMonth(date: Date, delta: number): Date {
  return addMonths(date, delta)
}

export const WEEKDAYS_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const
