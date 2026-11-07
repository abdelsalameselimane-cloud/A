'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const L = require('./logic');
const { FEATURES, DEFAULT_SETTINGS, DEFAULT_PLANS } = require('./defaults');

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;

const REGION = 'europe-west1'; // يجب أن تطابق REGION في index.html و admin.html
const opts = { region: REGION, maxInstances: 10 };

// ───────────── أدوات عامة ─────────────
const bad = (key, code = 'invalid-argument') => new HttpsError(code, key);
function authUid(req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  return req.auth.uid;
}
// تحقق حديث من صلاحية المدير من الخادم (لا يكفي ما في التوكن لأنه قد يبقى ساعة بعد سحب الصلاحية)
async function assertAdmin(req) {
  authUid(req);
  if (req.auth.token.admin !== true) throw new HttpsError('permission-denied', 'NOT_ADMIN');
  const u = await admin.auth().getUser(req.auth.uid);
  if (u.disabled || !(u.customClaims && u.customClaims.admin === true)) throw new HttpsError('permission-denied', 'NOT_ADMIN');
  return u;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
};
// يحوّل Timestamp إلى ميلي ثانية (للإرسال إلى العميل)
function plain(o) {
  if (o == null) return o;
  if (o instanceof TS) return o.toMillis();
  if (Array.isArray(o)) return o.map(plain);
  if (typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = plain(o[k]); return r; }
  return o;
}
const toJs = (d) => ({ ...d, expiresAt: d.expiresAt ? d.expiresAt.toDate() : null });

async function getSettings(tx) {
  const ref = db.doc('adminSettings/global');
  const s = tx ? await tx.get(ref) : await ref.get();
  const d = s.exists ? s.data() : {};
  return {
    ...DEFAULT_SETTINGS, ...d,
    freeFeatures: { ...DEFAULT_SETTINGS.freeFeatures, ...(d.freeFeatures || {}) },
    paymentInstructions: { ...DEFAULT_SETTINGS.paymentInstructions, ...(d.paymentInstructions || {}) },
  };
}
const notifyTx = (tx, uid, type, params) =>
  tx.set(db.collection('notifications').doc(uid).collection('items').doc(), { type, params: params || {}, read: false, createdAt: FV.serverTimestamp() });
const auditTx = (tx, adm, action, target, details) =>
  tx.set(db.collection('auditLogs').doc(), { at: FV.serverTimestamp(), adminUid: adm.uid, adminEmail: adm.email || '', action, target: target || '', details: details || {} });

function planSnapshot(p) {
  return {
    id: p.id, name: p.name, description: p.description, priceMonthly: p.priceMonthly,
    durationMonths: p.durationMonths, features: p.features || {}, limits: p.limits || {},
  };
}
async function loadPlan(planId, { mustBeActive } = {}) {
  if (typeof planId !== 'string' || !/^[a-z0-9_-]{2,30}$/.test(planId)) throw bad('PLAN_UNAVAILABLE');
  const s = await db.doc('plans/' + planId).get();
  if (!s.exists || (mustBeActive && s.data().active !== true)) throw bad('PLAN_UNAVAILABLE', 'failed-precondition');
  return { id: s.id, ...s.data() };
}
const syncOf = (features) => !!(features && features.cloudSync);

// ───────────── 1) المستخدم: فحص الصلاحية (يحوّل المنتهي إلى expired ويحفظه) ─────────────
exports.getAccess = onCall(opts, async (req) => {
  const uid = authUid(req);
  const ref = db.doc('subscriptions/' + uid);
  const out = await db.runTransaction(async (tx) => {
    const settings = await getSettings(tx);
    const s = await tx.get(ref);
    if (!s.exists) return { settings, sub: null };
    const d = s.data();
    if (L.effectiveStatus(toJs(d), new Date(), settings.gracePeriodDays) === 'expired' && d.status === 'active') {
      tx.update(ref, { status: 'expired', sync: false, updatedAt: FV.serverTimestamp() });
      notifyTx(tx, uid, 'expired', {});
      return { settings, sub: { ...d, status: 'expired', sync: false } };
    }
    return { settings, sub: d };
  });
  return { sub: plain(out.sub), settings: plain(out.settings), serverNow: Date.now() };
});

