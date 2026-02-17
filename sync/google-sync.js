(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const googleSync = (root.googleSync = root.googleSync || {});

  function createGlobalMutex() {
    let inFlight = false;
    return {
      isLocked() {
        return inFlight;
      },
      async withLock(fn, { onSkip = null } = {}) {
        if (inFlight) {
          if (typeof onSkip === 'function') onSkip();
          return { skipped: true, reason: 'sync_in_flight' };
        }
        inFlight = true;
        try {
          return await fn();
        } finally {
          inFlight = false;
        }
      }
    };
  }

  googleSync.createGlobalMutex = createGlobalMutex;
})();

