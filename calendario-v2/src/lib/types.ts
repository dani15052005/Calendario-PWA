// Modelos de dominio que coinciden con las columnas reales de Supabase
// (linaje canónico documentado en Calendario-PWA-main/supabase/MIGRATIONS.md).

export type EventSource = 'local' | 'google' | 'holiday'

export interface CalendarEvent {
  id: string
  user_id: string
  title: string
  start_at: string
  end_at: string
  all_day: boolean
  location: string | null
  notes: string | null
  url: string | null
  color: string | null
  is_holiday: boolean
  locked: boolean
  source: EventSource
  needs_gcal_sync: boolean
  gcal_updated: string | null
  gcal_etag: string | null
  last_synced_at: string | null
  remote_missing: boolean
  remote_missing_at: string | null
  google_event_id: string | null
  google_calendar_id: string | null
  meta: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface AttachmentMeta {
  id: string
  event_id: string
  user_id: string
  drive_file_id: string
  file_type: string | null
  file_name: string
  created_at: string
}

export type CalendarView = 'month' | 'week' | 'day' | 'agenda'
