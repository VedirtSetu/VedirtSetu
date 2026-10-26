import React, { useState, useEffect } from 'react';
import {
  Bell,
  BellRing,
  CheckCircle2,
  AlertTriangle,
  Send,
  Smartphone,
  X,
  Volume2,
} from 'lucide-react';
import {
  getNotificationPermission,
  requestNotificationPermission,
  showBrowserNotification,
  isNotificationSupported,
  NotificationPermissionState,
} from '../../services/pushNotification.ts';
import { Language } from '../../utils/i18n.ts';

interface PushNotificationPromptProps {
  lang: Language;
  onPermissionChange?: (perm: NotificationPermissionState) => void;
}

export const PushNotificationPrompt: React.FC<PushNotificationPromptProps> = ({
  lang,
  onPermissionChange,
}) => {
  const isHi = lang === 'hi';
  const [permission, setPermission] = useState<NotificationPermissionState>('default');
  const [isRequesting, setIsRequesting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    const current = getNotificationPermission();
    setPermission(current);
    if (onPermissionChange) onPermissionChange(current);

    // Check if dismissed previously in session
    try {
      if (sessionStorage.getItem('vedirt_push_banner_dismissed') === '1') {
        setDismissed(true);
      }
    } catch {}
  }, []);

  const handleRequest = async () => {
    setIsRequesting(true);
    const newPerm = await requestNotificationPermission();
    setPermission(newPerm);
    setIsRequesting(false);
    if (onPermissionChange) onPermissionChange(newPerm);
  };

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem('vedirt_push_banner_dismissed', '1');
    } catch {}
  };

  const handleTestAlert = async () => {
    setTestSent(true);
    await showBrowserNotification(
      isHi ? '✅ टेस्ट अलर्ट: ऑर्डर स्वीकृत!' : '✅ Test Alert: Order Confirmed!',
      {
        body: isHi
          ? 'यह एक परीक्षण सूचना है। आपके ऑर्डर कन्फर्म या डिस्पैच होने पर ऐसा ही अलर्ट दिखेगा।'
          : 'This is a test notification. You will receive live alerts when your order is confirmed or dispatched.',
        tag: 'test-push-alert',
        vibrate: [200, 100, 200],
      }
    );
    setTimeout(() => setTestSent(false), 3000);
  };

  if (!isNotificationSupported() || dismissed) {
    return null;
  }

  // When already granted, display a minimal, reassuring pill with test trigger
  if (permission === 'granted') {
    return (
      <div className="p-3 bg-emerald-50/80 border border-emerald-200/90 rounded-2xl flex items-center justify-between gap-3 text-xs shadow-xs transition-all">
        <div className="flex items-center gap-2 text-emerald-900 font-bold">
          <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
            <BellRing className="w-3.5 h-3.5" />
          </div>
          <div>
            <span>{isHi ? 'पुश नोटिफिकेशन सक्रिय हैं' : 'Live Order Push Alerts Active'}</span>
            <span className="text-[10px] text-emerald-700 block font-normal">
              {isHi ? 'ऑर्डर कन्फर्म या रवाना होते ही स्क्रीन पर अलर्ट मिलेगा' : 'Instant alerts on order confirmation & dispatch'}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleTestAlert}
          className="px-2.5 py-1 rounded-lg bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100 font-bold text-[11px] flex items-center gap-1 transition shadow-2xs shrink-0"
        >
          {testSent ? (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              <span>{isHi ? 'अलर्ट भेजा गया!' : 'Alert Sent!'}</span>
            </>
          ) : (
            <>
              <Send className="w-3 h-3 text-emerald-600" />
              <span>{isHi ? 'टेस्ट अलर्ट' : 'Test Alert'}</span>
            </>
          )}
        </button>
      </div>
    );
  }

  // When denied by browser
  if (permission === 'denied') {
    return (
      <div className="p-3.5 bg-amber-50/90 border border-amber-200 rounded-2xl flex items-start justify-between gap-3 text-xs shadow-xs">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <div className="font-extrabold text-amber-950">
              {isHi ? 'ब्राउज़र में नोटिफिकेशन बंद हैं' : 'Push Notifications are Blocked'}
            </div>
            <p className="text-[11px] text-amber-800 mt-0.5">
              {isHi
                ? 'ऑर्डर कन्फर्म व डिलीवरी अलर्ट पाने के लिए ब्राउज़र के एड्रेस बार में लॉक (🔒) आइकन दबाकर "Notifications" को Allow करें।'
                : 'To receive dispatch alerts, tap the lock (🔒) icon in your browser address bar and allow Notifications.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-amber-800 hover:text-amber-950 p-1"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // Default state: Prompt retailer to enable push alerts
  return (
    <div className="p-4 rounded-3xl bg-gradient-to-r from-emerald-900 via-emerald-800 to-teal-900 text-white shadow-md relative overflow-hidden">
      {/* Background soft glow decorative elements */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />

      <div className="flex items-start justify-between gap-3 relative z-10">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shrink-0 shadow-inner">
            <BellRing className="w-5 h-5 text-emerald-300 animate-pulse" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="font-black text-sm sm:text-base text-white">
                {isHi ? 'ऑर्डर स्टेटस पुश नोटिफिकेशन चालू करें' : 'Enable Instant Order Push Alerts'}
              </h4>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-400/20 text-emerald-200 border border-emerald-400/30 uppercase tracking-wider">
                {isHi ? 'अलर्ट' : 'Live'}
              </span>
            </div>

            <p className="text-xs text-emerald-100/90 leading-relaxed max-w-md">
              {isHi
                ? 'वितरक द्वारा ऑर्डर स्वीकृत (Confirmed) या वाहन से रवाना (Dispatched) होते ही तुरंत अपने फोन या कंप्यूटर पर साउंड सहित अलर्ट पाएं।'
                : 'Get instant live sound & screen alerts the moment your order is confirmed or dispatched by the distributor.'}
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                onClick={handleRequest}
                disabled={isRequesting}
                className="px-4 py-2 rounded-xl bg-white text-emerald-900 hover:bg-emerald-50 font-black text-xs shadow-md active:scale-95 transition flex items-center gap-1.5"
              >
                <Bell className="w-3.5 h-3.5 text-emerald-700" />
                <span>{isRequesting ? (isHi ? 'अनुमति ली जा रही है...' : 'Requesting...') : (isHi ? 'नोटिफिकेशन चालू करें' : 'Enable Push Alerts')}</span>
              </button>

              <button
                type="button"
                onClick={handleDismiss}
                className="px-3 py-2 rounded-xl text-emerald-200 hover:text-white hover:bg-white/10 font-bold text-xs transition"
              >
                {isHi ? 'बाद में' : 'Maybe Later'}
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="text-emerald-300 hover:text-white p-1 rounded-lg"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
