(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const coreState = (root.coreState = root.coreState || {});

  const DEFAULT_CATEGORIES = Object.freeze([
    'Trabajo',
    'Evento',
    'Citas',
    'Cumplea\u00f1os',
    'Otros',
    'Festivo'
  ]);

  const DEFAULT_GOOGLE_CALENDARS = Object.freeze([
    { id: 'primary', summary: 'Principal', primary: true }
  ]);

  const DEFAULT_CALENDAR_FILTERS = Object.freeze(['primary']);

  function normalizeCategorySet(input) {
    const list = Array.isArray(input) ? input : [];
    const out = new Set(list.filter(Boolean).map((v) => String(v).trim()));
    if (!out.size) {
      DEFAULT_CATEGORIES.forEach((cat) => out.add(cat));
    }
    return out;
  }

  function normalizeCalendarFilters(input) {
    const list = Array.isArray(input) ? input : [];
    const out = new Set(list.filter(Boolean).map((v) => String(v).trim()));
    if (!out.size) {
      DEFAULT_CALENDAR_FILTERS.forEach((id) => out.add(id));
    }
    return out;
  }

  function createInitialState({
    now = new Date(),
    theme = null,
    density = null
  } = {}) {
    const fallbackTheme = theme ?? (localStorage.getItem('theme') || 'dark');
    const fallbackDensity = density ?? (localStorage.getItem('month.density') || 'compact');

    return {
      db: null,
      theme: fallbackTheme,
      viewMode: 'month',
      currentMonth: new Date(now.getFullYear(), now.getMonth(), 1),
      selectedDate: null,
      filters: normalizeCategorySet(DEFAULT_CATEGORIES),
      googleCalendars: DEFAULT_GOOGLE_CALENDARS.map((cal) => ({ ...cal })),
      calendarFilters: normalizeCalendarFilters(DEFAULT_CALENDAR_FILTERS),
      selectedGoogleCalendarId: 'primary',
      holidaysCache: new Map(),
      monthDensity: fallbackDensity,
      dataLoading: false,
      lastDataError: null
    };
  }

  coreState.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
  coreState.DEFAULT_GOOGLE_CALENDARS = DEFAULT_GOOGLE_CALENDARS;
  coreState.DEFAULT_CALENDAR_FILTERS = DEFAULT_CALENDAR_FILTERS;
  coreState.normalizeCategorySet = normalizeCategorySet;
  coreState.normalizeCalendarFilters = normalizeCalendarFilters;
  coreState.createInitialState = createInitialState;
})();
