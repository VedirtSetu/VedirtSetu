import React, { useState, useEffect } from 'react';
import { RetailerDistributorInfo } from '../../types/index.ts';
import { Language, translations } from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import {
  Building2,
  Phone,
  MessageCircle,
  Mail,
  MapPin,
  Clock,
  QrCode,
  CreditCard,
  Truck,
  Store,
  ShieldCheck,
  Copy,
  Check,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  Calendar,
} from 'lucide-react';

interface RetailerDistributorViewProps {
  lang: Language;
  onOpenPaymentModal: () => void;
}

export const RetailerDistributorView: React.FC<RetailerDistributorViewProps> = ({
  lang,
  onOpenPaymentModal,
}) => {
  const isHi = lang === 'hi';
  const t = translations[lang];

  const [data, setData] = useState<RetailerDistributorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [copiedMobile, setCopiedMobile] = useState(false);

  const loadDistributorInfo = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await api.getMyDistributor();
      setData(res);
    } catch (err: any) {
      setErrorMsg(
        err.message || (isHi ? 'वितरक की जानकारी लोड करने में असमर्थ' : 'Failed to load distributor details')
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDistributorInfo();
  }, [lang]);

  const handleCopy = (text: string, type: 'upi' | 'mobile') => {
    navigator.clipboard.writeText(text);
    if (type === 'upi') {
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2500);
    } else {
      setCopiedMobile(true);
      setTimeout(() => setCopiedMobile(false), 2500);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-500 bg-white rounded-3xl border border-slate-200">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-700" />
        <p className="text-xs font-bold">{isHi ? 'वितरक विवरण लोड हो रहा है...' : 'Loading distributor details...'}</p>
      </div>
    );
  }

  if (errorMsg || !data?.distributor) {
    return (
      <div className="p-6 text-center bg-rose-50 border border-rose-200 rounded-3xl space-y-3">
        <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
        <h3 className="font-black text-rose-900 text-sm">
          {errorMsg || (isHi ? 'वितरक का विवरण उपलब्ध नहीं है' : 'Distributor information unavailable')}
        </h3>
        <button
          onClick={loadDistributorInfo}
          className="px-4 py-2 rounded-xl bg-rose-600 text-white font-bold text-xs hover:bg-rose-700 transition"
        >
          {isHi ? 'पुनः प्रयास करें' : 'Try Again'}
        </button>
      </div>
    );
  }

  const { distributor, shop, cutoff_time, allow_late_orders } = data;
  const rawDigits = distributor.mobile.replace(/\D/g, '');
  const cleanMobile = rawDigits.length > 10 ? rawDigits.slice(-10) : rawDigits;
  const hasValidUpi = Boolean(distributor.upi_id && distributor.upi_id !== 'vyapar_khata@okicici');
  const upiId = hasValidUpi ? distributor.upi_id : '';

  // Dynamic QR URL fallback if custom uploaded QR is not set
  const dynamicQrUrl = upiId
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(
        `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent( distributor.business_name )}&cu=INR&tn=${encodeURIComponent(`Supply Bill - ${shop?.shop_name || 'Retailer'}`)}`
      )}`
    : '';
  const displayQr = distributor.qr_image || dynamicQrUrl;

  const whatsappMessage = encodeURIComponent(
    `नमस्ते ${distributor.owner_name} जी! मैं आपकी दुकान "${shop?.shop_name || 'दुकान'}" (${shop?.shop_code || ''}) से संपर्क कर रहा हूँ।`
  );

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {/* 1. DISTRIBUTOR HERO CARD */}
      <div className="bg-gradient-to-br from-emerald-900 via-emerald-800 to-slate-900 text-white rounded-3xl p-6 sm:p-7 shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 w-60 h-60 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-2xl bg-white/10 border border-white/20 backdrop-blur-md flex items-center justify-center shrink-0 shadow-inner">
              <Building2 className="w-8 h-8 text-emerald-300" />
            </div>
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-200 text-[11px] font-black tracking-wider uppercase border border-emerald-400/30 mb-2">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>{isHi ? 'आपका अधिकृत थोक वितरक व सप्लायर' : 'Your Authorized Wholesaler / Distributor'}</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-black tracking-tight">{distributor.business_name}</h1>
              <p className="text-xs sm:text-sm text-emerald-200/90 mt-1 font-medium">
                {isHi ? 'संचालक / स्वामी:' : 'Proprietor:'} <strong className="text-white font-bold">{distributor.owner_name}</strong>
              </p>
              {distributor.city && (
                <div className="flex items-center gap-1 text-[11px] text-emerald-200/80 mt-1">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span>{distributor.city}</span>
                </div>
              )}
            </div>
          </div>

          {/* Quick Contact Action Buttons */}
          <div className="flex flex-wrap items-center gap-2.5 pt-2 md:pt-0">
            <a
              href={`https://wa.me/91${cleanMobile}?text=${whatsappMessage}`}
              target="_blank"
              rel="noreferrer"
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs shadow-md transition"
            >
              <MessageCircle className="w-4 h-4 fill-slate-950" />
              <span>{isHi ? 'व्हाट्सएप चैट' : 'WhatsApp'}</span>
            </a>

            <a
              href={`tel:+91${cleanMobile}`}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold text-xs backdrop-blur-md transition"
            >
              <Phone className="w-4 h-4 text-emerald-300" />
              <span>{isHi ? 'कॉल करें' : 'Call'}</span>
            </a>

            {distributor.email && (
              <a
                href={`mailto:${distributor.email}`}
                className="hidden sm:inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold text-xs transition"
              >
                <Mail className="w-4 h-4 text-slate-300" />
                <span>ईमेल</span>
              </a>
            )}
          </div>
        </div>
      </div>

      {/* 2. THREE CORE COLUMNS: CONTACT INFO, ORDER CUTOFF, PAYMENT QR */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Column A: Contact Details */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-emerald-700" />
            <h3 className="font-black text-sm text-slate-900">
              {isHi ? 'संपर्क व पता विवरण' : 'Contact & Address'}
            </h3>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">
                  {isHi ? 'मोबाइल नंबर (हेल्पलाइन)' : 'Mobile (Helpline)'}
                </span>
                <span className="font-mono font-black text-slate-900 text-sm mt-0.5 block">
                  +91 {distributor.mobile}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(distributor.mobile, 'mobile')}
                className="p-2 rounded-xl text-slate-500 hover:text-emerald-700 hover:bg-white border border-transparent hover:border-slate-200 transition"
                title="कॉपी करें"
              >
                {copiedMobile ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200">
              <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">
                {isHi ? 'गोदाम / वितरण कार्यालय का पता' : 'Godown / Office Address'}
              </span>
              <p className="font-bold text-slate-800 mt-1 leading-relaxed">
                {distributor.address || (isHi ? 'मुख्य वितरण केंद्र' : 'Main Distribution Center')}
              </p>
              {distributor.city && (
                <span className="text-[11px] text-slate-500 font-medium block mt-0.5">
                  {distributor.city}
                </span>
              )}
            </div>

            {distributor.email && (
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200">
                <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">
                  {isHi ? 'ईमेल आईडी' : 'Email Address'}
                </span>
                <span className="font-mono text-slate-700 font-bold mt-0.5 block truncate">
                  {distributor.email}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Column B: Order Timings & Policies */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" />
            <h3 className="font-black text-sm text-slate-900">
              {isHi ? 'दैनिक ऑर्डर समय सीमा' : 'Daily Cutoff & Delivery'}
            </h3>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-950 space-y-1.5">
              <span className="text-[10px] font-black uppercase tracking-wider text-amber-800 block">
                {isHi ? 'दैनिक कट-ऑफ समय' : 'Daily Cutoff Time'}
              </span>
              <div className="text-xl font-black text-amber-900 flex items-center gap-2">
                <Clock className="w-5 h-5 text-amber-600" />
                <span>{cutoff_time} {isHi ? 'बजे' : 'hrs'}</span>
              </div>
              <p className="text-[11px] text-amber-900/80 leading-relaxed">
                {isHi
                  ? `अगली डिलीवरी की सप्लाई के लिए कृपया रोज़ाना शाम ${cutoff_time} बजे से पहले अपना ऑर्डर बुक कर लें।`
                  : `Please submit your supply order daily before ${cutoff_time} for regular scheduled delivery.`}
              </p>
            </div>

            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 font-bold">{isHi ? 'लेट ऑर्डर नीति:' : 'Late Orders:'}</span>
                <span
                  className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                    allow_late_orders ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {allow_late_orders
                    ? (isHi ? 'स्वीकार्य (अनुमति प्राप्त)' : 'Allowed')
                    : (isHi ? 'अस्वीकार्य (सख्त कटऑफ)' : 'Not Allowed')}
                </span>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-slate-200">
                <span className="text-slate-600 font-bold">{isHi ? 'सप्लाई समय:' : 'Delivery Time:'}</span>
                <span className="text-slate-900 font-black">सुबह 5:30 AM - 7:00 AM</span>
              </div>
            </div>

            {/* My Shop Connection */}
            {shop && (
              <div className="p-3 rounded-2xl bg-emerald-50/60 border border-emerald-200 space-y-1">
                <div className="flex items-center gap-1.5 text-emerald-950 font-bold text-[11px]">
                  <Store className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{isHi ? 'आपकी दुकान का रूट' : 'Your Assigned Route'}:</span>
                </div>
                <div className="flex items-center justify-between text-xs pt-1">
                  <span className="font-bold text-slate-800">{shop.route}</span>
                  <span className="px-2 py-0.5 rounded-md bg-white border border-emerald-200 font-mono font-black text-emerald-950 text-[10px]">
                    {shop.shop_code}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Column C: Distributor Payment QR Code & UPI */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <QrCode className="w-4 h-4 text-emerald-700" />
              <h3 className="font-black text-sm text-slate-900">
                {isHi ? 'वितरक पेमेंट क्यूआर (QR)' : 'Payment UPI QR'}
              </h3>
            </div>
            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              {isHi ? 'सीधा भुगतान' : 'Direct Pay'}
            </span>
          </div>

          <div className="flex flex-col items-center p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
            {displayQr ? (
              <>
                {/* QR Image */}
                <div className="p-2 bg-white rounded-2xl shadow-sm border border-slate-200 relative group">
                  <img
                    src={displayQr}
                    alt="Distributor Payment QR"
                    className="w-40 h-40 object-contain rounded-xl"
                  />
                </div>

                {/* UPI ID Pill */}
                {upiId && (
                  <div className="w-full flex items-center justify-between bg-white px-3 py-2 rounded-xl border border-slate-200 text-xs">
                    <div className="truncate mr-2">
                      <span className="text-[9px] text-slate-400 block font-bold uppercase">UPI ID</span>
                      <span className="font-mono font-black text-slate-900 text-xs truncate block">
                        {upiId}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(upiId, 'upi')}
                      className="px-2.5 py-1 rounded-lg text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-bold text-[11px] transition shrink-0"
                    >
                      {copiedUpi ? (isHi ? 'कॉपी हुआ!' : 'Copied!') : (isHi ? 'कॉपी' : 'Copy')}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-6 px-3 space-y-2">
                <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto">
                  <QrCode className="w-6 h-6" />
                </div>
                <p className="text-xs font-bold text-slate-700">
                  {isHi ? 'वितरक द्वारा UPI QR अभी सेट नहीं किया गया है' : 'UPI QR not configured yet'}
                </p>
                <p className="text-[11px] text-slate-500">
                  {isHi ? 'कृपया सीधे वितरक से संपर्क करें या नकद भुगतान करें।' : 'Please contact distributor directly or pay in cash.'}
                </p>
              </div>
            )}

            {/* Pay Now Button */}
            <button
              type="button"
              onClick={onOpenPaymentModal}
              className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs flex items-center justify-center gap-2 shadow-xs transition"
            >
              <CreditCard className="w-4 h-4" />
              <span>{isHi ? 'बकाया बिल का भुगतान करें' : 'Pay Outstanding Bill'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
export default RetailerDistributorView;