// ───────────── 2) المستخدم: إرسال طلب دفع يدوي ─────────────
exports.submitPayment = onCall({ ...opts, memory: '512MiB' }, async (req) => {
  const uid = authUid(req);
  const email = (req.auth.token.email || '').slice(0, 200);
  const d = req.data || {};
  const requestId = d.requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(requestId)) throw bad('BAD_REQUEST');
  const reference = str(d.reference, 64);
  const chk = L.checkProof(d.proof && d.proof.b64);
  if (chk.err) throw bad(chk.err);
  const fileName = str(d.proof && d.proof.name, 80).replace(/[^\w.\- ؀-ۿ]/g, '_') || 'proof';

  const plan = await loadPlan(d.planId, { mustBeActive: true });
  const months = int(plan.durationMonths, 1, 60, 1);
  const amount = Math.round(Number(plan.priceMonthly) * months);

  const reqRef = db.doc('paymentRequests/' + requestId);
  const subRef = db.doc('subscriptions/' + uid);
  const locks = [db.doc('paymentLocks/' + L.lockId('file', chk.sha))];
  if (reference) locks.push(db.doc('paymentLocks/' + L.lockId('ref', L.normRef(reference))));

  const result = await db.runTransaction(async (tx) => {
    const ex = await tx.get(reqRef);
    if (ex.exists) {
      if (ex.data().uid !== uid) throw new HttpsError('permission-denied', 'BAD_REQUEST');
      return { id: requestId, idempotent: true }; // إعادة إرسال نفس الطلب: لا شيء يتكرر
    }
    const pend = await tx.get(db.collection('paymentRequests').where('uid', '==', uid).where('status', '==', 'pending').limit(1));
    if (!pend.empty) throw new HttpsError('failed-precondition', 'ALREADY_PENDING');
    const lockSnaps = await Promise.all(locks.map((l) => tx.get(l)));
    if (lockSnaps.some((s) => s.exists)) throw new HttpsError('already-exists', 'DUPLICATE_PAYMENT');
    const sub = await tx.get(subRef);

    const now = TS.now();
    tx.create(reqRef, {
      uid, email, planId: plan.id, plan: planSnapshot(plan), months, amount, currency: (await getSettings(tx)).currency,
      reference, proofName: fileName, proofType: chk.type, proofSize: chk.buf.length,
      status: 'pending', createdAt: now, lockIds: locks.map((l) => l.id),
    });
    tx.create(db.doc('paymentProofs/' + requestId), { uid, name: fileName, type: chk.type, size: chk.buf.length, sha: chk.sha, data: d.proof.b64, createdAt: now });
    locks.forEach((l) => tx.create(l, { uid, requestId, createdAt: now }));

    const sd = sub.exists ? sub.data() : null;
    if (!sd) {
      tx.set(subRef, { uid, email, status: 'pending', statusBeforePending: 'free', sync: false, totalPaid: 0, updatedAt: FV.serverTimestamp() });
    } else if (sd.status === 'expired' || sd.status === 'cancelled' || sd.status === 'free') {
      tx.update(subRef, { status: 'pending', statusBeforePending: sd.status, sync: false, updatedAt: FV.serverTimestamp() });
    } // active/suspended/pending: لا تتغير حالتها

    notifyTx(tx, uid, 'request_submitted', { plan: plan.name });
    return { id: requestId, idempotent: false };
  });
  return result;
});

