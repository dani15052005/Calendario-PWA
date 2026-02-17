(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const uiWeek = (root.uiWeek = root.uiWeek || {});

  function getWeekStart(date) {
    const d = new Date(date || Date.now());
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - (day - 1));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function buildWeekDays(anchorDate) {
    const start = getWeekStart(anchorDate);
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }

  uiWeek.getWeekStart = getWeekStart;
  uiWeek.buildWeekDays = buildWeekDays;
})();

