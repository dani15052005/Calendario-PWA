(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const uiAgenda = (root.uiAgenda = root.uiAgenda || {});

  function getAgendaSortTime(evt) {
    if (evt?.allDay || evt?.category === 'Festivo') return '00:00';
    return evt?.time || evt?.startTime || '23:59';
  }

  function sortAgendaEvents(events) {
    return (events || []).slice().sort((a, b) => {
      const ta = getAgendaSortTime(a);
      const tb = getAgendaSortTime(b);
      return String(ta).localeCompare(String(tb));
    });
  }

  uiAgenda.getAgendaSortTime = getAgendaSortTime;
  uiAgenda.sortAgendaEvents = sortAgendaEvents;
})();

