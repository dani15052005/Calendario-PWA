(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const syncReconcile = (root.syncReconcile = root.syncReconcile || {});

  function safeISODateTime(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated) {
    const remoteIso = safeISODateTime(remoteUpdated);
    const localIso = safeISODateTime(localKnownUpdated);
    if (!remoteIso) return false;
    if (!localIso) return true;
    return new Date(remoteIso).getTime() > new Date(localIso).getTime();
  }

  function hasRemoteVersionChanged(remoteUpdated, localKnownUpdated, remoteEtag, localKnownEtag) {
    if (isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated)) return true;
    if (remoteEtag && localKnownEtag && String(remoteEtag) !== String(localKnownEtag)) return true;
    return false;
  }

  function shouldApplyGoogleOverLocal(localEvent, remoteUpdated, remoteEtag = null) {
    if (!localEvent) return true;
    if (!localEvent.needsGCalSync) return true;
    if (!localEvent.gcalUpdated && !localEvent.gcalEtag) return true;
    return hasRemoteVersionChanged(remoteUpdated, localEvent.gcalUpdated, remoteEtag, localEvent.gcalEtag);
  }

  syncReconcile.safeISODateTime = safeISODateTime;
  syncReconcile.isRemoteGoogleVersionNewer = isRemoteGoogleVersionNewer;
  syncReconcile.hasRemoteVersionChanged = hasRemoteVersionChanged;
  syncReconcile.shouldApplyGoogleOverLocal = shouldApplyGoogleOverLocal;
})();

