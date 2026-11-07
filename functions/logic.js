'use strict';
// منطق نقي (بدون Firebase) كي يمكن اختباره محليًا.
const crypto = require('crypto');

// إضافة أشهر تقويمية مع مراعاة اختلاف أيام الأشهر (31 يناير + شهر = 28/29 فبراير)
function addMonths(d, m) {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + m);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

const MAX_PROOF_BYTES = 600 * 1024;

// يتحقق من الملف من محتواه الفعلي (magic bytes) لا من النوع الذي يدّعيه العميل
function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
function checkProof(b64) {
  if (typeof b64 !== 'string' || !b64.length) return { err: 'PROOF_REQUIRED' };
  if (b64.length > Math.ceil(MAX_PROOF_BYTES * 4 / 3) + 8) return { err: 'PROOF_TOO_BIG' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { err: 'PROOF_BAD_TYPE' };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_PROOF_BYTES) return { err: 'PROOF_TOO_BIG' };
  const type = sniff(buf);
  if (!type) return { err: 'PROOF_BAD_TYPE' };
  return { buf, type, sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

// الحالة الفعلية: "active" لا تعني فعالة إذا تجاوز expiresAt مدة السماح
function effectiveStatus(sub, now, graceDays) {
  if (!sub) return 'free';
  if (sub.status === 'active' && sub.expiresAt && sub.expiresAt.getTime() + (graceDays || 0) * 864e5 < now.getTime()) return 'expired';
  return sub.status;
}

const normRef = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const lockId = (kind, v) => kind + '_' + crypto.createHash('sha256').update(v).digest('hex').slice(0, 40);

module.exports = { addMonths, addDays, sniff, checkProof, effectiveStatus, normRef, lockId, MAX_PROOF_BYTES };
