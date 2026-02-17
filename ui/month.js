(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const uiMonth = (root.uiMonth = root.uiMonth || {});

  function buildMonthDayKeys(year, month, toYMD) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const keys = [];
    for (let day = 1; day <= last.getDate(); day += 1) {
      keys.push(toYMD(new Date(first.getFullYear(), first.getMonth(), day)));
    }
    return keys;
  }

  uiMonth.buildMonthDayKeys = buildMonthDayKeys;
})();

