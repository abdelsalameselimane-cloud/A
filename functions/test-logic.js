'use strict';
const assert = require('assert');
const L = require('./logic');
const D = (s) => new Date(s);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('addMonths: 31 Jan + 1 month = 28 Feb (non-leap)', () => assert.strictEqual(L.addMonths(D('2027-01-31T10:00:00Z'), 1).toISOString(), '2027-02-28T10:00:00.000Z'));
t('addMonths: 31 Jan + 1 month = 29 Feb (leap)', () => assert.strictEqual(L.addMonths(D('2028-01-31T10:00:00Z'), 1).toISOString(), '2028-02-29T10:00:00.000Z'));
t('addMonths: 30 Apr + 1 = 30 May', () => assert.strictEqual(L.addMonths(D('2026-04-30T00:00:00Z'), 1).toISOString(), '2026-05-30T00:00:00.000Z'));
t('addMonths: 15 Dec + 2 crosses the year', () => assert.strictEqual(L.addMonths(D('2026-12-15T00:00:00Z'), 2).toISOString(), '2027-02-15T00:00:00.000Z'));
t('addMonths: 31 Aug + 6 = 28 Feb', () => assert.strictEqual(L.addMonths(D('2026-08-31T00:00:00Z'), 6).toISOString(), '2027-02-28T00:00:00.000Z'));
t('addDays', () => assert.strictEqual(L.addDays(D('2026-02-27T00:00:00Z'), 2).toISOString(), '2026-03-01T00:00:00.000Z'));

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
t('proof: valid PNG accepted, type from content', () => { const r = L.checkProof(png.toString('base64')); assert.strictEqual(r.type, 'image/png'); assert.ok(r.sha); });
t('proof: PDF accepted', () => assert.strictEqual(L.checkProof(Buffer.from('%PDF-1.4 abc').toString('base64')).type, 'application/pdf'));
t('proof: HTML disguised as image rejected', () => assert.strictEqual(L.checkProof(Buffer.from('<html><script>alert(1)</script>').toString('base64')).err, 'PROOF_BAD_TYPE'));
t('proof: oversized rejected', () => assert.strictEqual(L.checkProof(Buffer.concat([png, Buffer.alloc(700 * 1024)]).toString('base64')).err, 'PROOF_TOO_BIG'));
t('proof: empty / non-string rejected', () => { assert.strictEqual(L.checkProof('').err, 'PROOF_REQUIRED'); assert.strictEqual(L.checkProof(123).err, 'PROOF_REQUIRED'); });
t('proof: garbage base64 rejected', () => assert.strictEqual(L.checkProof('!!!not base64!!!').err, 'PROOF_BAD_TYPE'));

const now = D('2026-11-07T00:00:00Z');
t('status: no sub = free', () => assert.strictEqual(L.effectiveStatus(null, now, 0), 'free'));
t('status: active before expiry', () => assert.strictEqual(L.effectiveStatus({ status: 'active', expiresAt: D('2026-12-01T00:00:00Z') }, now, 0), 'active'));
t('status: active past expiry = expired (grace 0)', () => assert.strictEqual(L.effectiveStatus({ status: 'active', expiresAt: D('2026-11-06T00:00:00Z') }, now, 0), 'expired'));
t('status: grace 3 days keeps it active', () => assert.strictEqual(L.effectiveStatus({ status: 'active', expiresAt: D('2026-11-05T00:00:00Z') }, now, 3), 'active'));
t('status: grace elapsed = expired', () => assert.strictEqual(L.effectiveStatus({ status: 'active', expiresAt: D('2026-11-01T00:00:00Z') }, now, 3), 'expired'));
t('status: suspended stays suspended', () => assert.strictEqual(L.effectiveStatus({ status: 'suspended', expiresAt: D('2026-12-01T00:00:00Z') }, now, 0), 'suspended'));

t('dedupe: reference normalisation', () => assert.strictEqual(L.lockId('ref', L.normRef(' AB 12 ')), L.lockId('ref', L.normRef('ab12'))));
t('dedupe: file vs ref locks differ', () => assert.notStrictEqual(L.lockId('ref', 'x'), L.lockId('file', 'x')));

const { _internals } = (() => { try { return require('./index.js'); } catch (e) { return {}; } })();
if (_internals) {
  t('plan: valid plan sanitised', () => {
    const p = _internals.sanitizePlan({ id: 'pro', name: { ar: 'برو' }, priceMonthly: '3000', durationMonths: 1, features: { cloudSync: true, evil: true } });
    assert.strictEqual(p.priceMonthly, 3000); assert.deepStrictEqual(p.features, { cloudSync: true, reports: false, xlsx: false });
  });
  t('plan: negative price rejected', () => assert.throws(() => _internals.sanitizePlan({ id: 'pro', name: { ar: 'x' }, priceMonthly: -1 })));
  t('plan: bad id rejected', () => assert.throws(() => _internals.sanitizePlan({ id: 'Bad Id!', name: { ar: 'x' }, priceMonthly: 1 })));
  t('settings: grace clamped & default 0', () => { assert.strictEqual(_internals.sanitizeSettings({}).gracePeriodDays, 0); assert.strictEqual(_internals.sanitizeSettings({ gracePeriodDays: 999 }).gracePeriodDays, 60); });
}
console.log('\n' + n + ' tests passed');
