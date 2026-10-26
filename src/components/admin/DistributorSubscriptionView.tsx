import React, { useState, useEffect } from 'react';
import { Language, formatCurrency } from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import { User } from '../../types/index.ts';
import {
  CreditCard,
  CheckCircle2,
  Clock,
  AlertTriangle,
  QrCode,
  ShieldCheck,
  Smartphone,
  ExternalLink,
  Copy,
  Check,
  Download,
  Printer,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Zap,
  Receipt,
} from 'lucide-react';

const FALLBACK_PLANS = [
  {
    id: 'starter',
    name: 'Starter Plan',
    name_hi: 'स्टार्टर प्लान',
    monthly_fee: 999,
    yearly_fee: 9990,
    max_shops: 25,
    description: 'छोटे वितरकों व लोकल रूट के लिए उपयुक्त',
    description_en: 'Ideal for small distributors managing local morning routes',
    features_hi: [
      '25 दुकानों तक का नेटवर्क',
      'दैनिक मांग एकत्रीकरण',
      '1-क्लिक व्हाट्सएप ऑर्डर पर्ची',
      'बेसिक खाता व लेजर बिलिंग'
    ],
    features_en: [
      'Up to 25 Retailer Shops',
      'Daily Ordering & Consolidation',
      '1-Click WhatsApp Order Slips',
      'Basic Ledger & Billing'
    ],
    popular: false,
  },
  {
    id: 'growth',
    name: 'Growth Pro',
    name_hi: 'ग्रोथ प्रो प्लान',
    monthly_fee: 1999,
    yearly_fee: 19990,
    max_shops: 100,
    description: 'मध्यम वितरकों के लिए सबसे लोकप्रिय व अनुशंसित',
    description_en: 'Best for growing wholesale agencies with multiple vehicles & delivery routes',
    features_hi: [
      '100 दुकानों तक का नेटवर्क',
      'मल्टीपल डिलीवरी रूट',
      'UPI QR कोड से तुरंत बकाया वसूली',
      'व्हाट्सएप ऑटोमैटिक रिमाइंडर',
      'थर्मल प्रिंटर चालान व विस्तृत लेजर'
    ],
    features_en: [
      'Up to 100 Retailer Shops',
      'Multiple Delivery Routes',
      'Instant UPI QR Code Payment Collection',
      'Automated WhatsApp Reminders',
      'Full Outstanding Ledger & Thermal Slip Printing'
    ],
    popular: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise Hub',
    name_hi: 'एंटरप्राइज हब',
    monthly_fee: 3999,
    yearly_fee: 39990,
    max_shops: 500,
    description: 'बड़े थोक वितरक, वेयरहाउस व बड़े नेटवर्क हेतु',
    description_en: 'For large wholesale distribution hubs, warehouses & multi-zone operations',
    features_hi: [
      'असीमित दुकानें (500+ तक)',
      'कस्टम डिलीवरी व्हीकल रूट्स व ड्राइवर पर्चियां',
      'समर्पित अकाउंट मैनेजर व 24x7 फोन सपोर्ट',
      'एडवांस्ड सेल्स एनालिटिक्स व CSV रिपोर्ट्स'
    ],
    features_en: [
      'Unlimited Retailer Shops (up to 500+)',
      'Custom Vehicle Delivery Routes & Driver Slips',
      'Dedicated Account Manager & 24x7 Phone Support',
      'Advanced Sales Analytics & CSV Exports'
    ],
    popular: false,
  },
];

interface DistributorSubscriptionViewProps {
  lang: Language;
  user?: User;
}

