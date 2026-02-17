(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const dataSupabase = (root.dataSupabase = root.dataSupabase || {});

  function normalizeSessionContext(payload) {
    const session = payload?.session || payload?.data?.session || null;
    const user = session?.user || null;
    return {
      session,
      user,
      userId: user?.id || null,
      email: String(user?.email || '')
    };
  }

  function createUserRowEnsurer() {
    let lastEnsuredUserId = null;
    return async function ensureUserRow(ctx, upsertFn) {
      if (!ctx?.userId) throw new Error('userId requerido');
      if (lastEnsuredUserId === ctx.userId) return false;
      await upsertFn(ctx);
      lastEnsuredUserId = ctx.userId;
      return true;
    };
  }

  dataSupabase.normalizeSessionContext = normalizeSessionContext;
  dataSupabase.createUserRowEnsurer = createUserRowEnsurer;
})();

