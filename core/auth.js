(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const coreAuth = (root.coreAuth = root.coreAuth || {});

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function normalizeProvider(provider) {
    return String(provider || '').trim().toLowerCase();
  }

  function getSessionUser(session) {
    return session?.user || null;
  }

  function getSessionProvider(session) {
    return normalizeProvider(session?.user?.app_metadata?.provider || '');
  }

  function isGoogleSession(session) {
    return getSessionProvider(session) === 'google';
  }

  function getSessionEmail(session) {
    return normalizeEmail(session?.user?.email || '');
  }

  coreAuth.normalizeEmail = normalizeEmail;
  coreAuth.normalizeProvider = normalizeProvider;
  coreAuth.getSessionUser = getSessionUser;
  coreAuth.getSessionProvider = getSessionProvider;
  coreAuth.isGoogleSession = isGoogleSession;
  coreAuth.getSessionEmail = getSessionEmail;
})();

