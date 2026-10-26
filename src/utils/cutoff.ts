/**
 * Cutoff Time & Delivery Cycle Engine for Dairy Distribution.
 * Correctly handles:
 * 1. Early morning / post-midnight cutoffs (e.g. 00:00, 00:30, 01:00, 02:00, 04:00) without inversion.
 * 2. Evening cutoffs (e.g. 18:00, 20:00, 21:30, 22:00, 23:59) without 00:00-06:00 rollover inversion.
 * 3. Next-day delivery cycle calculations and countdown timers.
 */

export interface ISTTimeInfo {
  dateStr: string;       // YYYY-MM-DD in Asia/Kolkata
  hours: number;         // 0 - 23
  minutes: number;       // 0 - 59
  totalMinutes: number;  // 0 - 1439
}

export function getISTTime(dateObj: Date = new Date()): ISTTimeInfo {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dateObj);

  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);

  return {
    dateStr: `${year}-${month}-${day}`,
    hours: hour,
    minutes: minute,
    totalMinutes: hour * 60 + minute,
  };
}

export interface CutoffEvaluation {
  isPastCutoff: boolean;
  cutoffTime: string;      // Normalized "HH:mm"
  diffMinutes: number;     // Positive if remaining, negative if past
  timeRemainingStrEn: string;
  timeRemainingStrHi: string;
  isUrgent: boolean;       // <= 60 minutes remaining
}

export function evaluateCutoff(cutoffTimeStr: string = '20:00', now: Date = new Date()): CutoffEvaluation {
  const cleanCutoff = String(cutoffTimeStr || '20:00').trim();
  const [hStr, mStr] = cleanCutoff.split(':');
  let cHour = parseInt(hStr, 10);
  let cMin = parseInt(mStr, 10);
  if (isNaN(cHour) || cHour < 0 || cHour > 23) cHour = 20;
  if (isNaN(cMin) || cMin < 0 || cMin > 59) cMin = 0;

  const normalizedCutoff = `${String(cHour).padStart(2, '0')}:${String(cMin).padStart(2, '0')}`;
  const ist = getISTTime(now);
  const curMinutes = ist.totalMinutes;

  let isPastCutoff = false;
  let diffMinutes = 0;

  if (cHour === 0 && cMin === 0) {
    // Midnight Cutoff ("00:00"):
    // During daytime/evening (06:00 to 23:59:59), ordering is active until midnight (24:00).
    // From 00:00 to 05:59, the midnight cutoff has passed for today's morning delivery.
    if (curMinutes >= 6 * 60) {
      diffMinutes = 1440 - curMinutes;
      isPastCutoff = false;
    } else {
      diffMinutes = -curMinutes;
      isPastCutoff = true;
    }
  } else if (cHour <= 6) {
    // Early Morning / Post-Midnight Cutoff (e.g. 00:30, 01:00, 02:00, 04:00):
    // Cutoff deadline is in the early morning at cHour:cMin.
    const cutoffMinutes = cHour * 60 + cMin;

    if (curMinutes >= 12 * 60) {
      // Afternoon / Evening (12:00 to 23:59):
      // Active ordering window for tomorrow morning's delivery with early morning cutoff.
      diffMinutes = (1440 - curMinutes) + cutoffMinutes;
      isPastCutoff = false;
    } else if (curMinutes < cutoffMinutes) {
      // Early morning before cutoff (00:00 to cutoffMinutes):
      diffMinutes = cutoffMinutes - curMinutes;
      isPastCutoff = false;
    } else {
      // Morning past cutoff (cutoffMinutes to 11:59):
      diffMinutes = cutoffMinutes - curMinutes;
      isPastCutoff = true;
    }
  } else {
    // Evening / Daytime Cutoff (e.g. 18:00, 20:00, 21:30, 23:00, 23:59):
    const cutoffMinutes = cHour * 60 + cMin;

    if (curMinutes < 6 * 60) {
      // Post-midnight early morning (00:00 to 05:59):
      // The evening cutoff for today's morning delivery passed yesterday evening!
      diffMinutes = -(curMinutes + (1440 - cutoffMinutes));
      isPastCutoff = true;
    } else if (curMinutes >= cutoffMinutes) {
      // Evening at or past cutoff:
      diffMinutes = cutoffMinutes - curMinutes;
      isPastCutoff = true;
    } else {
      // Daytime before cutoff (06:00 to cutoffMinutes - 1):
      diffMinutes = cutoffMinutes - curMinutes;
      isPastCutoff = false;
    }
  }

  const isUrgent = !isPastCutoff && diffMinutes <= 60 && diffMinutes > 0;

  let timeRemainingStrEn = '';
  let timeRemainingStrHi = '';

  if (!isPastCutoff && diffMinutes > 0) {
    const hrs = Math.floor(diffMinutes / 60);
    const mins = diffMinutes % 60;
    timeRemainingStrEn = hrs > 0 ? `${hrs}h ${mins}m remaining` : `${mins}m remaining`;
    timeRemainingStrHi = hrs > 0 ? `${hrs} घंटे ${mins} मिनट शेष` : `${mins} मिनट शेष`;
  }

  return {
    isPastCutoff,
    cutoffTime: normalizedCutoff,
    diffMinutes,
    timeRemainingStrEn,
    timeRemainingStrHi,
    isUrgent,
  };
}
