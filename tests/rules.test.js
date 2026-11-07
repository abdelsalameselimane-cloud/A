// اختبارات قواعد Firestore (تحتاج Firebase Emulator). لم تُشغَّل في بيئة التطوير هذه لعدم توفر الشبكة/Java.
// التشغيل:  cd tests && npm i @firebase/rules-unit-testing firebase && firebase emulators:exec --only firestore "node --test rules.test.js"
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, getDocs, collection, Timestamp } = require('firebase/firestore');
const fs = require('fs');
const test = require('node:test');

let env;
const future = () => Timestamp.fromMillis(Date.now() + 10 * 864e5);
const past = () => Timestamp.fromMillis(Date.now() - 864e5);
test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-req', firestore: { rules: fs.readFileSync('../firestore.rules', 'utf8') } });
});
test.after(() => env.cleanup());
test.beforeEach(() => env.clearFirestore());
const seed = (fn) => env.withSecurityRulesDisabled((c) => fn(c.firestore()));
const asUser = (uid, admin = false) => env.authenticatedContext(uid, admin ? { admin: true } : {}).firestore();

test('7. user cannot create/modify own subscription', async () => {
  const db = asUser('u1');
  await assertFails(setDoc(doc(db, 'subscriptions/u1'), { status: 'active', expiresAt: future(), sync: true }));
  await seed((s) => setDoc(doc(s, 'subscriptions/u1'), { status: 'expired', expiresAt: past() }));
  await assertFails(updateDoc(doc(db, 'subscriptions/u1'), { status: 'active' }));
  await assertFails(updateDoc(doc(db, 'subscriptions/u1'), { expiresAt: future() }));
});
test('7b. user cannot edit plan price, payment status, or history', async () => {
  await seed(async (s) => { await setDoc(doc(s, 'plans/pro'), { active: true, priceMonthly: 3000 }); await setDoc(doc(s, 'paymentRequests/r1'), { uid: 'u1', status: 'pending' }); });
  const db = asUser('u1');
  await assertFails(updateDoc(doc(db, 'plans/pro'), { priceMonthly: 1 }));
  await assertFails(updateDoc(doc(db, 'paymentRequests/r1'), { status: 'approved' }));
  await assertFails(setDoc(doc(db, 'paymentHistory/x'), { uid: 'u1', amount: 99999 }));
});
test('8. user cannot read another user data', async () => {
  await seed(async (s) => { await setDoc(doc(s, 'subscriptions/u2'), { status: 'active' }); await setDoc(doc(s, 'paymentRequests/r2'), { uid: 'u2' }); await setDoc(doc(s, 'users/u2'), { ts: 1, n: 1 }); });
  const db = asUser('u1');
  await assertFails(getDoc(doc(db, 'subscriptions/u2')));
  await assertFails(getDoc(doc(db, 'paymentRequests/r2')));
  await assertFails(getDoc(doc(db, 'users/u2')));
  await assertSucceeds(getDoc(doc(asUser('u2'), 'subscriptions/u2')));
});
test('self-grant admin / proofs / audit / locks are closed to normal users', async () => {
  const db = asUser('u1');
  await assertFails(setDoc(doc(db, 'adminUsers/u1'), { admin: true }));
  await assertFails(getDoc(doc(db, 'paymentProofs/r1')));
  await assertFails(getDocs(collection(db, 'auditLogs')));
  await assertFails(getDoc(doc(db, 'paymentLocks/x')));
});
test('13. admin claim opens proofs and audit (reads only)', async () => {
  const a = asUser('adm', true);
  await assertSucceeds(getDoc(doc(a, 'paymentProofs/r1')));
  await assertSucceeds(getDocs(collection(a, 'auditLogs')));
  await assertFails(setDoc(doc(a, 'plans/pro'), { priceMonthly: 1 })); // even admins write through functions only
});
test('cloud sync: free/expired cannot write, active can, everyone can still read own data', async () => {
  await seed(async (s) => { await setDoc(doc(s, 'adminSettings/global'), { enforceCloudSync: true, gracePeriodDays: 0 }); await setDoc(doc(s, 'users/u1'), { ts: 1, n: 1 }); });
  const db = asUser('u1');
  await assertFails(setDoc(doc(db, 'users/u1'), { ts: 2, n: 1 }));            // free
  await seed((s) => setDoc(doc(s, 'subscriptions/u1'), { status: 'active', sync: true, expiresAt: past() }));
  await assertFails(setDoc(doc(db, 'users/u1/chunks/0'), { d: 'x' }));         // expired by time even if status still "active"
  await assertSucceeds(getDoc(doc(db, 'users/u1')));                           // data is never hidden
  await seed((s) => setDoc(doc(s, 'subscriptions/u1'), { status: 'active', sync: true, expiresAt: future() }));
  await assertSucceeds(setDoc(doc(db, 'users/u1'), { ts: 3, n: 1 }));
  await seed((s) => setDoc(doc(s, 'subscriptions/u1'), { status: 'suspended', sync: false, expiresAt: future() }));
  await assertFails(setDoc(doc(db, 'users/u1'), { ts: 4, n: 1 }));            // suspended
});
test('grace period extends sync access', async () => {
  await seed(async (s) => { await setDoc(doc(s, 'adminSettings/global'), { enforceCloudSync: true, gracePeriodDays: 3 }); await setDoc(doc(s, 'subscriptions/u1'), { status: 'active', sync: true, expiresAt: Timestamp.fromMillis(Date.now() - 864e5) }); });
  await assertSucceeds(setDoc(doc(asUser('u1'), 'users/u1'), { ts: 5, n: 1 }));
});
test('notifications: owner may only flip "read"', async () => {
  await seed((s) => setDoc(doc(s, 'notifications/u1/items/n1'), { type: 'expired', read: false, params: {} }));
  const db = asUser('u1');
  await assertSucceeds(updateDoc(doc(db, 'notifications/u1/items/n1'), { read: true }));
  await assertFails(updateDoc(doc(db, 'notifications/u1/items/n1'), { type: 'x' }));
  await assertFails(setDoc(doc(db, 'notifications/u1/items/n2'), { type: 'fake', read: false }));
  await assertFails(getDoc(doc(asUser('u2'), 'notifications/u1/items/n1')));
});
