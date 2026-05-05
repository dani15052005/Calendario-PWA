import { useQuery } from '@tanstack/react-query'
import { startOfMonth, endOfMonth } from 'date-fns'
import { supabase } from '@/lib/supabase'
import type { CalendarEvent } from '@/lib/types'

const SELECT_COLUMNS = [
  'id', 'user_id', 'title', 'start_at', 'end_at', 'all_day',
  'location', 'notes', 'url', 'color',
  'is_holiday', 'locked', 'source',
  'needs_gcal_sync', 'gcal_updated', 'gcal_etag', 'last_synced_at',
  'remote_missing', 'remote_missing_at',
  'google_event_id', 'google_calendar_id',
  'meta', 'created_at', 'updated_at',
].join(',')

/**
 * Devuelve eventos cuyo rango [start_at, end_at] solapa con el mes
 * pintado. Los festivos están incluidos.
 */
export function useMonthEvents(monthAnchor: Date) {
  const monthStart = startOfMonth(monthAnchor).toISOString()
  const monthEnd = endOfMonth(monthAnchor).toISOString()

  return useQuery<CalendarEvent[]>({
    queryKey: ['events', 'month', monthStart, monthEnd],
    queryFn: async () => {
      // Solapamiento de rangos: start_at < endOfMonth AND end_at > startOfMonth
      const { data, error } = await supabase
        .from('events')
        .select(SELECT_COLUMNS)
        .lt('start_at', monthEnd)
        .gt('end_at', monthStart)
        .order('start_at', { ascending: true })

      if (error) throw error
      return ((data ?? []) as unknown) as CalendarEvent[]
    },
    staleTime: 30_000,
  })
}
