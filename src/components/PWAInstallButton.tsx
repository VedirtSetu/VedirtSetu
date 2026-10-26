import React, { useState } from 'react';
import { usePWAInstall } from './usePWAInstall.ts';
import { Language, translations } from '../utils/i18n.ts';
import { Download, Smartphone } from 'lucide-react';

export const PWAInstallButton: React.FC<{ compact?: boolean; lang?: Language }> = ({ compact, lang = 'hi' }) => {
  const t = translations[lang];
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className={`flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm transition active:scale-95 ${
          compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
        }`}
        title={t.installApp}
      >
        <Download className="w-3.5 h-3.5" />
        <span>{t.installApp}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className={`flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium shadow-sm transition ${
            compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
          }`}
          title={t.installIos}
        >
          <Smartphone className="w-3.5 h-3.5 text-slate-500" />
          <span>{t.installIos}</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-slate-900">{t.iosGuideTitle}</h3>
              <p className="mt-2 text-sm text-slate-600 space-y-2">
                <span>{t.iosStep1}</span>
                <br />
                <span>{t.iosStep2}</span>
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {t.gotIt}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
