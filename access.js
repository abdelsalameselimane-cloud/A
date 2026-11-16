/* access.js — عميل صلاحيات الاشتراكات (عام: يصلح لأي موقع Firebase)
 *
 *   const Acc = AccessSDK.create({
 *     endpoint: "https://<project>.supabase.co/functions/v1/check-access",
 *     apiKey:   "sk_...",                       // مفتاح الموقع (عام بطبيعته)
 *     plansUrl: "https://.../plans.html?site=<uuid>",
 *     getIdentity: async () => ({ uid, token }) // token = رمز Firebase ID، أو null إن لم يتوفر
 *   });
 *   Acc.can("feature_key") / Acc.limit("key") / Acc.consume("key", n) / Acc.onChange(fn)
 *
 * القواعد: الخادم هو مصدر الصلاحيات. تُخزَّن آخر نتيجة صحيحة للعمل دون إنترنت (ttlDays)،
 * ولا تتجاوز أبداً تاريخ انتهاء الاشتراك. بعد انتهاء المخزَّن يُستعمل مخزَّن "بدون اشتراك".
 * إن لم تتوفر أي نتيجة قط (خادم لا يستجيب منذ البداية) تُفتح الميزات (fail-open) مع status = "unknown".
 */
(function (g) {
  "use strict";
  const DAY = 864e5;

  function create(cfg) {
    const C = Object.assign({ ttlDays: 3, key: "acc_v1", timeoutMs: 8000, refreshMs: 15 * 60 * 1000, dev: false }, cfg);
    let cur = null, pending = null, last = 0, attempted = null, subs = [];

    const load = (id) => { try { return JSON.parse(localStorage.getItem(C.key + ":" + id)) || null; } catch (e) { return null; } };
    const save = (id, o) => { try { localStorage.setItem(C.key + ":" + id, JSON.stringify(o)); } catch (e) { /* ignore */ } };
    const valid = (o) => {
      if (!o || !o.data || typeof o.at !== "number") return false;
      const now = Date.now();
      if (o.at > now + DAY) return false;                                   // ساعة الجهاز رُجعت للخلف
      if (now > o.at + C.ttlDays * DAY) return false;                       // انتهت مدة التخزين
      const s = o.data.subscription;
      if (s && s.ends_at && now >= Date.parse(s.ends_at)) return false;     // لا يتجاوز انتهاء الاشتراك
      return true;
    };
    const emit = () => subs.slice().forEach((fn) => { try { fn(api); } catch (e) { /* ignore */ } });

    async function call(body) {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), C.timeoutMs);
      try {
        const r = await fetch(C.endpoint, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-api-key": C.apiKey }, body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const e = new Error(j.error || "http_" + r.status); e.status = r.status; throw e; }
        return j;
      } finally { clearTimeout(to); }
    }

    async function run() {
      if (C.dev) { cur = { id: "dev", dev: true }; return; }
      let ident = null;
      try { ident = await C.getIdentity(); } catch (e) { ident = null; }
      let id = ident && ident.uid ? "u:" + ident.uid : "anon";
      attempted = id;
      try {
        if (ident && ident.uid && !ident.token) throw new Error("no_token");   // لا نستعلم كزائر عن مستخدم معروف
        let data;
        try { data = await call(ident && ident.token ? { action: "check", token: ident.token } : { action: "check" }); }
        catch (e) {
          if (e.status === 401 && ident && ident.token) { id = "anon"; data = await call({ action: "check" }); } // رمز مرفوض ← كزائر
          else throw e;
        }
        cur = { id, data, at: Date.now(), via: "server" };
        save(id, { at: cur.at, data });
        if (id !== "anon") {                                                   // نحدّث مخزَّن الزائر أيضاً ليكون جاهزاً بعد الانتهاء
          const a = load("anon");
          if (!a || Date.now() - a.at > DAY) call({ action: "check" }).then((d) => save("anon", { at: Date.now(), data: d })).catch(() => {});
        }
      } catch (e) {
        const c = load(id);
        if (valid(c)) cur = { id, data: c.data, at: c.at, via: "cache" };
        else {
          const a = id !== "anon" ? load("anon") : null;
          cur = valid(a) ? { id: "anon", data: a.data, at: a.at, via: "cache" } : { id, data: null, via: "unknown" };
        }
      }
    }
    function refresh() {
      if (pending) return pending;
      last = Date.now();
      pending = run().finally(() => { pending = null; setTimeout(emit, 0); });
      return pending;
    }
    async function ensure() {                                                  // هل تغيّرت الهوية منذ آخر محاولة؟
      if (C.dev) return;
      if (pending) await pending;                                              // لا نفوّت تغيّر الهوية أثناء طلب جارٍ
      let ident = null;
      try { ident = await C.getIdentity(); } catch (e) { ident = null; }
      const id = ident && ident.uid ? "u:" + ident.uid : "anon";
      if (!cur || attempted !== id) return refresh();
    }

    const feat = (k) => (cur && cur.data && cur.data.features ? cur.data.features[k] : undefined);
    const api = {
      dev: !!C.dev,
      refresh, ensure,
      onChange(fn) { subs.push(fn); return () => { subs = subs.filter((x) => x !== fn); }; },
      can(k) { if (C.dev || !cur || !cur.data) return true; const f = feat(k); return f ? !!f.allowed : true; },
      limit(k) {                       // null = غير محدود ، 0 = غير مسموح
        if (C.dev || !cur || !cur.data) return null;
        const f = feat(k); if (!f) return null; if (!f.allowed) return 0;
        return f.limit == null ? null : f.limit;
      },
      feature: feat,
      info() {
        const d = cur && cur.data, s = d && d.subscription;
        return { status: C.dev ? "dev" : !cur ? "pending" : cur.via === "unknown" ? "unknown" : cur.via,
          subscribed: !!(d && d.subscribed), plan: s ? s.plan_name : null, endsAt: s ? s.ends_at : null, identity: cur ? cur.id : null };
      },
      async consume(k, n) {            // للحصص الدورية. يتطلب اتصالاً.
        if (C.dev) return { ok: true, dev: true };
        let ident = null;
        try { ident = await C.getIdentity(); } catch (e) { ident = null; }
        if (!ident || !ident.token) return { ok: false, error: "not_signed_in" };
        try { const r = await call({ action: "consume", token: ident.token, feature: k, n: n || 1 }); refresh(); return r; }
        catch (e) { return { ok: false, error: e.status ? e.message : "network" }; }
      },
      subscribeUrl(p) {
        if (!C.plansUrl) return "";
        const u = new URL(C.plansUrl);
        if (p && p.email) u.searchParams.set("email", String(p.email).slice(0, 254));
        if (p && p.name) u.searchParams.set("name", String(p.name).slice(0, 160));
        return u.href;
      }
    };

    // تحديث دوري وعند عودة الاتصال/الظهور
    g.addEventListener("online", () => refresh());
    g.document.addEventListener("visibilitychange", () => { if (!g.document.hidden && Date.now() - last > 5 * 60 * 1000) refresh(); });
    setInterval(() => { if (!g.document.hidden && Date.now() - last > C.refreshMs) refresh(); }, 60 * 1000);
    return api;
  }
  g.AccessSDK = { create };
})(window);