export const DistributorSubscriptionView: React.FC<DistributorSubscriptionViewProps> = ({ lang, user }) => {
  const isHi = lang === 'hi';
  const [loading, setLoading] = useState(true);
  const [subData, setSubData] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Renewal Modal states
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [slipPayment, setSlipPayment] = useState<any | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [tenureMonths, setTenureMonths] = useState<number>(1);
  const [utrNumber, setUtrNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedUpi, setCopiedUpi] = useState(false);

  const fetchSubscription = async () => {
    setLoading(true);
    try {
      const [data, cloudPlans] = await Promise.all([
        api.getMySubscription(user?.distributor_id).catch(() => null),
        api.getSubscriptionPlans().catch(() => []),
      ]);
      setSubData(data);
      const availablePlans = (cloudPlans && cloudPlans.length > 0)
        ? cloudPlans
        : ((data?.plans && data.plans.length > 0) ? data.plans : FALLBACK_PLANS);
      const targetPlanName = data?.distributor?.plan_name || 'Growth Pro';
      const current = availablePlans.find((p: any) =>
        p.name?.toLowerCase() === targetPlanName.toLowerCase() ||
        p.id?.toLowerCase() === targetPlanName.toLowerCase() ||
        targetPlanName.toLowerCase().includes(p.name?.toLowerCase())
      ) || availablePlans[1] || availablePlans[0];
      setSelectedPlan(current);
    } catch (err: any) {
      console.warn('Subscription fetch fallback:', err);
      setSubData((prev: any) => ({
        distributor: prev?.distributor || (user ? {
          id: user.distributor_id || user.id,
          business_name: user.business_name || user.name || 'VedirtSetu Distributor',
          owner_name: user.name,
          mobile: user.mobile,
          plan_name: user.plan_name || 'Growth Pro',
          monthly_fee: 1999,
          subscription_status: user.subscription_status || 'active',
          subscription_renewal_date: prev?.distributor?.subscription_renewal_date || '',
          max_shops: user.max_shops || 100
        } : null),
        plans: (prev?.plans && prev.plans.length > 0) ? prev.plans : FALLBACK_PLANS,
        payments: prev?.payments || [],
        days_remaining: prev?.days_remaining ?? 30,
        is_expired: Boolean(prev?.is_expired),
        is_expiring_soon: Boolean(prev?.is_expiring_soon),
        platform_upi: prev?.platform_upi || '',
        platform_owner: prev?.platform_owner || 'VedirtSetu Platforms'
      }));
      setSelectedPlan((prev: any) => prev || FALLBACK_PLANS[1]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscription();
  }, [user?.id, user?.distributor_id]);

  const handleOpenRenew = (plan?: any) => {
    const plansList = (subData?.plans && subData.plans.length > 0) ? subData.plans : FALLBACK_PLANS;
    if (plan) {
      setSelectedPlan(plan);
    } else {
      const current = plansList.find((p: any) =>
        p.name?.toLowerCase() === dist?.plan_name?.toLowerCase() ||
        p.id?.toLowerCase() === dist?.plan_name?.toLowerCase() ||
        (dist?.plan_name && dist.plan_name.toLowerCase().includes(p.name?.toLowerCase()))
      ) || plansList[1] || plansList[0];
      setSelectedPlan(current);
    }
    setUtrNumber('');
    setShowRenewModal(true);
  };

  const handleConfirmRenew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlan) return;
    const cleanUtr = utrNumber.trim();
    if (!cleanUtr || cleanUtr.length !== 12 || !/^\d{12}$/.test(cleanUtr)) {
      setErrorMsg(isHi ? 'कृपया 12-अंकीय संख्यात्मक UPI UTR नंबर दर्ज करें' : 'Please enter a valid 12-digit numeric UPI UTR reference number');
      return;
    }
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      let rawPrice = selectedPlan.monthly_fee * tenureMonths;
      if (tenureMonths === 12) {
        rawPrice = selectedPlan.yearly_fee;
      } else if (tenureMonths === 6) {
        rawPrice = Math.round(selectedPlan.monthly_fee * 6 * 0.90);
      } else if (tenureMonths === 3) {
        rawPrice = Math.round(selectedPlan.monthly_fee * 3 * 0.95);
      }
      const res = await api.renewSubscription({
        plan_name: selectedPlan.name,
        duration_months: tenureMonths,
        amount: rawPrice,
        payment_mode: 'UPI',
        reference_no: cleanUtr,
        notes: `Renewal request submitted for ${selectedPlan.name} (${tenureMonths} mo)`,
        distributor_id: dist?.id || user?.distributor_id
      });

      // Optimistically insert into local billing history table immediately
      if (res?.payment) {
        setSubData((prev: any) => {
          if (!prev) return prev;
          const currentPayments = Array.isArray(prev.payments) ? prev.payments : [];
          const deduped = currentPayments.filter((p: any) => p.reference_no !== cleanUtr);
          return {
            ...prev,
            payments: [res.payment, ...deduped],
          };
        });
      }

      setSuccessMsg(res.message || 'Renewal Request Submitted. Your UTR reference is currently being validated with the banking network. Your wholesale services will continue uninterrupted.');
      setShowRenewModal(false);
      fetchSubscription();
    } catch (err: any) {
      setErrorMsg(err.message || (isHi ? 'अनुरोध भेजने में त्रुटि' : 'Failed to submit renewal request'));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center bg-white rounded-3xl border border-slate-200 shadow-xs">
        <RefreshCw className="w-8 h-8 text-emerald-600 animate-spin mx-auto mb-2" />
        <p className="text-xs text-slate-500 font-bold">
          {isHi ? 'सब्सक्रिप्शन विवरण लोड हो रहा है...' : 'Loading subscription details...'}
        </p>
      </div>
    );
  }

  const dist = subData?.distributor;
  const daysRemaining = subData?.days_remaining ?? 0;
  const isExpired = subData?.is_expired;
  const isExpiringSoon = subData?.is_expiring_soon;
  const upiId = subData?.platform_upi || '';
  const ownerName = subData?.platform_owner || 'VedirtSetu Platforms';

  // Calculate renewal price (with 5% off on 3 months, 10% off on 6 months, and yearly fee on 12 months)
  const calculateTotal = () => {
    if (!selectedPlan) return 0;
    if (tenureMonths === 12) return selectedPlan.yearly_fee;
    if (tenureMonths === 6) return Math.round(selectedPlan.monthly_fee * 6 * 0.90);
    if (tenureMonths === 3) return Math.round(selectedPlan.monthly_fee * 3 * 0.95);
    return selectedPlan.monthly_fee * tenureMonths;
  };

  const cleanTotal = calculateTotal();
  const upiPayload = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(
    ownerName
  )}&am=${cleanTotal}&cu=INR&tn=${encodeURIComponent(`VedirtSetu Plan ${selectedPlan?.name || ''}`)}`;
  const dynamicQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(upiPayload)}`;
  const qrUrl = subData?.platform_qr_image || dynamicQrUrl;

  return (
    <div className="space-y-6">
      {/* Toast Banners */}
      {successMsg && (
        <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs sm:text-sm font-bold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg('')} className="text-emerald-700 font-bold hover:underline">
            ✕
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 rounded-2xl bg-red-50 border border-red-300 text-red-800 text-xs sm:text-sm font-bold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg('')} className="text-red-700 font-bold hover:underline">
            ✕
          </button>
        </div>
      )}
      {/* PENDING SETTLEMENT BANNER (OPTION 3) */}
      {subData?.payments?.some((p: any) => p.status === 'pending') && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 sm:p-5 flex items-start gap-3 shadow-xs animate-in fade-in duration-200">
          <Clock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5 animate-pulse" />
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-extrabold text-amber-900">Renewal Request Submitted</h4>
              <span className="px-2.5 py-0.5 rounded-full bg-amber-200 text-amber-900 text-[10px] font-black uppercase tracking-wider">
                Pending Settlement
              </span>
            </div>
            <p className="text-xs text-amber-800 font-medium leading-relaxed">
              Your UTR reference is currently being validated with the banking network. Your wholesale services will continue uninterrupted.
            </p>
          </div>
        </div>
      )}

      {/* 1. CURRENT ACTIVE SUBSCRIPTION STATUS HERO */}
      <div
        className={`p-6 sm:p-7 rounded-3xl text-white shadow-xl relative overflow-hidden transition-all ${
          isExpired
            ? 'bg-gradient-to-tr from-rose-900 via-rose-800 to-slate-900'
            : isExpiringSoon
            ? 'bg-gradient-to-tr from-amber-900 via-amber-800 to-slate-900'
            : 'bg-gradient-to-tr from-emerald-950 via-emerald-800 to-slate-900'
        }`}
      >
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-xs font-bold">
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>{isHi ? 'वेदिरतसेतु आधिकारिक वितरक लाइसेंस' : 'Official VedirtSetu Distributor License'}</span>
            </div>

            <h2 className="text-2xl sm:text-3xl font-black tracking-tight flex items-center gap-3">
              <span>{dist?.plan_name || 'Growth Pro'}</span>
              <span
                className={`text-xs px-3 py-1 rounded-full font-black uppercase tracking-wider ${
                  isExpired
                    ? 'bg-rose-500 text-white'
                    : isExpiringSoon
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-emerald-400 text-slate-950'
                }`}
              >
                {isExpired
                  ? isHi
                    ? 'समाप्त (Expired)'
                    : 'Expired'
                  : isExpiringSoon
                  ? isHi
                    ? 'जल्द समाप्त होने वाला'
                    : 'Expiring Soon'
                  : isHi
                  ? 'सक्रिय (Active)'
                  : 'Active'}
              </span>
            </h2>

            <p className="text-xs sm:text-sm text-emerald-100/90 leading-relaxed">
              {isExpired
                ? isHi
                  ? 'आपका सब्सक्रिप्शन समाप्त हो चुका है। दैनिक ऑर्डर कटऑफ व डिलीवरी नेटवर्क चालू रखने हेतु तुरंत रिन्यू करें।'
                  : 'Your subscription has expired. Please renew immediately to avoid delivery cutoff interruption.'
                : isExpiringSoon
                ? isHi
                  ? `आपके सब्सक्रिप्शन में केवल ${daysRemaining} दिन शेष हैं। असुविधा से बचने के लिए अभी नवीनीकरण करें।`
                  : `Only ${daysRemaining} days remaining in your plan. Renew now to ensure seamless ordering.`
                : isHi
                ? `आपका वितरक खाता सक्रिय है। अगली नवीनीकरण तिथि: ${dist?.subscription_renewal_date || '2026-10-31'} (${daysRemaining} दिन शेष)।`
                : `Your distributor account is fully active. Next renewal date: ${dist?.subscription_renewal_date || '2026-10-31'} (${daysRemaining} days left).`}
            </p>

            <div className="flex flex-wrap items-center gap-4 text-xs pt-1 text-emerald-200">
              <div>
                <span className="opacity-75 block">{isHi ? 'मासिक शुल्क:' : 'Monthly Fee:'}</span>
                <span className="font-extrabold text-white text-sm">{formatCurrency(dist?.monthly_fee || 1999)}</span>
              </div>
              <div className="w-px h-6 bg-white/20" />
              <div>
                <span className="opacity-75 block">{isHi ? 'दुकानों की सीमा:' : 'Shop Capacity:'}</span>
                <span className="font-extrabold text-white text-sm">
                  {dist?.max_shops || 100} {isHi ? 'दुकानें' : 'Shops'}
                </span>
              </div>
              <div className="w-px h-6 bg-white/20" />
              <div>
                <span className="opacity-75 block">{isHi ? 'नवीनीकरण तिथि:' : 'Renewal Date:'}</span>
                <span className="font-extrabold text-amber-300 text-sm">
                  {dist?.subscription_renewal_date || '2026-10-31'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 shrink-0 w-full sm:w-auto">
            <button
              onClick={() => handleOpenRenew()}
              className="px-6 py-3.5 rounded-2xl bg-amber-400 hover:bg-amber-300 active:scale-95 text-slate-950 font-black text-sm shadow-lg flex items-center justify-center gap-2 transition"
            >
              <Zap className="w-4 h-4 fill-slate-950" />
              <span>{isHi ? '⚡ प्लान रिन्यू / अपग्रेड करें' : '⚡ Renew / Upgrade Plan'}</span>
            </button>
            <p className="text-[11px] text-center text-emerald-200/80 font-medium">
              {isHi ? 'सुरक्षित ऑनलाइन UPI QR से भुगतान' : 'Instant Activation via UPI QR'}
            </p>
          </div>
        </div>
      </div>

      {/* 2. AVAILABLE PLATFORM PLANS TIER COMPARISON */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base sm:text-lg font-black text-slate-800">
              {isHi ? 'उपलब्ध वितरक योजनाएं (Subscription Plans)' : 'Available Distributor Plans'}
            </h3>
            <p className="text-xs text-slate-500">
              {isHi
                ? 'अपनी आवश्यकतानुसार उपयुक्त प्लान चुनें व किसी भी थोक व वितरण व्यापार के लिए उपयोग करें'
                : 'Choose the best plan for your wholesale & order distribution business'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {((subData?.plans && subData.plans.length > 0) ? subData.plans : FALLBACK_PLANS).map((plan: any, idx: number) => {
            const isCurrent = plan.name?.toLowerCase() === dist?.plan_name?.toLowerCase() ||
              plan.id?.toLowerCase() === dist?.plan_name?.toLowerCase() ||
              (dist?.plan_name && dist.plan_name.toLowerCase().includes(plan.name?.toLowerCase()));
            return (
              <div
                key={`sub-plan-${plan.id ?? idx}-${idx}`}
                className={`rounded-3xl p-6 border transition flex flex-col justify-between relative ${
                  plan.popular
                    ? 'bg-emerald-50/50 border-emerald-400 shadow-md ring-2 ring-emerald-500/20'
                    : 'bg-white border-slate-200 shadow-xs hover:border-slate-300'
                }`}
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-emerald-700 text-white text-[10px] font-black uppercase tracking-wider shadow-sm">
                    {isHi ? 'सर्वाधिक लोकप्रिय' : 'Most Popular'}
                  </span>
                )}

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <h4 className="font-extrabold text-base text-slate-900">
                        {isHi && plan.name_hi ? plan.name_hi : plan.name}
                      </h4>
                      {isCurrent && (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-200">
                          {isHi ? 'वर्तमान प्लान' : 'Current Plan'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {isHi && plan.description ? plan.description : plan.description_en}
                    </p>
                  </div>

                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-black text-slate-900">{formatCurrency(plan.monthly_fee)}</span>
                      <span className="text-xs text-slate-500 font-bold">{isHi ? '/ माह' : '/ month'}</span>
                    </div>
                    <p className="text-[11px] text-emerald-700 font-bold mt-0.5">
                      {isHi ? `वार्षिक: ${formatCurrency(plan.yearly_fee)} (15% बचत)` : `Yearly: ${formatCurrency(plan.yearly_fee)} (Save 15%)`}
                    </p>
                  </div>

                  <div className="border-t border-slate-100 pt-3 space-y-2">
                    <span className="text-[11px] font-extrabold text-slate-700 uppercase tracking-wider block">
                      {isHi ? 'मुख्य विशेषताएं:' : 'Included Features:'}
                    </span>
                    <ul className="space-y-2 text-xs text-slate-600">
                      {(isHi && plan.features_hi ? plan.features_hi : plan.features_en)?.map(
                        (feat: string, fIdx: number) => (
                          <li key={`dist-feat-${plan.id ?? idx}-${fIdx}`} className="flex items-start gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                            <span>{feat}</span>
                          </li>
                        )
                      )}
                    </ul>
                  </div>
                </div>

                <div className="pt-6">
                  <button
                    onClick={() => handleOpenRenew(plan)}
                    className={`w-full py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 ${
                      isCurrent
                        ? 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs'
                        : 'bg-slate-900 hover:bg-slate-800 text-white'
                    }`}
                  >
                    <span>{isCurrent ? (isHi ? 'यह प्लान रिन्यू करें' : 'Renew This Plan') : (isHi ? 'इस प्लान में बदलें' : 'Upgrade to This Plan')}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. SUBSCRIPTION PAYMENT HISTORY & INVOICES */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-emerald-700" />
            <h3 className="font-extrabold text-sm sm:text-base text-slate-800">
              {isHi ? 'सब्सक्रिप्शन भुगतान इतिहास व रसीदें' : 'Subscription Billing History & Receipts'}
            </h3>
          </div>
          <span className="text-xs font-bold text-slate-500">
            {subData?.payments?.length || 0} {isHi ? 'भुगतान दर्ज' : 'Records'}
          </span>
        </div>

        {subData?.payments && subData.payments.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                <tr>
                  <th className="p-3">#</th>
                  <th className="p-3">{isHi ? 'भुगतान तिथि' : 'Date'}</th>
                  <th className="p-3">{isHi ? 'अवधि (वैधता)' : 'Period'}</th>
                  <th className="p-3">{isHi ? 'राशि' : 'Amount'}</th>
                  <th className="p-3">{isHi ? 'माध्यम' : 'Mode'}</th>
                  <th className="p-3">{isHi ? 'संदर्भ संख्या (UTR)' : 'Reference / UTR'}</th>
                  <th className="p-3 text-center">{isHi ? 'स्थिति' : 'Status'}</th>
                  <th className="p-3 text-right">{isHi ? 'कार्रवाई' : 'Action'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subData.payments.map((p: any, idx: number) => (
                  <tr key={`sub-pay-${p.id ?? idx}-${idx}`} className="hover:bg-slate-50/70 transition">
                    <td className="p-3 font-mono text-slate-400">{idx + 1}</td>
                    <td className="p-3 font-bold text-slate-800">{p.payment_date}</td>
                    <td className="p-3 text-slate-600">
                      {p.period_start} <span className="text-slate-400">→</span> {p.period_end}
                    </td>
                    <td className="p-3 font-black text-emerald-800">{formatCurrency(p.amount)}</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold text-[11px]">
                        {p.payment_mode}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-slate-700">{p.reference_no || 'N/A'}</td>
                    <td className="p-3 text-center">
                      {p.status === 'pending' ? (
                        <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 border border-amber-200 font-bold text-[10px] animate-pulse">
                          {isHi ? 'पुष्टि प्रतीक्षित' : 'Pending'}
                        </span>
                      ) : p.status === 'rejected' ? (
                        <span className="px-2 py-0.5 rounded-md bg-rose-100 text-rose-700 border border-rose-200 font-bold text-[10px]">
                          {isHi ? 'अस्वीकृत' : 'Rejected'}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold text-[10px]">
                          {isHi ? 'सक्रिय / स्वीकृत' : 'Active'}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => setSlipPayment(p)}
                        className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 font-bold text-[11px] inline-flex items-center gap-1 transition cursor-pointer"
                      >
                        <Printer className="w-3 h-3 text-slate-500" />
                        <span>{isHi ? 'रसीद' : 'Receipt'}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-slate-400 font-medium">
            {isHi ? 'अभी तक कोई पिछला भुगतान रिकॉर्ड नहीं है।' : 'No previous subscription payment records.'}
          </div>
        )}
      </div>

      {/* 4. RENEWAL / UPGRADE MODAL */}
      {showRenewModal && selectedPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/75 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-emerald-100 overflow-hidden my-auto max-h-[90vh] flex flex-col">
            <div className="bg-gradient-to-r from-emerald-800 to-emerald-700 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-extrabold text-base flex items-center gap-1.5">
                  <Zap className="w-4 h-4 fill-amber-300 text-amber-300" />
                  <span>{isHi ? 'सब्सक्रिप्शन रिन्यूअल व अपग्रेड' : 'Subscription Plan Renewal'}</span>
                </h3>
                <p className="text-xs text-emerald-200">
                  {selectedPlan.name} • {formatCurrency(selectedPlan.monthly_fee)}/mo
                </p>
              </div>
              <button
                onClick={() => setShowRenewModal(false)}
                className="text-white hover:text-emerald-200 font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmRenew} className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Select Duration */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  {isHi ? 'नवीनीकरण अवधि चुनें:' : 'Select Renewal Duration:'}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { months: 1, label: isHi ? '1 महीना' : '1 Month', discount: '' },
                    { months: 3, label: isHi ? '3 महीने' : '3 Months', discount: '5% Off' },
                    { months: 6, label: isHi ? '6 महीने' : '6 Months', discount: '10% Off' },
                    { months: 12, label: isHi ? '1 वर्ष (सर्वोत्तम)' : '1 Year (Best)', discount: '15% Off' },
                  ].map((ten, tenIdx) => (
                    <button
                      key={`tenure-${ten.months}-${tenIdx}`}
                      type="button"
                      onClick={() => setTenureMonths(ten.months)}
                      className={`p-2.5 rounded-xl border text-xs font-bold text-left transition flex items-center justify-between ${
                        tenureMonths === ten.months
                          ? 'bg-emerald-50 border-emerald-600 text-emerald-900 ring-1 ring-emerald-600'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span>{ten.label}</span>
                      {ten.discount && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 font-black">
                          {ten.discount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Total Payable Card */}
              <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-emerald-800 font-bold block">
                    {isHi ? 'कुल देय राशि' : 'Total Amount Payable'}
                  </span>
                  <span className="text-xl font-black text-emerald-950">{formatCurrency(cleanTotal)}</span>
                </div>
                <div className="text-right text-[11px] text-slate-500 font-medium">
                  {tenureMonths} {isHi ? 'माह की वैधता' : 'months validity'}
                </div>
              </div>

              {/* UPI QR Display */}
              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200 flex flex-col items-center justify-center">
                <img
                  src={qrUrl}
                  alt="Platform UPI QR"
                  className="w-44 h-44 rounded-xl object-contain bg-white p-2 border border-slate-200 shadow-inner"
                  loading="lazy"
                />
                <p className="text-[11px] text-slate-500 mt-2 font-medium flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Google Pay, PhonePe, Paytm, BHIM</span>
                </p>
              </div>

              {/* Platform UPI ID Copy */}
              <div className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between text-xs">
                <div>
                  <span className="text-[10px] text-slate-400 block font-bold">
                    {isHi ? 'प्लेटफॉर्म ओनर UPI आईडी:' : 'Platform Owner UPI ID:'}
                  </span>
                  <span className="font-mono font-bold text-slate-800 text-[11px]">{upiId}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(upiId);
                    setCopiedUpi(true);
                    setTimeout(() => setCopiedUpi(false), 2000);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold transition flex items-center gap-1 shrink-0"
                >
                  {copiedUpi ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>{isHi ? 'कॉपी हो गया' : 'Copied'}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>{isHi ? 'कॉपी करें' : 'Copy'}</span>
                    </>
                  )}
                </button>
              </div>

              {/* Direct UPI Mobile Link */}
              <a
                href={upiPayload}
                className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-xs transition"
              >
                <Smartphone className="w-4 h-4" />
                <span>{isHi ? 'सीधे UPI ऐप में खोलें' : 'Open in UPI App (GPay/PhonePe)'}</span>
                <ExternalLink className="w-3.5 h-3.5 opacity-80" />
              </a>

              {/* UTR Input */}
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-700">
                  {isHi ? 'भुगतान के बाद 12-अंकीय UPI UTR / संदर्भ संख्या दर्ज करें:' : 'After payment, enter 12-digit UPI UTR / Ref No:'} *
                </label>
                <input
                  type="text"
                  value={utrNumber}
                  onChange={(e) => setUtrNumber(e.target.value)}
                  placeholder="e.g. 427819283741"
                  maxLength={12}
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs font-mono font-bold focus:border-emerald-600 outline-hidden"
                />
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowRenewModal(false)}
                  className="w-1/3 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-50 transition"
                >
                  {isHi ? 'रद्द करें' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !utrNumber.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold transition shadow-xs disabled:opacity-50"
                >
                  {isSubmitting ? (isHi ? 'सत्यापन हो रहा है...' : 'Verifying...') : (isHi ? 'रिन्यूअल पूर्ण करें' : 'Confirm Renewal')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5. DEDICATED PRINTABLE SUBSCRIPTION RECEIPT MODAL (Issue 19) */}
      {slipPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/75 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto flex flex-col">
            <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-emerald-400" />
                <h3 className="font-extrabold text-base">
                  {isHi ? 'सब्सक्रिप्शन भुगतान रसीद (Tax Invoice)' : 'Subscription Payment Receipt'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSlipPayment(null)}
                className="text-slate-400 hover:text-white font-bold text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div id="subscription-receipt-print-area" className="p-6 space-y-5 bg-white text-slate-800 text-xs">
              {/* Header Info */}
              <div className="flex items-start justify-between border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900 tracking-tight">VEDIRTSETU PLATFORMS</h2>
                  <p className="text-[11px] text-slate-500">B2B Wholesale Ordering & Distribution SaaS</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Platform Owner: {ownerName}</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Receipt No</span>
                  <span className="font-mono font-black text-slate-800 text-sm">
                    REC-SUB-{slipPayment.id || slipPayment.reference_no?.slice(-6) || '001'}
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5">{slipPayment.payment_date}</span>
                </div>
              </div>

              {/* Distributor Billed To */}
              <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Billed To (Distributor)</span>
                <p className="font-extrabold text-slate-900 text-sm">{dist?.business_name || user?.business_name || 'Wholesale Distributor'}</p>
                <p className="text-slate-600 font-medium">{dist?.owner_name || user?.name} • {dist?.mobile || user?.mobile}</p>
                {dist?.city && <p className="text-slate-500 text-[11px]">{dist.city}{dist.address ? `, ${dist.address}` : ''}</p>}
              </div>

              {/* Plan & Payment Table */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-100 text-slate-600 font-bold text-[11px]">
                    <tr>
                      <th className="p-3">Plan Details</th>
                      <th className="p-3">Validity</th>
                      <th className="p-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                    <tr>
                      <td className="p-3">
                        <div className="font-extrabold text-slate-900">{slipPayment.plan_name || dist?.plan_name || 'Growth Pro'}</div>
                        <div className="text-[11px] text-slate-500">{slipPayment.duration_months || 1} Month(s) SaaS Access</div>
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-600">
                        {slipPayment.period_start} → {slipPayment.period_end}
                      </td>
                      <td className="p-3 text-right font-black text-sm text-slate-900">
                        {formatCurrency(slipPayment.amount)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Transaction Breakdown */}
              <div className="grid grid-cols-2 gap-3 text-xs border-t border-slate-200 pt-3">
                <div>
                  <span className="text-slate-400 text-[11px] block">Payment Mode:</span>
                  <span className="font-bold text-slate-800">{slipPayment.payment_mode || 'UPI'}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">UTR / Transaction Ref:</span>
                  <span className="font-mono font-bold text-slate-800 text-[11px]">{slipPayment.reference_no || 'N/A'}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">Status:</span>
                  <span className={`inline-block px-2 py-0.5 rounded-md font-bold text-[10px] ${
                    slipPayment.status === 'pending'
                      ? 'bg-amber-100 text-amber-900'
                      : slipPayment.status === 'rejected'
                      ? 'bg-rose-100 text-rose-700'
                      : 'bg-emerald-100 text-emerald-800'
                  }`}>
                    {slipPayment.status === 'pending' ? 'Verification Pending' : slipPayment.status === 'rejected' ? 'Rejected' : 'Paid & Settled'}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-slate-400 text-[11px] block">Total Settled:</span>
                  <span className="font-black text-emerald-800 text-base">{formatCurrency(slipPayment.amount)}</span>
                </div>
              </div>

              {/* Footer Note */}
              <div className="text-center text-[10px] text-slate-400 pt-2 border-t border-slate-100">
                This is a computer-generated subscription billing receipt. No signature required.
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setSlipPayment(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-100 cursor-pointer"
              >
                {isHi ? 'बंद करें' : 'Close'}
              </button>
              <button
                type="button"
                onClick={() => {
                  window.print();
                }}
                className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition active:scale-95 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>{isHi ? 'रसीद प्रिंट / डाउनलोड करें' : 'Print / Download Slip'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DistributorSubscriptionView;