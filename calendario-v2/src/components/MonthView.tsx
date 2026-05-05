import { useMemo } from 'react'
import { isSameDay } from 'date-fns'
import {
  buildMonthGrid,
  formatDayNumber,
  isInMonth,
  isToday,
  WEEKDAYS_SHORT,
} from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useMonthEvents } from '@/hooks/useMonthEvents'
import type { CalendarEvent } from '@/lib/types'

interface MonthViewProps {
  monthAnchor: Date
  onSelectDay?: (day: Date) => void
}

export function MonthView({ monthAnchor, onSelectDay }: MonthViewProps) {
  const days = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor])
  const { data: events, isLoading, error } = useMonthEvents(monthAnchor)

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    if (!events) return map
    for (const evt of events) {
      const start = new Date(evt.start_at)
      const end = new Date(evt.end_at)
      const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
      const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      for (const day of days) {
        if (day >= startDay && day <= endDay) {
          const dayKey = day.toISOString().slice(0, 10)
          if (!map.has(dayKey)) map.set(dayKey, [])
          map.get(dayKey)!.push(evt)
        }
      }
    }
    return map
  }, [events, days])

  return (
    <section
      aria-label="Calendario mensual"
      className="rounded-[var(--radius-lg)] bg-transparent"
    >
      <div className="grid grid-cols-7 gap-1.5 mb-2 px-1">
        {WEEKDAYS_SHORT.map((d) => (
          <div
            key={d}
            className="text-center text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-muted py-1"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const dayKey = day.toISOString().slice(0, 10)
          const dayEvents = eventsByDay.get(dayKey) ?? []
          const isOtherMonth = !isInMonth(day, monthAnchor)
          const isCurrentDay = isToday(day)
          const isWeekend = day.getDay() === 0 || day.getDay() === 6

          return (
            <button
              key={dayKey}
              type="button"
              onClick={() => onSelectDay?.(day)}
              className={cn(
                'group relative flex flex-col text-left p-1.5 sm:p-2 rounded-[var(--radius)]',
                'min-h-[clamp(72px,13vw,128px)] gap-1',
                'border bg-white shadow-[var(--shadow-xs)]',
                'transition-[border-color,box-shadow,transform,background] duration-150',
                'hover:border-border hover:shadow-[var(--shadow-sm)] hover:-translate-y-px',
                'focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_rgb(14_165_233/0.30)]',
                isOtherMonth && 'bg-surface-soft opacity-65 border-border-soft',
                isWeekend && !isOtherMonth && 'bg-[#fcfcfd]',
                isCurrentDay && 'border-primary shadow-[0_0_0_2px_rgb(14_165_233/0.30),var(--shadow-xs)]',
                !isOtherMonth && !isCurrentDay && 'border-border-soft'
              )}
            >
              <div
                className={cn(
                  'inline-flex items-center justify-center',
                  isCurrentDay
                    ? 'w-[26px] h-[26px] rounded-full bg-primary text-white font-bold text-[0.85rem]'
                    : 'text-[0.86rem] font-semibold',
                  isOtherMonth ? 'text-muted-2' : 'text-text-2'
                )}
              >
                {formatDayNumber(day)}
              </div>

              {dayEvents.length > 0 && (
                <ul className="flex flex-col gap-[3px] m-0 p-0 list-none mt-0.5 w-full">
                  {dayEvents.slice(0, 3).map((evt) => {
                    const evtStart = new Date(evt.start_at)
                    const isStart = isSameDay(evtStart, day)
                    const cat = getEventCategory(evt)
                    return (
                      <li
                        key={evt.id + dayKey}
                        className={cn(
                          'relative flex items-center gap-1 truncate text-[0.72rem] font-medium leading-[1.25] py-[3px] pr-2 pl-[18px] rounded-[6px]',
                          'before:absolute before:left-[7px] before:top-1/2 before:-translate-y-1/2 before:w-[6px] before:h-[6px] before:rounded-full',
                          eventChipColor(cat)
                        )}
                        title={evt.title}
                      >
                        {!evt.all_day && isStart && (
                          <span className="text-[0.65rem] opacity-70 shrink-0">
                            {String(evtStart.getHours()).padStart(2, '0')}:
                            {String(evtStart.getMinutes()).padStart(2, '0')}
                          </span>
                        )}
                        <span className="truncate">{evt.title}</span>
                      </li>
                    )
                  })}
                  {dayEvents.length > 3 && (
                    <li className="text-[0.65rem] text-muted px-2 mt-0.5">
                      +{dayEvents.length - 3} más
                    </li>
                  )}
                </ul>
              )}
            </button>
          )
        })}
      </div>

      {isLoading && (
        <p className="text-center text-sm text-muted mt-3">Cargando eventos…</p>
      )}
      {error && (
        <p className="text-center text-sm text-danger mt-3">
          Error al cargar eventos: {(error as Error).message}
        </p>
      )}
    </section>
  )
}

function getEventCategory(evt: CalendarEvent): string {
  if (evt.is_holiday || evt.source === 'holiday') return 'festivo'
  const meta = (evt.meta ?? {}) as Record<string, unknown>
  const cat = String(meta.category ?? '').toLowerCase().trim()
  return cat || 'otros'
}

function eventChipColor(category: string): string {
  switch (category) {
    case 'trabajo':
      return 'bg-[rgb(29_78_216/0.08)] text-[#1d4ed8] before:bg-[#2563eb]'
    case 'evento':
      return 'bg-[rgb(13_148_136/0.10)] text-[#0f766e] before:bg-[#0d9488]'
    case 'citas':
      return 'bg-[rgb(180_83_9/0.10)] text-[#b45309] before:bg-[#d97706]'
    case 'cumpleaños':
    case 'cumple':
      return 'bg-[rgb(147_51_234/0.10)] text-[#7e22ce] before:bg-[#9333ea]'
    case 'festivo':
      return 'bg-[rgb(2_132_199/0.10)] text-[#0369a1] before:bg-[#0284c7]'
    case 'otros':
    default:
      return 'bg-[rgb(71_85_105/0.10)] text-[#475569] before:bg-[#64748b]'
  }
}
