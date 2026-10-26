import React, { useState } from 'react';
import { User } from '../types/index.ts';
import { Language, translations } from '../utils/i18n.ts';
import { findUserInFirestore } from '../services/firebase.ts';
import { api, setStoredToken } from '../services/api.ts';
import { AppLogo } from './AppLogo.tsx';
import {
  ShieldCheck,
  Phone,
  KeyRound,
  ArrowRight,
  Eye,
  EyeOff,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

interface LoginModalProps {
  lang: Language;
  onSuccess: (user: User) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ lang, onSuccess }) => {
  const isHi = lang === 'hi';
  const t = translations[lang];

  // Login form state
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError(isHi ? 'कृपया अपना मोबाइल नंबर या आईडी दर्ज करें' : 'Please enter your mobile number or ID');
      return;
    }
    if (!pin.trim()) {
      setError(isHi ? 'कृपया अपना 4 या 6-अंकीय सुरक्षा पिन दर्ज करें' : 'Please enter your Security PIN');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const res = await api.login({
        identifier: identifier.trim(),
        pin: pin.trim(),
      });
      setStoredToken(res.token);
      onSuccess(res.user);
    } catch (err: any) {
      let displayError = '';
      if (typeof err === 'string' && err !== '[object Object]') {
        displayError = err;
      } else if (typeof err?.message === 'string' && err.message !== '[object Object]') {
        displayError = err.message;
      } else if (typeof err?.data?.error === 'string') {
        displayError = err.data.error;
      } else if (typeof err?.data?.error?.message === 'string') {
        displayError = err.data.error.message;
      } else if (typeof err?.data?.message === 'string') {
        displayError = err.data.message;
      } else if (typeof err?.error === 'string') {
        displayError = err.error;
      }

      if (!displayError || displayError === '[object Object]') {
        displayError = isHi
          ? 'लॉगिन विफल रहा। कृपया अपनी आईडी और सुरक्षा पिन की जांच करें।'
          : 'Login failed. Please verify your ID and Security PIN.';
      }

      setError(displayError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
        {/* Header Banner */}
        <div className="bg-gradient-to-br from-emerald-900 via-emerald-800 to-slate-900 text-white p-6 sm:p-7 text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />
          <div className="relative z-10 flex flex-col items-center">
            <AppLogo className="w-16 h-16 shadow-lg mb-3" variant="badge" />
            <h1 className="text-xl sm:text-2xl font-black tracking-tight flex items-center justify-center gap-2">
              <span>{isHi ? 'वेदिरतसेतु लॉगिन' : 'VedirtSetu Login'}</span>
            </h1>
            <p className="text-xs text-emerald-200/90 mt-1 max-w-xs font-medium">
              {isHi
                ? 'थोक वितरण व दैनिक ऑर्डर प्रबंधन प्रणाली'
                : 'B2B Wholesale & Daily Order Distribution Platform'}
            </p>
          </div>
        </div>

        {/* Security & Access Info Notice */}
        <div className="bg-emerald-50/70 border-b border-emerald-100 px-5 py-2.5 flex items-center gap-2 text-[11px] text-emerald-900 font-bold">
          <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>
            {isHi
              ? 'सुरक्षित पिन लॉगिन • केवल अधिकृत वितरक व दुकानदार'
              : 'Secure PIN Login • Authorized Distributors & Retailers Only'}
          </span>
        </div>

        {/* Main Login Form */}
        <div className="p-6 sm:p-7 space-y-5">
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">{error}</div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            {/* Field 1: Mobile Number or Login ID */}
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-wider mb-1.5">
                {isHi ? 'मोबाइल नंबर / लॉगिन आईडी' : 'Mobile Number / Login ID'} *
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Phone className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={isHi ? 'उदा. 9876543210 या ईमेल/कोड' : 'e.g. 9876543210 or email'}
                  autoFocus
                  required
                  className="w-full pl-10 pr-4 py-3 rounded-2xl border border-slate-200 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 text-sm font-bold text-slate-900 placeholder:text-slate-400 outline-hidden transition bg-slate-50/50"
                />
              </div>
            </div>

            {/* Field 2: Security PIN */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-black text-slate-700 uppercase tracking-wider">
                  {isHi ? 'सुरक्षा पिन (Security PIN)' : 'Security PIN'} *
                </label>
                <span className="text-[10px] text-slate-400 font-bold">
                  {isHi ? '4 या 6-अंकीय गुप्त पिन' : '4 or 6-digit Secret PIN'}
                </span>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  type={showPin ? 'text' : 'password'}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder={isHi ? 'पिन या पासवर्ड दर्ज करें' : 'Enter PIN or password'}
                  maxLength={50}
                  required
                  className="w-full pl-10 pr-12 py-3 rounded-2xl border border-slate-200 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 text-sm font-medium tracking-normal text-slate-900 placeholder:text-slate-400 outline-hidden transition bg-slate-50/50"
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition"
                  title={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-2xl bg-emerald-700 hover:bg-emerald-800 active:scale-98 text-white font-black text-sm shadow-lg shadow-emerald-700/25 flex items-center justify-center gap-2 transition disabled:opacity-50"
            >
              {loading ? (
                <span>{isHi ? 'सत्यापन हो रहा है...' : 'Verifying...'}</span>
              ) : (
                <>
                  <span>{isHi ? 'सुरक्षित लॉगिन करें' : 'Sign In'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Registration Notice */}
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600 space-y-1">
            <div className="flex items-center gap-1.5 font-black text-slate-800">
              <HelpCircle className="w-3.5 h-3.5 text-emerald-700" />
              <span>{isHi ? 'खाता एक्सेस सहायता' : 'Account Access Info'}</span>
            </div>
            <p className="text-slate-500 leading-relaxed">
              {isHi
                ? 'अधिकृत मुख्य एडमिन, वितरक एवं पंजीकृत दुकानदार अपने रजिस्टर्ड मोबाइल/ईमेल एवं सुरक्षा पिन या पासवर्ड द्वारा लॉगिन कर सकते हैं।'
                : 'Authorized Main Admin, Distributors, and Registered Shopkeepers can log in with their registered mobile/email and security PIN or password.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