// ───────────── 3) المدير: قبول/رفض طلب دفع ─────────────
exports.reviewPayment = onCall(opts, async (req) => {
  const adm = await assertAdmin(req);
  const { requestId, action } = req.data || {};
  const reason = str((req.data || {}).reason, 300);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(requestId)) throw bad('BAD_REQUEST');
  if (action !== 'approve' && action !== 'reject') throw bad('BAD_REQUEST');
  if (action === 'reject' && reason.length < 2) throw bad('REASON_REQUIRED');

  const reqRef = db.doc('paymentRequests/' + requestId);
  return db.runTransaction(async (tx) => {
    const rs = await tx.get(reqRef);
    if (!rs.exists) throw new HttpsError('not-found', 'NOT_FOUND');
    const r = rs.data();
    if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'ALREADY_REVIEWED'); // يمنع التفعيل المزدوج
    const subRef = db.doc('subscriptions/' + r.uid);
    const sub = await tx.get(subRef);
    const sd = sub.exists ? sub.data() : null;
    const now = new Date();

    if (action === 'reject') {
      tx.update(reqRef, { status: 'rejected', reason, reviewedBy: adm.uid, reviewedAt: TS.fromDate(now) });
      (r.lockIds || []).forEach((id) => tx.delete(db.doc('paymentLocks/' + id))); // يسمح بإعادة المحاولة بإثبات صحيح
      if (sd && sd.status === 'pending') {
        tx.update(subRef, { status: sd.statusBeforePending || 'free', statusBeforePending: FV.delete(), updatedAt: FV.serverTimestamp() });
      }
      notifyTx(tx, r.uid, 'payment_rejected', { reason });
      auditTx(tx, adm, 'payment.reject', r.uid, { requestId, reason, amount: r.amount });
      return { ok: true, status: 'rejected' };
    }

    if (sd && sd.status === 'suspended') throw new HttpsError('failed-precondition', 'SUSPENDED_UNSUSPEND_FIRST');
    const curExp = sd && sd.status === 'active' && sd.expiresAt && sd.expiresAt.toDate() > now ? sd.expiresAt.toDate() : null;
    const expires = L.addMonths(curExp || now, r.months);
    const features = r.plan.features || {};
    const renewal = !!curExp;
    tx.set(subRef, {
      uid: r.uid, email: r.email, status: 'active', planId: r.planId, planName: r.plan.name, features, limits: r.plan.limits || {}, sync: syncOf(features),
      startAt: renewal && sd.startAt ? sd.startAt : TS.fromDate(now), expiresAt: TS.fromDate(expires),
      lastAmount: r.amount, totalPaid: FV.increment(r.amount), lastPaymentAt: TS.fromDate(now), lastRequestId: requestId,
      statusBeforePending: FV.delete(), updatedAt: FV.serverTimestamp(),
    }, { merge: true });
    tx.update(reqRef, { status: 'approved', reviewedBy: adm.uid, reviewedAt: TS.fromDate(now), expiresAt: TS.fromDate(expires) });
    tx.create(db.doc('paymentHistory/' + requestId), { // المعرّف = معرّف الطلب → لا يُسجَّل الدفع مرتين
      uid: r.uid, email: r.email, type: renewal ? 'renewal' : 'payment', planId: r.planId, planName: r.plan.name, months: r.months,
      amount: r.amount, currency: r.currency || 'DZD', revenue: r.amount > 0, reference: r.reference || '', requestId,
      at: TS.fromDate(now), expiresAt: TS.fromDate(expires), by: adm.uid,
    });
    notifyTx(tx, r.uid, 'payment_approved', { plan: r.plan.name });
    notifyTx(tx, r.uid, renewal ? 'renewed' : 'sub_activated', { plan: r.plan.name, until: expires.getTime() });
    auditTx(tx, adm, 'payment.approve', r.uid, { requestId, amount: r.amount, plan: r.planId, expiresAt: expires.toISOString() });
    return { ok: true, status: 'approved', expiresAt: expires.getTime() };
  });
});

