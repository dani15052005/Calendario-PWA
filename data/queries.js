(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const dataQueries = (root.dataQueries = root.dataQueries || {});

  const SB_EVENT_SELECT_COLUMNS = [
    'id',
    'title',
    'start_at',
    'end_at',
    'all_day',
    'location',
    'notes',
    'url',
    'color',
    'locked',
    'is_holiday',
    'source',
    'last_synced_at',
    'remote_missing',
    'remote_missing_at',
    'needs_gcal_sync',
    'gcal_updated',
    'gcal_etag',
    'google_event_id',
    'google_calendar_id',
    'meta',
    'created_at',
    'updated_at'
  ].join(',');

  const SB_ATTACHMENT_SELECT_COLUMNS = [
    'id',
    'event_id',
    'drive_file_id',
    'file_type',
    'file_name',
    'created_at'
  ].join(',');

  function applyRangeOverlap(query, {
    startISO = null,
    endISO = null,
    startCol = 'start_at',
    endCol = 'end_at'
  } = {}) {
    let next = query;
    if (endISO) next = next.lt(startCol, endISO);
    if (startISO) next = next.gt(endCol, startISO);
    return next;
  }

  dataQueries.SB_EVENT_SELECT_COLUMNS = SB_EVENT_SELECT_COLUMNS;
  dataQueries.SB_ATTACHMENT_SELECT_COLUMNS = SB_ATTACHMENT_SELECT_COLUMNS;
  dataQueries.applyRangeOverlap = applyRangeOverlap;
})();
