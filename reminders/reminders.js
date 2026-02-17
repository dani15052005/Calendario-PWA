(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const reminders = (root.reminders = root.reminders || {});

  function getReminderStartAtISO(evt, localPartsToISO) {
    const dateStr = evt?.startDate || evt?.date;
    if (!dateStr) return null;
    const timeStr = evt?.allDay ? '00:00' : (evt?.startTime || evt?.time || '00:00');
    return localPartsToISO(dateStr, timeStr);
  }

  function getReminderAtISO(evt, parseDateInput) {
    const dateStr = evt?.startDate || evt?.date;
    if (!dateStr) return null;
    const d = parseDateInput(dateStr);
    if (!d || Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() - 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  function shouldSkipReminder(evt) {
    return !!(evt?.isHoliday || evt?.category === 'Festivo');
  }

  reminders.getReminderStartAtISO = getReminderStartAtISO;
  reminders.getReminderAtISO = getReminderAtISO;
  reminders.shouldSkipReminder = shouldSkipReminder;
})();