// ───────────── 4) المدير: إجراءات على الاشتراك ─────────────
const ACTIONS = ['activate', 'extend', 'suspend', 'unsuspend', 'cancel', 'changePlan'];
exports.adminSubscriptionAction = onCall(opts, async (req) => {
  const adm = await assertAdmin(req);
  const d = req.data || {};
  const uid = str(d.uid, 128);
  const action = d.action;
  const reason = str(d.reason, 300);
  if (!uid || !ACTIONS.includes(action)) throw bad('BAD_REQUEST');
  let target;
  try { target = await admin.auth().getUser(uid); } catch (e) { throw new HttpsError('not-found', 'USER_NOT_FOUND'); }
  const plan = action === 'activate' || action === 'changePlan' ? await loadPlan(d.planId) : null;

  return db.runTransaction(async (tx) => {
    const ref = db.doc('subscriptions/' + uid);
    const s = await tx.get(ref);
    const sd = s.exists ? s.data() : null;
    const now = new Date();
    const exp = sd && sd.expiresAt ? sd.expiresAt.toDate() : null;
    const base = { uid, email: target.email || '', updatedAt: FV.serverTimestamp() };
    const hist = (extra) => tx.set(db.collection('paymentHistory').doc(), { uid, email: target.email || '', at: TS.fromDate(now), by: adm.uid, note: reason, currency: 'DZD', ...extra });

    if (action === 'activate') {
      const months = int(d.months, 1, 60, int(plan.durationMonths, 1, 60, 1));
      const amount = Math.max(0, Math.round(Number(d.amount) || 0)); // 0 = تفعيل مجاني/تعويضي لا يُحسب إيرادًا
      const expires = L.addMonths(now, months);
      tx.set(ref, { ...base, status: 'active', planId: plan.id, planName: plan.name, features: plan.features || {}, limits: plan.limits || {}, sync: syncOf(plan.features),
        startAt: TS.fromDate(now), expiresAt: TS.fromDate(expires), statusBeforePending: FV.delete(), suspendedReason: FV.delete(),
        ...(amount > 0 ? { lastAmount: amount, totalPaid: FV.increment(amount), lastPaymentAt: TS.fromDate(now) } : (sd ? {} : { totalPaid: 0 })) }, { merge: true });
      hist({ type: 'manual', planId: plan.id, planName: plan.name, months, amount, revenue: amount > 0, expiresAt: TS.fromDate(expires) });
      notifyTx(tx, uid, 'sub_activated', { plan: plan.name, until: expires.getTime() });
    } else if (action === 'extend') {
      if (!sd || !exp) throw new HttpsError('failed-precondition', 'NO_SUB');
      if (sd.status === 'cancelled') throw new HttpsError('failed-precondition', 'CANCELLED_USE_ACTIVATE');
      const days = int(d.days, 0, 3650, 0), months = int(d.months, 0, 60, 0);
      if (!days && !months) throw bad('BAD_REQUEST');
      const from = exp > now ? exp : now;
      const expires = L.addDays(L.addMonths(from, months), days);
      const patch = { ...base, expiresAt: TS.fromDate(expires) };
      if (sd.status === 'expired') { patch.status = 'active'; patch.sync = syncOf(sd.features); }
      tx.set(ref, patch, { merge: true });
      hist({ type: 'extension', planId: sd.planId || '', planName: sd.planName || '', months, days, amount: 0, revenue: false, expiresAt: TS.fromDate(expires) });
      notifyTx(tx, uid, 'extended', { until: expires.getTime() });
    } else if (action === 'suspend') {
      if (!sd || !['active', 'pending', 'expired'].includes(sd.status)) throw new HttpsError('failed-precondition', 'BAD_STATE');
      tx.set(ref, { ...base, status: 'suspended', sync: false, suspendedReason: reason }, { merge: true });
      notifyTx(tx, uid, 'suspended', { reason });
    } else if (action === 'unsuspend') {
      if (!sd || sd.status !== 'suspended') throw new HttpsError('failed-precondition', 'BAD_STATE');
      const live = exp && exp > now;
      tx.set(ref, { ...base, status: live ? 'active' : 'expired', sync: live ? syncOf(sd.features) : false, suspendedReason: FV.delete() }, { merge: true });
      notifyTx(tx, uid, live ? 'unsuspended' : 'expired', {});
    } else if (action === 'cancel') {
      if (!sd || sd.status === 'cancelled') throw new HttpsError('failed-precondition', 'BAD_STATE');
      tx.set(ref, { ...base, status: 'cancelled', sync: false }, { merge: true });
      notifyTx(tx, uid, 'cancelled', { reason });
    } else if (action === 'changePlan') {
      if (!sd || sd.status !== 'active') throw new HttpsError('failed-precondition', 'NOT_ACTIVE');
      tx.set(ref, { ...base, planId: plan.id, planName: plan.name, features: plan.features || {}, limits: plan.limits || {}, sync: syncOf(plan.features) }, { merge: true });
      notifyTx(tx, uid, 'plan_changed', { plan: plan.name });
    }
    auditTx(tx, adm, 'subscription.' + action, uid, { reason, planId: d.planId || null, months: d.months || null, days: d.days || null, amount: d.amount || null });
    return { ok: true };
  });
});

