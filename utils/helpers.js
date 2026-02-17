(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const utils = (root.utils = root.utils || {});

  function normalizeString(value, fallback = '') {
    return String(value ?? fallback).trim();
  }

  function normalizeEmail(value) {
    return normalizeString(value).toLowerCase();
  }

  function appendCacheBuster(url, param = 'u', nowMs = Date.now()) {
    try {
      const target = new URL(url, window.location.origin);
      target.searchParams.set(param, String(nowMs));
      return target.toString();
    } catch {
      const raw = String(url || '');
      const hasQuery = raw.includes('?');
      return `${raw}${hasQuery ? '&' : '?'}${param}=${nowMs}`;
    }
  }

  function safeRemoveNode(node) {
    try {
      node?.remove?.();
      return true;
    } catch {
      return false;
    }
  }

  function safeRemoveById(id) {
    if (!id) return false;
    return safeRemoveNode(document.getElementById(id));
  }

  function safeCall(fn, fallback = null) {
    try {
      return typeof fn === 'function' ? fn() : fallback;
    } catch {
      return fallback;
    }
  }

  function structuredLog(channel, event, payload = {}, level = 'info') {
    const line = `[${String(channel || 'APP').toUpperCase()}] ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload
    })}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  }

  utils.normalizeString = normalizeString;
  utils.normalizeEmail = normalizeEmail;
  utils.appendCacheBuster = appendCacheBuster;
  utils.safeRemoveNode = safeRemoveNode;
  utils.safeRemoveById = safeRemoveById;
  utils.safeCall = safeCall;
  utils.structuredLog = structuredLog;
})();

