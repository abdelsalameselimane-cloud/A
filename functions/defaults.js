'use strict';
// القيم الافتراضية الأولية فقط. تُنسخ إلى Firestore مرة واحدة (adminSeed أو scripts/make-admin.js)
// وبعدها تُعدَّل من لوحة الإدارة. لا شيء من هذه القيم مُثبَّت في منطق التطبيق.
const FEATURES = ['cloudSync', 'reports', 'xlsx'];

const DEFAULT_SETTINGS = {
  currency: 'DZD',
  gracePeriodDays: 0,        // صفر افتراضيًا: لا صلاحية مجانية بعد الانتهاء
  expiryNoticeDays: 7,       // كم يومًا قبل الانتهاء يُرسل إشعار "اقتراب الانتهاء"
  enforceCloudSync: true,    // المزامنة السحابية تتطلب اشتراكًا فعالًا (تُفرض في قواعد Firestore)
  freeFeatures: { reports: false, xlsx: true }, // مزايا واجهة متاحة للجميع (مزايا العميل فقط)
  // يجب على المدير كتابة تعليمات الدفع الحقيقية (رقم الحساب، ...) من لوحة الإدارة. لا قيم وهمية هنا.
  paymentInstructions: { ar: '', fr: '', en: '' },
};

const DEFAULT_PLANS = [
  {
    id: 'basic', priceMonthly: 1500, durationMonths: 1, sortOrder: 1, active: true,
    name: { ar: 'Basic', fr: 'Basic', en: 'Basic' },
    description: { ar: 'للاستخدام الفردي', fr: 'Pour un usage individuel', en: 'For individual use' },
    features: { cloudSync: true, reports: false, xlsx: true },
    limits: { maxDocuments: 50 },
  },
  {
    id: 'pro', priceMonthly: 3000, durationMonths: 1, sortOrder: 2, active: true,
    name: { ar: 'Pro', fr: 'Pro', en: 'Pro' },
    description: { ar: 'مع التقارير والإحصاءات المتقدمة', fr: 'Avec rapports et statistiques avancés', en: 'With advanced reports and statistics' },
    features: { cloudSync: true, reports: true, xlsx: true },
    limits: { maxDocuments: 300 },
  },
  {
    id: 'office', priceMonthly: 5000, durationMonths: 1, sortOrder: 3, active: true,
    name: { ar: 'Office', fr: 'Office', en: 'Office' },
    description: { ar: 'للمكاتب: بلا حد للمستندات', fr: 'Pour les bureaux : documents illimités', en: 'For offices: unlimited documents' },
    features: { cloudSync: true, reports: true, xlsx: true },
    limits: { maxDocuments: 0 }, // 0 = بلا حد
  },
];

module.exports = { FEATURES, DEFAULT_SETTINGS, DEFAULT_PLANS };
