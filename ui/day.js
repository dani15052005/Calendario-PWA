(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const uiDay = (root.uiDay = root.uiDay || {});

  function isSameDay(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  uiDay.isSameDay = isSameDay;
})();

