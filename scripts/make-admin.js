#!/usr/bin/env node
'use strict';
// إنشاء المدير الأول بأمان — يعمل من جهازك فقط (لا يوجد أي مسار في التطبيق يمنح صلاحية مدير).
//
// الاستخدام:
//   1) نزّل مفتاح حساب خدمة (Service Account) من Firebase Console → Project settings → Service accounts
//      واحفظه خارج المشروع (لا ترفعه إلى git ولا تضعه في الواجهة).
//   2) export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
//   3) cd functions && npm install && cd ..
//   4) node scripts/make-admin.js you@example.com           # يمنح صلاحية المدير ويزرع الخطط الافتراضية
//      node scripts/make-admin.js you@example.com --revoke  # يسحب الصلاحية
// المستخدم لازم يكون سجّل دخوله مرة واحدة على الأقل بحساب Google هذا.
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
const { DEFAULT_SETTINGS, DEFAULT_PLANS } = require(path.join(__dirname, '..', 'functions', 'defaults'));

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');
if (!email || !email.includes('@')) { console.error('Usage: node scripts/make-admin.js <email> [--revoke]'); process.exit(1); }

(async () => {
  admin.initializeApp();
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (revoke) delete claims.admin; else claims.admin = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  await admin.auth().revokeRefreshTokens(user.uid); // يُجبر على تجديد التوكن
  const db = admin.firestore();
  await db.collection('auditLogs').add({ at: admin.firestore.FieldValue.serverTimestamp(), adminUid: 'script', adminEmail: 'local-script', action: revoke ? 'admin.revoke' : 'admin.grant', target: user.uid, details: { email } });
  console.log((revoke ? 'Admin revoked for ' : 'Admin granted to ') + email + ' (' + user.uid + ')');
  if (!revoke) {
    const sref = db.doc('adminSettings/global');
    if (!(await sref.get()).exists) { await sref.set({ ...DEFAULT_SETTINGS, updatedAt: admin.firestore.FieldValue.serverTimestamp() }); console.log('Seeded adminSettings/global'); }
    for (const p of DEFAULT_PLANS) {
      const r = db.doc('plans/' + p.id);
      if (!(await r.get()).exists) { await r.set({ ...p, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }); console.log('Seeded plan ' + p.id); }
    }
    console.log('Done. Sign out and sign in again on admin.html so the new token carries the admin claim.');
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