// ───────────── 5) المدير: المستخدمون والإحصائيات ─────────────
async function listAllUsers(cap = 5000) {
  const out = [];
  let token;
  do {
    const r = await admin.auth().listUsers(1000, token);
    out.push(...r.users);
    token = r.pageToken;
  } while (token && out.length < cap);
  return out;
}
exports.adminListUsers = onCall({ ...opts, memory: '512MiB' }, async (req) => {
  await assertAdmin(req);
  const [users, subs, settings] = await Promise.all([listAllUsers(), db.collection('subscriptions').get(), getSettings()]);
  const m = {};
  subs.forEach((s) => { m[s.id] = s.data(); });
  const now = new Date();
  return {
    users: users.map((u) => {
      const sd = m[u.uid] || null;
      return {
        uid: u.uid, email: u.email || '', name: u.displayName || '', disabled: u.disabled,
        created: Date.parse(u.metadata.creationTime) || 0, lastSignIn: Date.parse(u.metadata.lastSignInTime) || 0,
        isAdmin: !!(u.customClaims && u.customClaims.admin),
        status: L.effectiveStatus(sd ? toJs(sd) : null, now, settings.gracePeriodDays),
        sub: plain(sd),
      };
    }),
  };
});

exports.adminStats = onCall({ ...opts, memory: '512MiB' }, async (req) => {
  await assertAdmin(req);
  const d = req.data || {};
  const from = Number(d.from) || 0, to = Number(d.to) || Date.now() + 864e5;
  const [users, subs, pend, hist, settings] = await Promise.all([
    listAllUsers(), db.collection('subscriptions').get(),
    db.collection('paymentRequests').where('status', '==', 'pending').get(),
    db.collection('paymentHistory').get(), getSettings(),
  ]);
  const now = new Date();
  const c = { free: 0, pending: 0, active: 0, expired: 0, cancelled: 0, suspended: 0 };
  const withSub = new Set();
  subs.forEach((s) => { withSub.add(s.id); const e = L.effectiveStatus(toJs(s.data()), now, settings.gracePeriodDays); c[e] = (c[e] || 0) + 1; });
  c.free += users.filter((u) => !withSub.has(u.uid)).length;
  let pendingAmount = 0;
  pend.forEach((p) => { pendingAmount += Number(p.data().amount) || 0; });
  let confirmedTotal = 0, periodTotal = 0;
  const byMonth = {};
  hist.forEach((h) => {
    const x = h.data();
    if (x.revenue !== true || !(x.amount > 0)) return; // الإيراد = مدفوعات مؤكدة فقط
    confirmedTotal += x.amount;
    const ms = x.at.toMillis();
    if (ms >= from && ms <= to) {
      periodTotal += x.amount;
      const k = new Date(ms).toISOString().slice(0, 7);
      byMonth[k] = (byMonth[k] || 0) + x.amount;
    }
  });
  return {
    users: users.length, active: c.active, expired: c.expired, suspended: c.suspended, cancelled: c.cancelled,
    pendingCount: pend.size, pendingAmount, confirmedTotal, periodTotal,
    byMonth: Object.keys(byMonth).sort().map((k) => ({ month: k, total: byMonth[k] })),
    currency: settings.currency,
  };
});

// ───────────── 6) المدير: الخطط والإعدادات ─────────────
function sanitizePlan(p, isNew) {
  if (!p || typeof p !== 'object') throw bad('BAD_REQUEST');
  const id = str(p.id, 30);
  if (!/^[a-z0-9_-]{2,30}$/.test(id)) throw bad('BAD_PLAN_ID');
  const loc = (o, max) => { const r = {}; ['ar', 'fr', 'en'].forEach((k) => { r[k] = str(o && o[k], max); }); return r; };
  const name = loc(p.name, 60);
  if (!name.ar && !name.fr && !name.en) throw bad('PLAN_NAME_REQUIRED');
  const price = Number(p.priceMonthly);
  if (!Number.isFinite(price) || price < 0 || price > 10000000) throw bad('BAD_PRICE');
  const features = {};
  FEATURES.forEach((f) => { features[f] = !!(p.features && p.features[f]); });
  return {
    id, name, description: loc(p.description, 300), priceMonthly: Math.round(price),
    durationMonths: int(p.durationMonths, 1, 36, 1), features,
    limits: { maxDocuments: int(p.limits && p.limits.maxDocuments, 0, 100000, 0) },
    active: p.active !== false, sortOrder: int(p.sortOrder, 0, 1000, 100),
  };
}
exports.adminSavePlan = onCall(opts, async (req) => {
  const adm = await assertAdmin(req);
  const plan = sanitizePlan((req.data || {}).plan);
  const ref = db.doc('plans/' + plan.id);
  await db.runTransaction(async (tx) => {
    const ex = await tx.get(ref);
    tx.set(ref, { ...plan, updatedAt: FV.serverTimestamp(), ...(ex.exists ? {} : { createdAt: FV.serverTimestamp() }) });
    auditTx(tx, adm, ex.exists ? 'plan.update' : 'plan.create', plan.id, { price: plan.priceMonthly, active: plan.active });
  });
  return { ok: true };
});

