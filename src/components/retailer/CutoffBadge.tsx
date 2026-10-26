import React, { useState, useEffect } from 'react';
import { Language } from '../../utils/i18n.ts';
import { Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { evaluateCutoff } from '../../utils/cutoff.ts';

interface CutoffBadgeProps {
  cutoffTime?: string; // e.g. "20:00"
  allowLate?: boolean;
  lang: Language;
}

export const CutoffBadge: React.FC<CutoffBadgeProps> = ({
  cutoffTime = '20:00',
  allowLate = true,
  lang,
}) => {
  const isHi = lang === 'hi';
  const [timeLeftStr, setTimeLeftStr] = useState<string>('');
  const [isPast, setIsPast] = useState<boolean>(false);
  const [isUrgent, setIsUrgent] = useState<boolean>(false);

  useEffect(() => {
    const updateCountdown = () => {
      const evalResult = evaluateCutoff(cutoffTime);
      setIsPast(evalResult.isPastCutoff);
      setIsUrgent(evalResult.isUrgent);

      if (evalResult.isPastCutoff) {
        setTimeLeftStr(
          isHi
            ? `कटऑफ समाप्त (${evalResult.cutoffTime}) • ${allowLate ? 'लेट ऑर्डर स्वीकार्य' : 'ऑर्डर बंद'}`
            : `Cutoff passed (${evalResult.cutoffTime}) • ${allowLate ? 'Late orders active' : 'Closed'}`
        );
      } else {
        if (evalResult.isUrgent) {
          setTimeLeftStr(
            isHi
              ? `⚠️ अंतिम ${evalResult.diffMinutes} मिनट शेष!`
              : `⚠️ Only ${evalResult.diffMinutes} mins left until cutoff!`
          );
        } else {
          setTimeLeftStr(
            isHi
              ? `आज के ऑर्डर हेतु ${evalResult.timeRemainingStrHi}`
              : `${evalResult.timeRemainingStrEn} until ${evalResult.cutoffTime} cutoff`
          );
        }
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 30000);
    return () => clearInterval(interval);
  }, [cutoffTime, allowLate, isHi]);

  if (isPast) {
    return (
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
        <span>{timeLeftStr}</span>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition ${
        isUrgent
          ? 'bg-rose-50 text-rose-800 border-rose-300 animate-pulse'
          : 'bg-emerald-50 text-emerald-800 border-emerald-300'
      }`}
    >
      <Clock className={`w-3.5 h-3.5 ${isUrgent ? 'text-rose-600' : 'text-emerald-600'} shrink-0`} />
      <span>{timeLeftStr}</span>
    </div>
  );
};

export default CutoffBadge;
