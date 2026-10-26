import React, { useState } from 'react';
import { formatCurrency, Language } from '../../utils/i18n.ts';
import { api } from '../../services/api.ts';
import { QrCode, Smartphone, CheckCircle2, Copy, Check, ExternalLink, ShieldCheck } from 'lucide-react';

interface UpiPaymentModalProps {
  lang: Language;
  amount: number;
  shopId: number;
  distributorUpi?: string;
  distributorName?: string;
  qrImage?: string;
  onClose: () => void;
  onPaymentSuccess?: () => void;
}

export const UpiPaymentModal: React.FC<UpiPaymentModalProps> = ({
  lang,
  amount,
  shopId,
  distributorUpi = '',
  distributorName = 'VedirtSetu Wholesale Distributors',
  qrImage,
  onClose,
  onPaymentSuccess,
}) => {
  const isHi = lang === 'hi';
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [utrNumber, setUtrNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedSuccess, setSubmittedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const hasValidUpi = Boolean(distributorUpi && distributorUpi.trim() && distributorUpi !== 'vyapar_khata@okicici');
  const upiId = hasValidUpi ? distributorUpi.trim() : '';
  const defaultAmount = Math.max(1, Math.round(Number(amount || 0) * 100) / 100);
  const [customPayAmount, setCustomPayAmount] = useState<string>(String(defaultAmount));
  const cleanAmount = Math.max(1, Math.round((parseFloat(customPayAmount) || defaultAmount) * 100) / 100);

  // Standard UPI URI format supported by all Indian UPI apps
  const upiPayload = upiId
    ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(
        distributorName
      )}&am=${cleanAmount}&cu=INR&tn=${encodeURIComponent(`Shop Dues Payment #${shopId}`)}`
    : '';

  const fallbackQrImageUrl = upiPayload
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data=${encodeURIComponent(
        upiPayload
      )}`
    : '';
  const qrImageUrl = qrImage || fallbackQrImageUrl;

  const handleCopyUpi = () => {
    navigator.clipboard.writeText(upiId);
    setCopiedUpi(true);
    setTimeout(() => setCopiedUpi(false), 2500);
  };

  const handleRecordSelfPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUtr = utrNumber.trim();
    if (!/^\d{12}$/.test(cleanUtr)) {
      setErrorMsg(isHi ? 'कृपया वैध 12-अंकीय संख्यात्मक UPI UTR संख्या दर्ज करें' : 'Please enter a valid 12-digit numeric UPI UTR number');
      return;
    }
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      setErrorMsg(isHi ? 'कृपया वैध भुगतान राशि दर्ज करें' : 'Please enter a valid payment amount');
      return;
    }
    setErrorMsg('');
    setIsSubmitting(true);
    try {
      await api.recordPayment({
        shop_id: shopId,
        amount: cleanAmount,
        payment_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        payment_mode: 'UPI',
        notes: `Online UPI Transfer: Ref #${cleanUtr}`,
      });
      setSubmittedSuccess(true);
      if (onPaymentSuccess) onPaymentSuccess();
    } catch (err: any) {
      setErrorMsg(err.message || (isHi ? 'भुगतान दर्ज करने में विफल' : 'Failed to record payment'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/75 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl border border-emerald-100 overflow-hidden my-auto">
        {/* Header */}
        <div className="bg-gradient-to-r from-emerald-800 to-emerald-700 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-amber-300" />
            <h3 className="font-extrabold text-base">
              {isHi ? 'यूपीआई क्यूआर कोड भुगतान' : 'Pay via UPI QR Code'}
            </h3>
          </div>
          <button onClick={onClose} className="text-white hover:text-emerald-200 font-bold text-lg">
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          {submittedSuccess ? (
            <div className="text-center py-6 space-y-3">
              <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h4 className="font-black text-slate-800 text-lg">
                {isHi ? 'भुगतान विवरण सत्यापन हेतु भेजा गया!' : 'Payment Submitted for Verification!'}
              </h4>
              <p className="text-xs text-slate-500 max-w-xs mx-auto">
                {isHi
                  ? `₹${cleanAmount} का UPI भुगतान विवरण दर्ज कर लिया गया है। वितरक द्वारा UTR सत्यापन के तुरंत बाद यह आपके खाते (लेज़र) में जुड़ जाएगा।`
                  : `UPI payment of ₹${cleanAmount} has been submitted. It will be credited to your ledger as soon as the distributor verifies the UTR.`}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-6 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs"
              >
                {isHi ? 'पूर्ण हुआ' : 'Done'}
              </button>
            </div>
          ) : (
            <>
              {/* Amount Due Box (Editable for partial/exact payments) */}
              <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-center space-y-1.5">
                <div className="text-xs text-emerald-800 font-bold">
                  {isHi ? 'भुगतान राशि (आप आंशिक या पूर्ण राशि भर सकते हैं)' : 'Amount to Pay (Full or Partial)'}
                </div>
                <div className="flex items-center justify-center gap-1">
                  <span className="text-lg font-black text-emerald-900">₹</span>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    value={customPayAmount}
                    onChange={(e) => setCustomPayAmount(e.target.value)}
                    className="w-36 text-center text-xl font-black text-emerald-950 bg-white px-2.5 py-1 rounded-xl border border-emerald-300 focus:border-emerald-600 outline-hidden"
                  />
                </div>
              </div>

              {/* QR Code Container */}
              {qrImageUrl ? (
                <>
                  <div className="bg-white p-3 rounded-2xl border-2 border-dashed border-emerald-300 flex flex-col items-center justify-center shadow-inner">
                    <img
                      src={qrImageUrl}
                      alt="UPI QR Code"
                      className="w-48 h-48 rounded-xl object-contain"
                      loading="lazy"
                    />
                    <p className="text-[11px] text-slate-500 mt-2 font-medium flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Google Pay, PhonePe, Paytm, BHIM</span>
                    </p>
                  </div>

                  {/* UPI ID with 1-Click Copy */}
                  {upiId && (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                      <div>
                        <span className="text-[10px] text-slate-400 block font-bold">UPI ID:</span>
                        <span className="font-mono font-bold text-slate-800 text-[11px]">{upiId}</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCopyUpi}
                        className="px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-[11px] font-bold text-emerald-800 hover:bg-emerald-50 transition flex items-center gap-1 shrink-0"
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
                  )}

                  {/* Direct UPI App launch button for mobile */}
                  {upiPayload && (
                    <a
                      href={upiPayload}
                      className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-xs transition"
                    >
                      <Smartphone className="w-4 h-4" />
                      <span>{isHi ? 'सीधे UPI ऐप खोलें' : 'Open in UPI App (GPay/PhonePe)'}</span>
                      <ExternalLink className="w-3 h-3 opacity-80" />
                    </a>
                  )}
                </>
              ) : (
                <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-center space-y-1.5">
                  <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto">
                    <QrCode className="w-5 h-5" />
                  </div>
                  <h4 className="font-bold text-xs text-amber-950">
                    {isHi ? 'वितरक द्वारा UPI QR अभी सेट नहीं किया गया है' : 'Distributor UPI QR Not Configured'}
                  </h4>
                  <p className="text-[11px] text-amber-800">
                    {isHi ? 'कृपया सीधे वितरक से संपर्क करें या नकद भुगतान करें।' : 'Please contact your distributor directly or pay in cash.'}
                  </p>
                </div>
              )}

              {/* Reference / UTR Number confirmation form */}
              <form onSubmit={handleRecordSelfPayment} className="pt-2 border-t border-slate-100 space-y-2">
                <label className="block text-[11px] font-bold text-slate-700">
                  {isHi ? 'भुगतान के बाद 12-अंकीय UPI UTR / संदर्भ संख्या दर्ज करें:' : 'After payment, enter 12-digit UPI UTR / Ref No:'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={utrNumber}
                    onChange={(e) => setUtrNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="12-digit UTR (e.g. 427819283741)"
                    maxLength={12}
                    className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-xs font-mono font-bold focus:border-emerald-600 outline-hidden"
                  />
                  <button
                    type="submit"
                    disabled={isSubmitting || !utrNumber.trim()}
                    className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition disabled:opacity-50 whitespace-nowrap"
                  >
                    {isSubmitting ? '...' : (isHi ? 'पुष्टि करें' : 'Confirm')}
                  </button>
                </div>
                {errorMsg && <p className="text-[11px] font-bold text-red-600">{errorMsg}</p>}
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default UpiPaymentModal;