function sanitizeSettings(s) {
  if (!s || typeof s !== 'object') throw bad('BAD_REQUEST');
  const loc = {};
  ['ar', 'fr', 'en'].forEach((k) => { loc[k] = str(s.paymentInstructions && s.paymentInstructions[k], 2000); });
  return {
    currency: str(s.currency, 5).toUpperCase() || 'DZD',
    gracePeriodDays: int(s.gracePeriodDays, 0, 60, 0),
    expiryNoticeDays: int(s.expiryNoticeDays, 1, 60, 7),
    enforceCloudSync: s.enforceCloudSync !== false,
    freeFeatures: { reports: !!(s.freeFeatures && s.freeFeatures.reports), xlsx: !!(s.freeFeatures && s.freeFeatures.xlsx) },
    paymentInstructions: loc,
  };
}
exports.adminSaveSettings = onCall(opts, async (req) => {
  const adm = await assertAdmin(req);
  const s = sanitizeSettings((req.data || {}).settings);
  await db.runTransaction(async (tx) => {
    tx.set(db.doc('adminSettings/global'), { ...s, updatedAt: FV.serverTimestamp() });
    auditTx(tx, adm, 'settings.update', 'global', { grace: s.gracePeriodDays, notice: s.expiryNoticeDays, enforceCloudSync: s.enforceCloudSync });
  });
  return { ok: true };
});

// يزرع الخطط والإعدادات الافتراضية إن لم توجد (لا يستبدل شيئًا موجودًا)
exports.adminSeed = onCall(opts, async (req) => {
  const adm = await assertAdmin(req);
  let created = 0;
  await db.runTransaction(async (tx) => {
    const sref = db.doc('adminSettings/global');
    const s = await tx.get(sref);
    const refs = DEFAULT_PLANS.map((p) => db.doc('plans/' + p.id));
    const ps = await Promise.all(refs.map((r) => tx.get(r)));
    if (!s.exists) { tx.set(sref, { ...DEFAULT_SETTINGS, updatedAt: FV.serverTimestamp() }); created++; }
    DEFAULT_PLANS.forEach((p, i) => { if (!ps[i].exists) { tx.set(refs[i], { ...p, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }); created++; } });
    auditTx(tx, adm, 'seed', '', { created });
  });
  return { ok: true, created };
});

// ───────────── 7) مهمة يومية: انتهاء الاشتراكات وإشعارات الاقتراب ─────────────
// (الإنفاذ الفعلي لا يعتمد عليها: القواعد وgetAccess يحسبان الانتهاء من expiresAt مباشرة)
exports.dailyMaintenance = onSchedule({ schedule: 'every day 03:00', timeZone: 'Africa/Algiers', region: REGION }, async () => {
  const st = await getSettings();
  const now = Date.now();
  const graceMs = st.gracePeriodDays * 864e5;
  const expired = await db.collection('subscriptions').where('status', '==', 'active').where('expiresAt', '<', TS.fromMillis(now - graceMs)).get();
  for (const doc of expired.docs) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (!s.exists || s.data().status !== 'active') return;
      tx.update(doc.ref, { status: 'expired', sync: false, updatedAt: FV.serverTimestamp() });
      notifyTx(tx, doc.id, 'expired', {});
    });
  }
  const soon = await db.collection('subscriptions').where('status', '==', 'active')
    .where('expiresAt', '>=', TS.fromMillis(now)).where('expiresAt', '<=', TS.fromMillis(now + st.expiryNoticeDays * 864e5)).get();
  for (const doc of soon.docs) {
    const d = doc.data();
    const key = d.expiresAt.toMillis();
    if (d.expiryNoticeFor === key) continue; // أُرسل الإشعار لهذه المدة من قبل
    await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (!s.exists || s.data().expiryNoticeFor === key || s.data().status !== 'active') return;
      tx.update(doc.ref, { expiryNoticeFor: key });
      notifyTx(tx, doc.id, 'expiring', { days: Math.max(0, Math.ceil((key - now) / 864e5)), until: key });
    });
  }
});

exports._internals = { sanitizePlan, sanitizeSettings };
