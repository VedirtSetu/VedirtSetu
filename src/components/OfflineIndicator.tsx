import React, { useEffect, useState } from 'react';
import { Language, translations } from '../utils/i18n.ts';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC<{ lang?: Language }> = ({ lang = 'hi' }) => {
  const t = translations[lang];
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-bold text-white shadow-xl animate-in fade-in">
      <WifiOff className="w-4 h-4 animate-bounce" />
      <span>{t.offlineBanner}</span>
    </div>
  );
};
