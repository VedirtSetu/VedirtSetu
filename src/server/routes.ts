import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, execute, logAudit, notifyUser, saveToDisk, withTransaction, hashPin, decryptPin, verifyPin, getServerSecret } from './db.ts';
import {
  enqueueOutboxEvent,
  processOutboxEvents,
  getOutboxStats,
  getPendingOutboxEvents,
  retryFailedOutboxEvents,
} from './outbox.ts';
import { User, OrderStatus, CutoffStatus } from '../types/index.ts';
import { evaluateCutoff } from '../utils/cutoff.ts';
import { findUserInFirestore } from '../services/firebase.ts';

export const apiRouter = Router();

interface SessionRecord {
  user: User;
  createdAt: number;
  expiresAt: number;
}

// In-memory token session map with expiration tracking & bounded memory capacity
const tokenSessions = new Map<string, SessionRecord>();

// Session duration: 30 days maximum lifetime for wholesale ordering sessions
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Periodic cleanup of expired sessions from memory every 1 hour (capped at 10,000 entries)
function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of tokenSessions.entries()) {
    if (session.expiresAt <= now) {
      tokenSessions.delete(token);
    }
  }
  if (tokenSessions.size > 10000) {
    const keysToDelete = Array.from(tokenSessions.keys()).slice(0, 2000);
    keysToDelete.forEach(k => tokenSessions.delete(k));
  }
}
try {
  setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();
} catch (e) {}

// Helper to create cryptographically signed token with expiration
function getPinFingerprint(userId: number, passwordHash?: string): string {
  const rawHash =
    passwordHash ??
    queryOne<any>('SELECT password_hash FROM users WHERE id = ?', [userId])?.password_hash ??
    '';
  const plainPin = decryptPin(String(rawHash || ''));
  return crypto
    .createHmac('sha256', getServerSecret())
    .update(`pin_fp:${userId}:${plainPin}`)
    .digest('hex')
    .substring(0, 8);
}

function invalidateUserSessions(userId: number | undefined | null) {
  if (!userId) return;
  const targetId = Number(userId);
  for (const [tok, sess] of tokenSessions.entries()) {
    if (Number(sess.user?.id) === targetId) {
      tokenSessions.delete(tok);
    }
  }
}

function generateToken(user: User): string {
  const timestamp = Date.now();
  const secret = getServerSecret();
  const pinFp = getPinFingerprint(user.id, (user as any).password_hash);
  const payload = `${user.id}:${user.role}:${timestamp}:${pinFp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').substring(0, 16);
  const token = `doodh_${user.id}_${timestamp}_${sig}`;
  tokenSessions.set(token, {
    user,
    createdAt: timestamp,
    expiresAt: timestamp + SESSION_MAX_AGE_MS,
  });
  return token;
}

// Helper: Always compute current date & time in Indian Standard Time (IST / Asia/Kolkata)
function getISTDateStr(dateObj: Date = new Date()): string {
  return dateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Calendar-aware month addition preventing day overflow (e.g. 31st October + 1 month = 30th November, not 1st December)
export function addMonthsSafe(baseDateStr: string, months: number): string {
  const cleanStr = String(baseDateStr || getISTDateStr()).trim();
  const parts = cleanStr.split('-').map(Number);
  const year = parts[0] || new Date().getFullYear();
  const month = parts[1] || (new Date().getMonth() + 1);
  const day = parts[2] || new Date().getDate();

  let targetYear = year + Math.floor((month - 1 + months) / 12);
  let targetMonth = ((month - 1 + months) % 12) + 1;
  if (targetMonth <= 0) {
    targetMonth += 12;
    targetYear -= 1;
  }

  const daysInTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
  const targetDay = Math.min(day, daysInTargetMonth);

  const yStr = String(targetYear);
  const mStr = String(targetMonth).padStart(2, '0');
  const dStr = String(targetDay).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

function getISTCurrentMinutes(dateObj: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dateObj);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

// Helper: resolve active distributor ID for an admin user
function resolveAdminDistributorId(user: User, queryOrBodyDistId?: any): number | null {
  if (queryOrBodyDistId && queryOrBodyDistId !== 'all') {
    const parsed = parseInt(String(queryOrBodyDistId), 10);
    if (!isNaN(parsed) && user.role === 'superadmin') return parsed;
  }
  if (user.distributor_id) {
    const check = queryOne<any>(
      "SELECT id FROM distributors WHERE id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted'",
      [user.distributor_id]
    );
    if (check?.id) return check.id;
  }
  const dist = queryOne<any>(
    "SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1",
    [user.id, user.mobile]
  );
  return dist?.id || null;
}

// Authentication Middleware
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'अनधिकृत: कृपया पहले लॉगिन करें (Unauthorized: Please login)' });
  }

  const token = authHeader.split(' ')[1];
  const now = Date.now();
  const session = tokenSessions.get(token);
  let user: User | null = null;

  if (session) {
    if (session.expiresAt <= now) {
      tokenSessions.delete(token);
      return res.status(401).json({ error: 'सत्र समाप्त हो गया है, कृपया पुनः लॉगिन करें (Session expired, please login again)' });
    }
    user = session.user;
  }

  if (!user) {
    // Verify cryptographically signed token and load active user from DB
    if (token.startsWith('doodh_')) {
      const parts = token.split('_');
      if (parts.length >= 4) {
        const userId = parseInt(parts[1], 10);
        const tokenTimestamp = parseInt(parts[2], 10);
        const sig = parts[3];

        // 1. Verify token expiration (30 days maximum lifetime)
        const tokenAge = now - tokenTimestamp;
        if (isNaN(tokenAge) || tokenAge < 0 || tokenAge > SESSION_MAX_AGE_MS) {
          return res.status(401).json({ error: 'सत्र समाप्त हो गया है, कृपया पुनः लॉगिन करें (Session expired, please login again)' });
        }

        // 2. Load active user from database
        const dbUser = queryOne<any>(
          `SELECT u.id, u.name, u.mobile, u.email, u.role, u.password_hash, u.active_status, u.created_at,
                  s.id as shop_id, s.shop_name, s.shop_code,
                  COALESCE(s.distributor_id, d.id) as distributor_id,
                  d.business_name, d.subscription_status
           FROM users u
           LEFT JOIN shops s ON s.assigned_user_id = u.id AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0
           LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile) AND COALESCE(d.is_deleted, 0) = 0 AND d.subscription_status != 'deleted'
           WHERE u.id = ? AND u.active_status = 1
           ORDER BY d.id DESC, s.id DESC
           LIMIT 1`,
          [userId]
        );

        if (dbUser && sig) {
          const secret = getServerSecret();
          const pinFp = getPinFingerprint(dbUser.id, dbUser.password_hash);
          const expectedSig = crypto.createHmac('sha256', secret).update(`${dbUser.id}:${dbUser.role}:${parts[2]}:${pinFp}`).digest('hex').substring(0, 16);
          const sigBuf = Buffer.from(sig);
          const expectedSigBuf = Buffer.from(expectedSig);
          const isSigValid = sigBuf.length === expectedSigBuf.length && crypto.timingSafeEqual(sigBuf, expectedSigBuf);

          if (isSigValid) {
            if (dbUser.subscription_status === 'suspended' || dbUser.subscription_status === 'deleted') {
              return res.status(403).json({ error: 'यह खाता निलंबित कर दिया गया है (Account suspended)' });
            }
            tokenSessions.set(token, {
              user: dbUser,
              createdAt: tokenTimestamp,
              expiresAt: tokenTimestamp + SESSION_MAX_AGE_MS,
            });
            user = dbUser;
          }
        }
      }
    }
    if (!user) {
      return res.status(401).json({ error: 'अमान्य टोकन, कृपया पुनः लॉगिन करें (Invalid token, please login again)' });
    }
  } else {
    // Re-verify active status in SQLite so suspended/deleted accounts lose access immediately
    const liveCheck = queryOne<any>(
      `SELECT u.active_status, COALESCE(u.is_deleted, 0) as is_deleted,
              s.id as shop_id, s.distributor_id as shop_dist_id, COALESCE(s.is_deleted, 0) as shop_deleted,
              d.id as dist_id, d.subscription_status, COALESCE(d.is_deleted, 0) as dist_deleted
       FROM users u
       LEFT JOIN shops s ON s.assigned_user_id = u.id AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0
       LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile)
       WHERE u.id = ?
       ORDER BY d.id DESC, s.id DESC
       LIMIT 1`,
      [user.id]
    );
    if (!liveCheck || liveCheck.active_status !== 1 || liveCheck.is_deleted === 1 || liveCheck.dist_deleted === 1 || liveCheck.subscription_status === 'suspended' || liveCheck.subscription_status === 'deleted') {
      tokenSessions.delete(token);
      return res.status(403).json({ error: 'यह खाता हटा दिया गया है या निष्क्रिय है (Account deleted or deactivated)' });
    }
    if (liveCheck.shop_id && !user.shop_id) user.shop_id = liveCheck.shop_id;
    if ((liveCheck.shop_dist_id || liveCheck.dist_id) && !user.distributor_id) {
      user.distributor_id = liveCheck.shop_dist_id || liveCheck.dist_id;
    }
  }

  (req as any).user = user;
  next();
}

// Distributor & Super Admin middleware
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User;
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return res.status(403).json({ error: 'निषेध: केवल वितरक या सुपर एडमिन को यह अधिकार है (Forbidden: Distributor or Super Admin access only)' });
  }
  next();
}

// Super Admin platform owner only middleware
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User;
  if (!user || user.role !== 'superadmin') {
    return res.status(403).json({ error: 'निषेध: केवल कंपनी सुपर एडमिन को यह अधिकार है (Forbidden: Super Admin access only)' });
  }
  next();
}

// Helper: check cutoff status for today (supports per-distributor cutoff settings and IST clock)
function checkCutoffStatus(distId?: number | null, now: Date = new Date()): { isPastCutoff: boolean; cutoffTime: string; allowLate: boolean; diffMinutes: number } {
  const distCutoff = distId ? queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`cutoff_time_${distId}`]) : null;
  const distAllowLate = distId ? queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`allow_late_orders_${distId}`]) : null;
  const cutoffSetting = distCutoff || queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['cutoff_time']);
  const allowLateSetting = distAllowLate || queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['allow_late_orders']);

  const rawCutoff = cutoffSetting?.value || '20:00';
  const allowLate = allowLateSetting ? allowLateSetting.value === 'true' : true;

  const evaluation = evaluateCutoff(rawCutoff, now);
  return {
    isPastCutoff: evaluation.isPastCutoff,
    cutoffTime: evaluation.cutoffTime,
    allowLate,
    diffMinutes: evaluation.diffMinutes,
  };
}

// -------------------------------------------------------------
// 1. AUTHENTICATION ROUTES
// -------------------------------------------------------------

// In-memory OTP store: mobile -> { code: string, expiresAt: number, attempts: number }
// -------------------------------------------------------------
// 1. PIN-BASED AUTHENTICATION (NO PUBLIC REGISTRATION, NO OTP)
// -------------------------------------------------------------

// Failed login attempt tracking: identifier -> { attempts: number, lockUntil: number }
const loginAttemptMap = new Map<string, { attempts: number; lockUntil: number }>();

apiRouter.post('/auth/login', async (req, res) => {
  try {
    const { identifier, pin, password } = req.body;
    if (!identifier) {
      return res.status(400).json({ error: 'कृपया मोबाइल नंबर या आईडी दर्ज करें (Mobile number or ID required)' });
    }

    const cleanId = String(identifier).trim();
    const cleanDigits = cleanId.replace(/\D/g, '');
    const enteredPin = String(pin || password || '').trim();

    if (!enteredPin) {
      return res.status(400).json({ error: 'कृपया सुरक्षा पिन दर्ज करें (Security PIN required)' });
    }

    // Rate limiting: Anti-brute-force check (5 failed attempts locks for 15 minutes)
    const rateKey = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanId.toLowerCase();
    const attemptRecord = loginAttemptMap.get(rateKey);
    const nowMs = Date.now();
    if (attemptRecord && attemptRecord.lockUntil > nowMs) {
      const waitMins = Math.ceil((attemptRecord.lockUntil - nowMs) / 60000);
      return res.status(429).json({
        error: `अत्यधिक गलत पिन प्रयास (Too many failed attempts)। सुरक्षा कारणों से यह खाता ${waitMins} मिनट के लिए अस्थायी रूप से लॉक है। कृपया बाद में प्रयास करें।`
      });
    }

    // 10-digit mobile extraction
    const tenDigits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;

    // Check if logging in as platform admin
    const superadminMobile = process.env.SUPERADMIN_MOBILE || '8700320804';
    const superadminEmail = (process.env.SUPERADMIN_EMAIL || 'vedirt.india@gmail.com').toLowerCase();

    const isAdminIdentifier =
      (tenDigits && tenDigits === superadminMobile.slice(-10)) ||
      cleanId.toLowerCase() === 'admin' ||
      cleanId.toLowerCase() === 'superadmin' ||
      cleanId.toLowerCase() === superadminEmail ||
      cleanId.toLowerCase() === `${superadminMobile}@vedirtsetu.com`;

    // Look up user by mobile, clean digits, email, shop code, or admin keyword
    let user: any = null;
    if (isAdminIdentifier) {
      user = queryOne<any>(
        `SELECT u.id, u.name, u.mobile, u.email, u.role, u.password_hash, u.active_status, u.created_at,
                s.id as shop_id, s.shop_name, s.shop_code,
                COALESCE(s.distributor_id, d.id) as distributor_id,
                d.business_name, d.plan_name, d.subscription_status, d.max_shops
         FROM users u
         LEFT JOIN shops s ON s.assigned_user_id = u.id
         LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile)
         WHERE u.role = 'superadmin' OR u.mobile = ? OR u.email = ?
         ORDER BY (CASE WHEN u.role = 'superadmin' THEN 0 ELSE 1 END) ASC
         LIMIT 1`,
        [superadminMobile, superadminEmail]
      );
    }

    if (!user) {
      user = queryOne<any>(
        `SELECT u.id, u.name, u.mobile, u.email, u.role, u.password_hash, u.active_status, u.created_at,
                s.id as shop_id, s.shop_name, s.shop_code,
                COALESCE(s.distributor_id, d.id) as distributor_id,
                d.business_name, d.plan_name, d.subscription_status, d.max_shops
         FROM users u
         LEFT JOIN shops s ON s.assigned_user_id = u.id AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0
         LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile) AND COALESCE(d.is_deleted, 0) = 0 AND d.subscription_status != 'deleted'
         WHERE (u.mobile = ? OR u.mobile = ? OR u.mobile = ? OR u.email = ? OR s.shop_code = ?)
         ORDER BY u.active_status DESC, d.id DESC, s.id DESC
         LIMIT 1`,
        [cleanId, cleanDigits || cleanId, tenDigits || cleanId, cleanId, cleanId.toUpperCase()]
      );
    }

    // Cold-start fallback: If not in SQLite yet, verify directly from Firestore on the server (never trust client-supplied req.body.cloud_user)
    if (!user) {
      const cu = await findUserInFirestore(cleanId);
      const cuMob = String(cu?.mobile || '').replace(/\D/g, '');
      const cuMob10 = cuMob.slice(-10);
      if (
        cu &&
        cuMob &&
        (cuMob === cleanDigits || (tenDigits && cuMob10 === tenDigits) || String(cu.shop_code || '').toUpperCase() === cleanId.toUpperCase()) &&
        cu.active_status !== 0 &&
        cu.is_deleted !== 1 &&
        cu.subscription_status !== 'deleted'
      ) {
        const now = new Date().toISOString();
        const role = cu.role === 'admin' ? 'admin' : 'retailer';
        const targetPin = String(cu.password_hash || cu.login_pin || cu.pin || '1234').trim();

        const existingU = queryOne<any>('SELECT id, password_hash FROM users WHERE mobile = ?', [cuMob]);
        let userId = existingU?.id;
        if (!userId) {
          const uRes = execute(
            `INSERT INTO users (name, mobile, email, role, password_hash, active_status, is_demo, created_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
            [cu.name || cu.owner_name || cu.shop_name || cu.business_name || 'User', cuMob, cu.email || `${cuMob}@wholesale.com`, role, hashPin(targetPin), now]
          );
          userId = uRes.lastInsertRowid;
        } else if (cu.password_hash && existingU.password_hash !== hashPin(String(cu.password_hash))) {
          execute('UPDATE users SET password_hash = ?, active_status = 1 WHERE id = ?', [hashPin(String(cu.password_hash)), userId]);
        }

        if (role === 'admin') {
          const distExists = queryOne<any>('SELECT id FROM distributors WHERE mobile = ? OR user_id = ?', [cuMob, userId]);
          if (!distExists) {
            execute(
              `INSERT INTO distributors (user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, is_demo, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', '', 0, ?)`,
              [
                userId,
                cu.business_name || cu.name || 'Distributor',
                cu.owner_name || cu.name || 'Owner',
                cuMob,
                cu.email || `${cuMob}@wholesale.com`,
                cu.city || 'City',
                cu.address || '',
                cu.plan_name || 'Growth Pro',
                Number(cu.monthly_fee ?? 1999),
                cu.subscription_status || 'active',
                cu.subscription_start_date || getISTDateStr(),
                cu.subscription_renewal_date || getISTDateStr(new Date(Date.now() + 30 * 86400000)),
                Number(cu.max_shops || 100),
                now
              ]
            );
          }
        } else if (role === 'retailer') {
          const shopCode = cu.shop_code || `SH-${cuMob10.slice(-4)}`;
          const shopExists = queryOne<any>('SELECT id FROM shops WHERE shop_code = ? OR assigned_user_id = ?', [shopCode, userId]);
          const fallbackDistId =
            Number(cu.distributor_id) ||
            queryOne<any>('SELECT id FROM distributors WHERE COALESCE(is_deleted, 0) = 0 ORDER BY id ASC LIMIT 1')?.id ||
            1;
          if (!shopExists && fallbackDistId) {
            execute(
              `INSERT INTO shops (shop_code, shop_name, owner_name, mobile, address, area, route, assigned_user_id, distributor_id, active_status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
              [
                shopCode,
                cu.shop_name || cu.name || 'Shop',
                cu.owner_name || cu.name || 'Owner',
                cuMob,
                cu.address || '',
                cu.area || 'Main Area',
                cu.route || 'Route 1',
                userId,
                fallbackDistId,
                now
              ]
            );
          }
        }

        saveToDisk();

        user = queryOne<any>(
          `SELECT u.id, u.name, u.mobile, u.email, u.role, u.password_hash, u.active_status, u.created_at,
                  s.id as shop_id, s.shop_name, s.shop_code,
                  COALESCE(s.distributor_id, d.id) as distributor_id,
                  d.business_name, d.plan_name, d.subscription_status, d.max_shops
           FROM users u
           LEFT JOIN shops s ON s.assigned_user_id = u.id AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0
           LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile) AND COALESCE(d.is_deleted, 0) = 0 AND d.subscription_status != 'deleted'
           WHERE u.id = ?
           LIMIT 1`,
          [userId]
        );
      }
    }

    // If user does not exist in database, deny access
    if (!user) {
      return res.status(404).json({
        error: 'यह मोबाइल नंबर/आईडी पंजीकृत नहीं है। केवल एडमिन (वितरक हेतु) या वितरक (दुकानदार हेतु) ही नई आईडी बना सकते हैं।'
      });
    }

    // Check account status & soft delete
    if (user.active_status !== 1 || user.is_deleted === 1 || user.subscription_status === 'suspended' || user.subscription_status === 'deleted') {
      return res.status(403).json({
        error: 'यह खाता हटा दिया गया है या निष्क्रिय है। कृपया एडमिन से संपर्क करें। (Account is deleted or disabled. Please contact SuperAdmin.)'
      });
    }

    // Strict PIN Verification: Any wrong PIN will be rejected immediately
    const isValidPin = Boolean(
      user.password_hash && verifyPin(enteredPin, user.password_hash)
    );

    // Auto-migrate legacy unencrypted PIN to encrypted format on successful login
    if (isValidPin && user.password_hash && !String(user.password_hash).startsWith('enc:gcm:')) {
      execute('UPDATE users SET password_hash = ? WHERE id = ?', [hashPin(enteredPin), user.id]);
    }

    if (!isValidPin) {
      const currentAttempts = (attemptRecord && attemptRecord.lockUntil <= nowMs ? 0 : (attemptRecord?.attempts || 0)) + 1;
      const lockUntil = currentAttempts >= 5 ? nowMs + 15 * 60 * 1000 : 0;
      loginAttemptMap.set(rateKey, { attempts: currentAttempts, lockUntil });

      const remainingAttempts = Math.max(0, 5 - currentAttempts);
      const remainingMsg = remainingAttempts > 0 
        ? ` (${remainingAttempts} प्रयास शेष)`
        : ' (खाता 15 मिनट के लिए लॉक कर दिया गया है)';

      return res.status(401).json({
        error: `गलत सुरक्षा पिन (Incorrect Security PIN)। कृपया सही पिन दर्ज करें।${remainingMsg}`
      });
    }

    // Successful login: clear failed attempts
    loginAttemptMap.delete(rateKey);

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        shop_id: user.shop_id,
        shop_name: user.shop_name,
        shop_code: user.shop_code,
        distributor_id: user.distributor_id,
        business_name: user.business_name,
        plan_name: user.plan_name,
        subscription_status: user.subscription_status,
        max_shops: user.max_shops,
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'लॉगिन विफल (Login failed)' });
  }
});

// Deprecated OTP endpoint (returns informative message)
apiRouter.post('/auth/send-otp', (req, res) => {
  res.status(400).json({
    error: 'ओटीपी प्रमाणीकरण हटा दिया गया है। कृपया अपने मोबाइल नंबर और सुरक्षा पिन से सीधे लॉगिन करें।'
  });
});

// Demo accounts endpoint - disabled
apiRouter.get('/auth/demo-accounts', (req, res) => {
  res.json([]);
});

// Public self-registration is permanently disabled as per specifications
apiRouter.post('/auth/register-shop', (req, res) => {
  res.status(403).json({
    error: 'सार्वजनिक साइन-अप बंद है। केवल वितरक ही अपने पोर्टल से दुकानदारों की आईडी व सुरक्षा पिन बना सकते हैं।'
  });
});

// Change user password (especially for owner & distributor)
apiRouter.post('/auth/change-password', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 4) {
      return res.status(400).json({ error: 'नया पासवर्ड कम से कम 4 अक्षरों का होना चाहिए' });
    }
    const dbUser = queryOne<any>('SELECT password_hash, mobile, role FROM users WHERE id = ?', [user.id]);
    if (!dbUser || !verifyPin(current_password, dbUser.password_hash)) {
      return res.status(400).json({ error: 'वर्तमान पासवर्ड गलत है' });
    }
    const cleanNewPin = String(new_password).trim();
    const newEncryptedPin = hashPin(cleanNewPin);
    withTransaction(() => {
      execute('UPDATE users SET password_hash = ? WHERE id = ?', [newEncryptedPin, user.id]);
      if (user.role === 'admin') {
        const distRow = queryOne<any>('SELECT id, mobile FROM distributors WHERE user_id = ? OR mobile = ?', [user.id, dbUser.mobile]);
        if (distRow) {
          enqueueOutboxEvent('DISTRIBUTOR_UPDATED', 'distributor', distRow.id, {
            id: distRow.id,
            mobile: distRow.mobile,
            password_hash: newEncryptedPin,
          });
        }
      } else if (user.role === 'retailer') {
        const shopRow = queryOne<any>('SELECT id, shop_code, shop_name, mobile, distributor_id FROM shops WHERE assigned_user_id = ?', [user.id]);
        if (shopRow) {
          enqueueOutboxEvent('SHOP_UPDATED', 'shop', shopRow.shop_code, {
            id: shopRow.id,
            shop_code: shopRow.shop_code,
            shop_name: shopRow.shop_name,
            mobile: shopRow.mobile,
            distributor_id: shopRow.distributor_id,
            password_hash: newEncryptedPin,
          });
        }
      }
    });
    invalidateUserSessions(user.id);
    res.json({ success: true, message: 'पासवर्ड सफलतापूर्वक बदल दिया गया' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Current user profile
apiRouter.get('/auth/me', authenticate, (req, res) => {
  const user = (req as any).user;
  // Refresh shop & distributor details from database in case changed
  const freshUser = queryOne<any>(
    `SELECT u.id, u.name, u.mobile, u.email, u.role, u.active_status, u.created_at,
            s.id as shop_id, s.shop_name, s.shop_code,
            COALESCE(s.distributor_id, d.id) as distributor_id,
            d.business_name, d.plan_name, d.subscription_status, d.max_shops
     FROM users u
     LEFT JOIN shops s ON s.assigned_user_id = u.id AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0
     LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile) AND COALESCE(d.is_deleted, 0) = 0 AND d.subscription_status != 'deleted'
     WHERE u.id = ?
     ORDER BY d.id DESC, s.id DESC
     LIMIT 1`,
    [user.id]
  );
  if (freshUser && (freshUser.active_status !== 1 || freshUser.subscription_status === 'suspended' || freshUser.subscription_status === 'deleted')) {
    return res.status(403).json({ error: 'यह खाता निलंबित कर दिया गया है (Account suspended)' });
  }
  res.json(freshUser || user);
});

// -------------------------------------------------------------
// 2. PRODUCT ROUTES
// -------------------------------------------------------------

apiRouter.get('/products', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    
    // Determine distributor ID context
    let distId: number | null = null;
    if (user.role === 'admin') {
      const dist = queryOne<any>("SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id, user.mobile]);
      distId = user.distributor_id || dist?.id || null;
      if (!distId) return res.json([]); // STRICT: Distributor must only see their own products
    } else if (user.role === 'retailer') {
      if (user.shop_id) {
        const shop = queryOne<any>('SELECT distributor_id FROM shops WHERE id = ?', [user.shop_id]);
        distId = shop?.distributor_id || user.distributor_id || null;
      } else if (user.distributor_id) {
        distId = user.distributor_id;
      }
      if (!distId) {
        const fallbackShop = queryOne<any>('SELECT distributor_id FROM shops WHERE assigned_user_id = ? OR mobile = ?', [user.id, user.mobile]);
        distId = fallbackShop?.distributor_id || null;
      }
      if (!distId) return res.json([]);
    } else if (user.role === 'superadmin') {
      if (req.query.distributor_id && req.query.distributor_id !== 'all') {
        distId = parseInt(req.query.distributor_id as string, 10);
      }
    }

    let products: any[];
    if (distId != null) {
      products = query<any>(`
        SELECT id, distributor_id, name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order
        FROM products
        WHERE active_status = 1 AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_demo, 0) = 0 AND distributor_id = ?
        ORDER BY display_order ASC, id ASC
      `, [distId]);
    } else if (user.role === 'superadmin') {
      products = query<any>(`
        SELECT id, distributor_id, name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order
        FROM products
        WHERE active_status = 1 AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_demo, 0) = 0
        ORDER BY display_order ASC, id ASC
      `);
    } else {
      products = [];
    }

    // If shopkeeper, check custom price overrides
    if (user.role === 'retailer' && user.shop_id) {
      const overrides = query<any>(
        'SELECT product_id, custom_price FROM shop_prices WHERE shop_id = ?',
        [user.shop_id]
      );
      const overrideMap = new Map(overrides.map((o: any) => [o.product_id, o.custom_price]));
      
      const customized = products.map(p => ({
        ...p,
        price: overrideMap.has(p.id) ? overrideMap.get(p.id) : p.price,
        custom_price: overrideMap.has(p.id) ? overrideMap.get(p.id) : undefined
      }));
      return res.json(customized);
    }

    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distributor creates product
apiRouter.post('/products', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, display_order } = req.body;

    if (!name_english || !name_hindi || !category || !unit || price == null) {
      return res.status(400).json({ error: 'सभी आवश्यक विवरण भरें (All fields required)' });
    }

    const dist = queryOne<any>("SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id, user.mobile]);
    const distId = (user.role === 'superadmin' && req.body.distributor_id) ? Number(req.body.distributor_id) : (user.distributor_id || dist?.id || null);
    if (!distId) {
      return res.status(403).json({ error: 'वितरक खाता नहीं मिला। केवल अधिकृत वितरक ही उत्पाद जोड़ सकते हैं।' });
    }

    let lastInsertRowid = 0;
    withTransaction(() => {
      const res = execute(
        `INSERT INTO products (distributor_id, name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          distId,
          String(name_english).trim(),
          String(name_hindi).trim(),
          String(category).trim(),
          String(unit).trim(),
          parseFloat(price),
          minimum_quantity != null ? (parseInt(minimum_quantity, 10) || 0) : 0,
          stock_available ? 1 : 0,
          parseInt(display_order, 10) || 0
        ]
      );
      lastInsertRowid = res.lastInsertRowid;

      enqueueOutboxEvent('PRODUCT_CREATED', 'product', lastInsertRowid, {
        id: lastInsertRowid,
        distributor_id: distId,
        name_english: String(name_english).trim(),
        name_hindi: String(name_hindi).trim(),
        category: String(category).trim(),
        unit: String(unit).trim(),
        price: parseFloat(price),
        minimum_quantity: minimum_quantity != null ? (parseInt(minimum_quantity, 10) || 0) : 0,
        stock_available: stock_available ? 1 : 0,
        active_status: 1,
        display_order: parseInt(display_order, 10) || 0,
      });
    });

    logAudit(user.id, 'CREATE_PRODUCT', 'product', lastInsertRowid, undefined, JSON.stringify(req.body), 'Product created by distributor');
    res.status(201).json({ id: lastInsertRowid, distributor_id: distId, message: 'उत्पाद सफलतापूर्वक जोड़ा गया (Product added)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distributor updates product
apiRouter.put('/products/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order } = req.body;

    const oldProduct = queryOne<any>('SELECT * FROM products WHERE id = ?', [id]);
    if (!oldProduct) return res.status(404).json({ error: 'उत्पाद नहीं मिला' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || oldProduct.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक खाते के उत्पाद संशोधित कर सकते हैं' });
      }
    }

    withTransaction(() => {
      execute(
        `UPDATE products 
         SET name_english = ?, name_hindi = ?, category = ?, unit = ?, price = ?, minimum_quantity = ?, stock_available = ?, active_status = ?, display_order = ?
         WHERE id = ?`,
        [
          String(name_english).trim(),
          String(name_hindi).trim(),
          String(category).trim(),
          String(unit).trim(),
          parseFloat(price),
          minimum_quantity != null ? (parseInt(minimum_quantity, 10) || 0) : 0,
          stock_available ? 1 : 0,
          active_status ? 1 : 0,
          parseInt(display_order, 10) || 0,
          id
        ]
      );

      enqueueOutboxEvent('PRODUCT_UPDATED', 'product', id, {
        id,
        distributor_id: oldProduct.distributor_id,
        name_english: String(name_english).trim(),
        name_hindi: String(name_hindi).trim(),
        category: String(category).trim(),
        unit: String(unit).trim(),
        price: parseFloat(price),
        minimum_quantity: minimum_quantity != null ? (parseInt(minimum_quantity, 10) || 0) : 0,
        stock_available: stock_available ? 1 : 0,
        active_status: active_status ? 1 : 0,
        display_order: parseInt(display_order, 10) || 0,
      });
    });

    logAudit(user.id, 'UPDATE_PRODUCT', 'product', id, JSON.stringify(oldProduct), JSON.stringify(req.body), 'Product updated by distributor');
    res.json({ message: 'उत्पाद अद्यतन सफल (Product updated)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distributor deletes product
apiRouter.delete('/products/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const prod = queryOne<any>('SELECT * FROM products WHERE id = ?', [id]);
    if (!prod) return res.status(404).json({ error: 'उत्पाद नहीं मिला (Product not found)' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || prod.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक खाते के उत्पाद हटा सकते हैं' });
      }
    }

    withTransaction(() => {
      execute('DELETE FROM shop_prices WHERE product_id = ?', [id]);
      execute('DELETE FROM shop_regular_orders WHERE product_id = ?', [id]);

      // Soft-delete product so historical orders remain intact and cloud sync never resurrects it
      execute('UPDATE products SET active_status = 0 WHERE id = ?', [id]);
      try {
        execute('UPDATE products SET is_deleted = 1 WHERE id = ?', [id]);
      } catch (e) {}

      enqueueOutboxEvent('PRODUCT_DELETED', 'product', id, {
        id,
        distributor_id: prod.distributor_id,
      });
    });

    logAudit(user.id, 'DELETE_PRODUCT', 'product', id, JSON.stringify(prod), undefined, 'Product deleted by distributor');
    res.json({ message: 'उत्पाद सफलतापूर्वक हटाया गया (Product deleted)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Set shop-specific custom price
apiRouter.post('/products/:id/custom-price', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const productId = parseInt(req.params.id, 10);
    const { shop_id, custom_price } = req.body;

    if (!shop_id || custom_price == null) {
      return res.status(400).json({ error: 'shop_id और custom_price आवश्यक है' });
    }

    const prod = queryOne<any>('SELECT id, distributor_id FROM products WHERE id = ?', [productId]);
    const shop = queryOne<any>('SELECT id, distributor_id FROM shops WHERE id = ?', [shop_id]);
    if (!prod || !shop) {
      return res.status(404).json({ error: 'उत्पाद या दुकान नहीं मिली' });
    }

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || prod.distributor_id !== distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान और उत्पाद के लिए कस्टम मूल्य सेट कर सकते हैं' });
      }
    } else if (user.role === 'superadmin') {
      if (prod.distributor_id && shop.distributor_id && prod.distributor_id !== shop.distributor_id) {
        return res.status(400).json({ error: 'असंगत डेटा: उत्पाद और दुकान अलग-अलग वितरक के हैं' });
      }
    }

    if (custom_price <= 0) {
      execute('DELETE FROM shop_prices WHERE shop_id = ? AND product_id = ?', [shop_id, productId]);
    } else {
      execute(
        `INSERT INTO shop_prices (shop_id, product_id, custom_price) VALUES (?, ?, ?)
         ON CONFLICT(shop_id, product_id) DO UPDATE SET custom_price = excluded.custom_price`,
        [shop_id, productId, parseFloat(custom_price)]
      );
    }
    res.json({ message: 'कस्टम मूल्य सुरक्षित किया गया (Custom price saved)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 3. ORDER ROUTES
// -------------------------------------------------------------

// List orders (Distributor sees all, Shopkeeper sees only their own shop!)
apiRouter.get('/orders', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { date, status, route, area, shop_id, search, limit } = req.query;

    let sql = `
      SELECT o.id, o.order_number, o.shop_id, o.created_by, o.order_date, o.status,
             o.subtotal, o.total_amount, o.cutoff_status, o.notes, o.created_at, o.updated_at,
             o.confirmed_at, o.delivered_at,
             s.shop_name, s.shop_code, s.owner_name, s.mobile, s.route, s.area, s.distributor_id
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE 1=1
    `;
    const params: any[] = [];

    // CRITICAL RBAC ENFORCEMENT:
    if (user.role === 'retailer') {
      if (!user.shop_id) {
        return res.status(400).json({ error: 'दुकान नहीं मिली (No shop linked to this account)' });
      }
      sql += ' AND o.shop_id = ?';
      params.push(user.shop_id);
    } else if (user.role === 'admin') {
      let distId = user.distributor_id;
      if (!distId) {
        const dist = queryOne<any>("SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id, user.mobile]);
        distId = dist?.id || null;
      }
      if (distId) {
        sql += ' AND s.distributor_id = ?';
        params.push(distId);
      } else {
        return res.json([]);
      }
      if (shop_id) {
        sql += ' AND o.shop_id = ?';
        params.push(shop_id);
      }
    } else if (user.role === 'superadmin') {
      const qDistId = req.query.distributor_id ? parseInt(req.query.distributor_id as string, 10) : null;
      if (qDistId) {
        sql += ' AND s.distributor_id = ?';
        params.push(qDistId);
      }
      if (shop_id) {
        sql += ' AND o.shop_id = ?';
        params.push(shop_id);
      }
    }

    if (date) {
      sql += ' AND o.order_date = ?';
      params.push(date);
    }
    if (status) {
      sql += ' AND o.status = ?';
      params.push(status);
    }
    if (route) {
      sql += ' AND s.route = ?';
      params.push(route);
    }
    if (area) {
      sql += ' AND s.area = ?';
      params.push(area);
    }
    if (search) {
      sql += ' AND (s.shop_name LIKE ? OR s.shop_code LIKE ? OR s.mobile LIKE ? OR o.order_number LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    sql += ' ORDER BY o.order_date DESC, o.id DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit as string, 10));
    }

    const orders = query<any>(sql, params);

    // Fetch items for all returned orders in safe chunks of 200 (never drop items when > 50 orders)
    if (orders.length > 0) {
      const itemMap = new Map<number, any[]>();
      const orderIds = orders.map(o => o.id);
      const chunkSize = 200;
      for (let i = 0; i < orderIds.length; i += chunkSize) {
        const chunk = orderIds.slice(i, i + chunkSize);
        const items = query<any>(`
          SELECT oi.*, p.name_english, p.name_hindi, p.unit, p.category
          FROM order_items oi
          JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN (${chunk.join(',')})
        `);
        items.forEach(it => {
          if (!itemMap.has(it.order_id)) itemMap.set(it.order_id, []);
          itemMap.get(it.order_id)!.push(it);
        });
      }
      orders.forEach(o => {
        o.items = itemMap.get(o.id) || [];
      });
    }

    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Single order details with items
apiRouter.get('/orders/:id', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);

    const order = queryOne<any>(`
      SELECT o.id, o.order_number, o.shop_id, o.created_by, o.order_date, o.status,
             o.subtotal, o.total_amount, o.cutoff_status, o.notes, o.created_at, o.updated_at,
             o.confirmed_at, o.delivered_at,
             s.shop_name, s.shop_code, s.owner_name, s.mobile, s.route, s.area, s.address, s.distributor_id
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE o.id = ?
    `, [id]);

    if (!order) return res.status(404).json({ error: 'ऑर्डर नहीं मिला (Order not found)' });

    // RBAC: Retailer can ONLY view their own shop order; Distributor can ONLY view their own shops' orders
    if (user.role === 'retailer' && user.shop_id !== order.shop_id) {
      return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान का ऑर्डर देख सकते हैं (Forbidden: You can only view your own orders)' });
    }
    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || order.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क के ऑर्डर देख सकते हैं' });
      }
    }

    const items = query<any>(`
      SELECT oi.*, p.name_english, p.name_hindi, p.unit, p.category
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `, [id]);

    order.items = items;
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new order (Shopkeeper or Distributor on behalf of shop)
apiRouter.post('/orders', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { shop_id, items, notes, order_date } = req.body;

    const targetShopId = user.role === 'retailer' ? user.shop_id : parseInt(shop_id, 10);
    if (!targetShopId) {
      return res.status(400).json({ error: 'दुकान की पहचान आवश्यक है (Valid shop required)' });
    }

    // Verify shop is active
    const shop = queryOne<any>('SELECT * FROM shops WHERE id = ? AND active_status = 1', [targetShopId]);
    if (!shop) {
      return res.status(400).json({ error: 'दुकान निष्क्रिय है या मौजूद नहीं है (Shop inactive or not found)' });
    }

    // Verify parent distributor subscription status (Issue 1)
    if (shop.distributor_id) {
      const distRow = queryOne<any>(
        'SELECT id, business_name, subscription_status, is_deleted FROM distributors WHERE id = ?',
        [shop.distributor_id]
      );
      if (distRow) {
        if (distRow.subscription_status === 'suspended' || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) {
          return res.status(403).json({
            error: 'वितरक खाता निलंबित या निष्क्रिय है। कृपया अपने वितरक से संपर्क करें। (Distributor account is suspended/inactive)'
          });
        }
        if (distRow.subscription_status === 'expired') {
          return res.status(403).json({
            error: 'वितरक का प्लेटफॉर्म सब्सक्रिप्शन समाप्त (Expired) हो चुका है। ऑर्डर सेवा पुनः शुरू करने के लिए वितरक को रिन्यू करने हेतु कहें। (Distributor subscription expired)'
          });
        }
      }
    }

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान के लिए ऑर्डर बना सकते हैं' });
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'ऑर्डर में कम से कम एक उत्पाद होना चाहिए (At least one product required)' });
    }

    const todayStr = getISTDateStr();
    const tomorrowStr = getISTDateStr(new Date(Date.now() + 86400000));
    const targetDate = order_date || todayStr;

    // Validate allowed dates for retailers (prevent backdating and arbitrarily distant future dates)
    if (user.role === 'retailer') {
      if (targetDate < todayStr) {
        return res.status(400).json({
          error: 'पिछली तिथि के लिए नया ऑर्डर नहीं दिया जा सकता (Cannot place order for past dates)'
        });
      }
      if (targetDate > tomorrowStr) {
        return res.status(400).json({
          error: 'ऑर्डर केवल आज या कल के लिए ही दिया जा सकता है (Orders can only be placed for today or tomorrow)'
        });
      }
    }

    // Check cutoff rules for this shop's distributor
    const { isPastCutoff, cutoffTime, allowLate } = checkCutoffStatus(shop.distributor_id);
    let cutoff_status: CutoffStatus = 'on_time';

    if (user.role === 'retailer') {
      if (isPastCutoff) {
        if (!allowLate) {
          const dateLabelHi = targetDate === tomorrowStr ? 'कल' : 'आज';
          const dateLabelEn = targetDate === tomorrowStr ? 'next-day' : 'today';
          return res.status(400).json({
            error: `${dateLabelHi} के लिए ऑर्डर समय समाप्त हो चुका है। अंतिम समय सीमा ${cutoffTime} थी। (Order cutoff time was ${cutoffTime} for ${dateLabelEn} orders)`
          });
        }
        cutoff_status = 'late';
      }
    } else if (user.role === 'admin' || user.role === 'superadmin') {
      cutoff_status = 'exempt';
    }

    // Prevent duplicate submission check for the same date if already has a non-cancelled order
    const existingOrder = queryOne<any>(
      'SELECT id, status FROM orders WHERE shop_id = ? AND order_date = ? AND status != "Cancelled"',
      [targetShopId, targetDate]
    );

    if (existingOrder && user.role === 'retailer') {
      return res.status(400).json({
        error: `${targetDate} का ऑर्डर पहले से जमा है (#${existingOrder.id})। आप इसे अपडेट या संपादित कर सकते हैं। (Order already exists for this date. Please edit it.)`,
        existingOrderId: existingOrder.id
      });
    }

    // Filter valid positive items
    const validItems = items.filter((it: any) => parseInt(it.quantity, 10) > 0);
    if (validItems.length === 0) {
      return res.status(400).json({ error: 'मात्रा 0 से अधिक होनी चाहिए (Quantity must be greater than 0)' });
    }

    // Calculate prices & totals
    // Get shop specific price overrides if any
    const customPrices = query<any>('SELECT product_id, custom_price FROM shop_prices WHERE shop_id = ?', [targetShopId]);
    const customPriceMap = new Map(customPrices.map((c: any) => [c.product_id, c.custom_price]));

    const cleanProductIds = validItems.map((it: any) => parseInt(it.product_id, 10)).filter((n: number) => !isNaN(n) && n > 0);
    if (cleanProductIds.length === 0) {
      return res.status(400).json({ error: 'अमान्य उत्पाद (Invalid products)' });
    }
    const placeholders = cleanProductIds.map(() => '?').join(',');
    const dbProducts = query<any>(
      `SELECT id, distributor_id, name_english, name_hindi, price, active_status, stock_available, minimum_quantity 
       FROM products 
       WHERE id IN (${placeholders}) AND distributor_id = ?`,
      [...cleanProductIds, shop.distributor_id]
    );
    const prodMap = new Map(dbProducts.map((p: any) => [p.id, p]));

    let calculatedTotal = 0;
    const finalItemsToInsert: any[] = [];

    for (const it of validItems) {
      const prod = prodMap.get(it.product_id);
      if (!prod || prod.active_status !== 1) {
        return res.status(400).json({ error: `उत्पाद #${it.product_id} उपलब्ध नहीं है` });
      }
      if (!prod.stock_available) {
        return res.status(400).json({ error: `उत्पाद "${prod.name_hindi || prod.name_english}" अभी आउट ऑफ स्टॉक (Out of Stock) है` });
      }
      const qty = parseInt(it.quantity, 10);
      if (qty <= 0 || isNaN(qty)) {
        return res.status(400).json({ error: 'उत्पाद की मात्रा कम से कम 1 होनी चाहिए' });
      }
      const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;
      if (user.role === 'retailer' && qty < minQty) {
        return res.status(400).json({
          error: `"${prod.name_hindi || prod.name_english}" के लिए न्यूनतम ऑर्डर मात्रा (MOQ) कम से कम ${minQty} है`
        });
      }

      const unitPrice = customPriceMap.has(prod.id) ? customPriceMap.get(prod.id) : prod.price;
      const lineTotal = Math.round(unitPrice * qty * 100) / 100;
      calculatedTotal += lineTotal;

      finalItemsToInsert.push({
        product_id: prod.id,
        ordered_quantity: qty,
        delivered_quantity: 0,
        unit_price: unitPrice,
        line_total: lineTotal
      });
    }

    const now = new Date().toISOString();
    const orderNumber = `ORD-${targetDate.replace(/-/g, '')}-${shop.shop_code || targetShopId}-${Math.floor(100 + Math.random() * 900)}`;

    let orderId = 0;
    withTransaction(() => {
      const res = execute(
        `INSERT INTO orders (order_number, shop_id, created_by, order_date, status, subtotal, total_amount, cutoff_status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          targetShopId,
          user.id,
          targetDate,
          calculatedTotal,
          calculatedTotal,
          cutoff_status,
          notes || '',
          now,
          now
        ]
      );
      orderId = res.lastInsertRowid;

      if (!orderId) {
        const row = queryOne<any>('SELECT id FROM orders WHERE order_number = ?', [orderNumber]);
        if (row) orderId = row.id;
      }

      for (const item of finalItemsToInsert) {
        execute(
          `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [orderId, item.product_id, item.ordered_quantity, item.delivered_quantity, item.unit_price, item.line_total]
        );
      }

      // Atomically enqueue Outbox event to guarantee consistent Firestore cloud persistence
      enqueueOutboxEvent('ORDER_CREATED', 'order', orderNumber, {
        id: orderId,
        order_number: orderNumber,
        shop_id: targetShopId,
        shop_name: shop.shop_name,
        shop_code: shop.shop_code,
        distributor_id: shop.distributor_id,
        items: finalItemsToInsert.map(it => {
          const p = prodMap.get(it.product_id);
          return {
            product_id: it.product_id,
            name: p?.name_hindi || p?.name_english || '',
            quantity: it.ordered_quantity,
            delivered_quantity: 0,
            unit: p?.unit || 'Ltr',
            unit_price: it.unit_price,
            line_total: it.line_total,
          };
        }),
        total_amount: calculatedTotal,
        cutoff_status,
        order_date: targetDate,
        notes: notes || '',
        status: 'Pending',
      });
    });

    logAudit(user.id, 'CREATE_ORDER', 'order', orderId, undefined, JSON.stringify({ total: calculatedTotal, itemsCount: finalItemsToInsert.length, cutoff_status }), 'Order placed');

    // Notify only the shop's own distributor (never leak notification to an unrelated distributor)
    let distUser = null;
    if (shop.distributor_id) {
      const distRow = queryOne<any>('SELECT user_id, mobile FROM distributors WHERE id = ?', [shop.distributor_id]);
      if (distRow?.user_id) {
        distUser = queryOne<any>('SELECT id FROM users WHERE id = ?', [distRow.user_id]);
      } else if (distRow?.mobile) {
        distUser = queryOne<any>('SELECT id FROM users WHERE mobile = ?', [distRow.mobile]);
      }
    }
    if (distUser) {
      notifyUser(
        distUser.id,
        `नया ऑर्डर: ${shop.shop_name}`,
        `${shop.shop_name} ने ${targetDate} के लिए ₹${calculatedTotal} का ऑर्डर दिया है (${cutoff_status === 'late' ? 'विलंबित / Late' : 'समय पर'})।`
      );
    }

    // Notify shopkeeper
    notifyUser(
      shop.assigned_user_id,
      'ऑर्डर प्राप्त हुआ',
      `आपका ऑर्डर ${orderNumber} (₹${calculatedTotal}) सफलतापूर्वक दर्ज हो गया है। स्थिति: लंबित`
    );

    res.status(201).json({
      id: orderId,
      order_number: orderNumber,
      shop_id: targetShopId,
      shop_name: shop.shop_name,
      distributor_id: shop.distributor_id,
      order_date: targetDate,
      total_amount: calculatedTotal,
      cutoff_status,
      items: finalItemsToInsert,
      message: cutoff_status === 'late' 
        ? 'ऑर्डर समय सीमा के बाद प्राप्त हुआ और विलंबित (Late) के रूप में दर्ज किया गया।' 
        : 'ऑर्डर सफलतापूर्वक दर्ज हो गया है!'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Edit order (Shopkeeper before cutoff or Distributor anytime with audit)
apiRouter.put('/orders/:id', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { items, notes, reason } = req.body;

    const order = queryOne<any>(
      `SELECT o.*, s.distributor_id, s.assigned_user_id, s.shop_name
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       WHERE o.id = ?`,
      [id]
    );
    if (!order) return res.status(404).json({ error: 'ऑर्डर नहीं मिला' });

    // RBAC: Retailer can only edit if their shop and Pending and before cutoff; Distributor only their own shop's order
    if (user.role === 'retailer') {
      if (order.shop_id !== user.shop_id) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपना ऑर्डर संपादित कर सकते हैं' });
      }
      if (order.status !== 'Pending') {
        return res.status(400).json({ error: `ऑर्डर की वर्तमान स्थिति '${order.status}' है। इसे अब बदला नहीं जा सकता।` });
      }
      if (String(order.order_date || '') < getISTDateStr()) {
        return res.status(400).json({
          error: 'पिछली तिथि के ऑर्डर में अब परिवर्तन नहीं किया जा सकता। कृपया वितरक से संपर्क करें। (Cannot modify past-date orders)'
        });
      }
      const { isPastCutoff, allowLate, cutoffTime } = checkCutoffStatus(order.distributor_id);
      if (isPastCutoff && !allowLate) {
        return res.status(400).json({
          error: `ऑर्डर कटऑफ समय (${cutoffTime}) के बाद परिवर्तन की अनुमति नहीं है। कृपया वितरक से संपर्क करें। (Order modification closed after cutoff)`
        });
      }
    } else if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || order.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क के ऑर्डर संपादित कर सकते हैं' });
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'कम से कम एक उत्पाद आवश्यक है' });
    }

    const validItems = items.filter((it: any) => parseInt(it.quantity || it.ordered_quantity, 10) > 0);
    if (validItems.length === 0) {
      return res.status(400).json({ error: 'मात्रा 0 से अधिक होनी चाहिए' });
    }

    const customPrices = query<any>('SELECT product_id, custom_price FROM shop_prices WHERE shop_id = ?', [order.shop_id]);
    const customPriceMap = new Map(customPrices.map((c: any) => [c.product_id, c.custom_price]));

    const cleanProductIds = validItems.map((it: any) => parseInt(it.product_id, 10)).filter((n: number) => !isNaN(n) && n > 0);
    if (cleanProductIds.length === 0) {
      return res.status(400).json({ error: 'अमान्य उत्पाद (Invalid products)' });
    }
    const placeholders = cleanProductIds.map(() => '?').join(',');
    const dbProducts = query<any>(
      `SELECT id, distributor_id, name_english, name_hindi, price, stock_available, minimum_quantity 
       FROM products 
       WHERE id IN (${placeholders}) AND distributor_id = ?`,
      [...cleanProductIds, order.distributor_id]
    );
    const prodMap = new Map(dbProducts.map((p: any) => [p.id, p]));

    // Query existing order items to preserve previously recorded delivered quantities if not explicitly provided
    const existingItems = query<any>('SELECT product_id, ordered_quantity, delivered_quantity, line_total FROM order_items WHERE order_id = ?', [id]);
    const existingItemMap = new Map(existingItems.map((e: any) => [e.product_id, e]));

    if (order.status === 'Cancelled') {
      return res.status(400).json({ error: 'रद्द किया गया ऑर्डर (Cancelled) अब बदला नहीं जा सकता।' });
    }

    // Check if the order is already Partially Delivered or Delivered (or updated as such)
    const targetStatus = (req.body.status && ['Pending', 'Confirmed', 'Packed', 'Partially Delivered', 'Delivered', 'Cancelled'].includes(req.body.status))
      ? req.body.status
      : order.status;

    const statusRank: Record<string, number> = {
      'Pending': 1,
      'Confirmed': 2,
      'Packed': 3,
      'Partially Delivered': 4,
      'Delivered': 5,
    };
    if (order.status === 'Delivered' && targetStatus !== 'Delivered') {
      return res.status(400).json({
        error: `सफलतापूर्वक डिलीवर हो चुके ऑर्डर ('Delivered') की स्थिति को वापस '${targetStatus}' में नहीं बदला जा सकता।`
      });
    }
    if (
      targetStatus !== 'Cancelled' &&
      statusRank[order.status] &&
      statusRank[targetStatus] &&
      statusRank[targetStatus] < statusRank[order.status]
    ) {
      return res.status(400).json({
        error: `ऑर्डर की स्थिति को '${order.status}' से वापस '${targetStatus}' में नहीं बदला जा सकता। (Invalid backward status transition)`
      });
    }

    const isDeliveredOrPartial = targetStatus === 'Partially Delivered' || targetStatus === 'Delivered';

    let calculatedTotal = 0;
    const finalItems: any[] = [];

    for (const it of validItems) {
      const prod = prodMap.get(it.product_id);
      if (!prod) continue;
      if (user.role === 'retailer' && !prod.stock_available) {
        return res.status(400).json({ error: `उत्पाद "${prod.name_hindi || prod.name_english}" अभी आउट ऑफ स्टॉक (Out of Stock) है` });
      }
      const qty = parseInt(it.quantity || it.ordered_quantity, 10);
      const minQty = prod.minimum_quantity && prod.minimum_quantity > 1 ? prod.minimum_quantity : 1;
      if (user.role === 'retailer' && qty < minQty) {
        return res.status(400).json({
          error: `"${prod.name_hindi || prod.name_english}" के लिए न्यूनतम ऑर्डर मात्रा (MOQ) कम से कम ${minQty} है`
        });
      }

      const existing = existingItemMap.get(prod.id);
      let deliveredQty = 0;
      if (it.delivered_quantity != null) {
        deliveredQty = Math.max(0, parseInt(it.delivered_quantity, 10) || 0);
      } else if (existing && existing.delivered_quantity != null) {
        deliveredQty = existing.delivered_quantity;
      } else if (targetStatus === 'Delivered') {
        deliveredQty = qty;
      }

      const unitPrice = customPriceMap.has(prod.id) ? customPriceMap.get(prod.id) : prod.price;
      const billQty = isDeliveredOrPartial ? deliveredQty : qty;
      const lineTotal = Math.round(unitPrice * billQty * 100) / 100;
      calculatedTotal += lineTotal;

      finalItems.push({
        product_id: prod.id,
        ordered_quantity: qty,
        delivered_quantity: deliveredQty,
        unit_price: unitPrice,
        line_total: lineTotal
      });
    }

    const now = new Date().toISOString();

    let confirmed_at = order.confirmed_at;
    let delivered_at = order.delivered_at;
    if (targetStatus === 'Confirmed' && !confirmed_at) confirmed_at = now;
    if (targetStatus === 'Delivered' || targetStatus === 'Partially Delivered') delivered_at = now;

    const { isPastCutoff } = checkCutoffStatus(order.distributor_id);
    let newCutoffStatus: CutoffStatus = order.cutoff_status || 'on_time';
    if (user.role === 'retailer' && isPastCutoff && order.cutoff_status === 'on_time') {
      newCutoffStatus = 'late';
    }

    withTransaction(() => {
      // Replace order items
      execute('DELETE FROM order_items WHERE order_id = ?', [id]);
      for (const it of finalItems) {
        execute(
          `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, it.product_id, it.ordered_quantity, it.delivered_quantity, it.unit_price, it.line_total]
        );
      }

      execute(
        `UPDATE orders 
         SET status = ?, subtotal = ?, total_amount = ?, cutoff_status = ?, notes = ?, confirmed_at = ?, delivered_at = ?, updated_at = ?
         WHERE id = ?`,
        [targetStatus, calculatedTotal, calculatedTotal, newCutoffStatus, notes != null ? notes : order.notes, confirmed_at, delivered_at, now, id]
      );

      // Atomically enqueue Outbox event for cloud synchronization
      enqueueOutboxEvent('ORDER_UPDATED', 'order', order.order_number, {
        id,
        order_number: order.order_number,
        shop_id: order.shop_id,
        distributor_id: order.distributor_id,
        order_date: order.order_date,
        status: targetStatus,
        cutoff_status: newCutoffStatus,
        total_amount: calculatedTotal,
        notes: notes != null ? notes : order.notes,
        items: finalItems,
        confirmed_at,
        delivered_at,
      });
    });

    logAudit(
      user.id,
      'EDIT_ORDER',
      'order',
      id,
      `₹${order.total_amount} (${order.status})`,
      `₹${calculatedTotal} (${targetStatus})`,
      reason || (user.role === 'admin' ? `Order updated by distributor (status: ${targetStatus})` : 'Edited by retailer')
    );

    // If status changed by distributor, notify shopkeeper in the same transaction flow
    if (user.role === 'admin' && targetStatus !== order.status && order.assigned_user_id) {
      const statusTitles: Record<string, string> = {
        'Pending': `⏳ ऑर्डर स्थिति: #${order.order_number}`,
        'Confirmed': `✅ ऑर्डर स्वीकृत! #${order.order_number}`,
        'Packed': `🚚 ऑर्डर तैयार व रवाना! #${order.order_number}`,
        'Partially Delivered': `📦 आंशिक डिलीवरी: #${order.order_number}`,
        'Delivered': `🎉 डिलीवरी पूर्ण! #${order.order_number}`,
        'Cancelled': `❌ ऑर्डर रद्द: #${order.order_number}`,
      };
      notifyUser(
        order.assigned_user_id,
        statusTitles[targetStatus] || `ऑर्डर स्थिति: ${targetStatus}`,
        `वितरक द्वारा आपके ऑर्डर #${order.order_number} की स्थिति '${targetStatus}' कर दी गई है। कुल बिल राशि: ₹${calculatedTotal}।`
      );
    }

    res.json({
      message: 'ऑर्डर सफलतापूर्वक अद्यतन हुआ',
      total_amount: calculatedTotal,
      order_id: id,
      order_number: order.order_number,
      status: targetStatus,
      order: {
        id,
        order_number: order.order_number,
        shop_id: order.shop_id,
        distributor_id: order.distributor_id,
        order_date: order.order_date,
        status: targetStatus,
        total_amount: calculatedTotal,
        items: finalItems,
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel order (Shopkeeper can cancel before confirmation; Distributor can cancel anytime)
apiRouter.post('/orders/:id/cancel', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;

    const order = queryOne<any>(
      `SELECT o.*, s.distributor_id, s.shop_name, s.shop_code, s.assigned_user_id
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       WHERE o.id = ?`,
      [id]
    );
    if (!order) return res.status(404).json({ error: 'ऑर्डर नहीं मिला' });

    if (user.role === 'retailer') {
      if (order.shop_id !== user.shop_id) {
        return res.status(403).json({ error: 'निषेध: केवल अपना ऑर्डर रद्द कर सकते हैं' });
      }
      if (order.status !== 'Pending') {
        return res.status(400).json({ error: `ऑर्डर '${order.status}' स्थिति में है और इसे रद्द नहीं किया जा सकता।` });
      }
      if (String(order.order_date || '') < getISTDateStr()) {
        return res.status(400).json({
          error: 'पिछली तिथि के ऑर्डर को अब रद्द नहीं किया जा सकता। कृपया वितरक से संपर्क करें। (Cannot cancel past-date orders)'
        });
      }
      const { isPastCutoff, allowLate, cutoffTime } = checkCutoffStatus(order.distributor_id);
      if (isPastCutoff && !allowLate) {
        return res.status(400).json({
          error: `ऑर्डर कटऑफ समय (${cutoffTime}) के बाद रद्द करने की अनुमति नहीं है। कृपया वितरक से संपर्क करें। (Order cancellation closed after cutoff)`
        });
      }
    } else if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || order.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क के ऑर्डर रद्द कर सकते हैं' });
      }
    }

    if (order.status === 'Delivered' || order.status === 'Cancelled') {
      return res.status(400).json({
        error: `ऑर्डर पहले से '${order.status}' स्थिति में है और इसे अब रद्द नहीं किया जा सकता।`
      });
    }

    const now = new Date().toISOString();
    withTransaction(() => {
      execute('UPDATE orders SET status = "Cancelled", updated_at = ? WHERE id = ?', [now, id]);
      enqueueOutboxEvent('ORDER_CANCELLED', 'order', order.order_number, {
        id,
        order_number: order.order_number,
        status: 'Cancelled',
        notes: reason || 'Order cancelled',
      });
    });

    logAudit(user.id, 'CANCEL_ORDER', 'order', id, order.status, 'Cancelled', reason || 'Order cancelled');

    // Notify both parties of order cancellation
    let distUser = null;
    if (order.distributor_id) {
      const distRow = queryOne<any>('SELECT user_id, mobile FROM distributors WHERE id = ?', [order.distributor_id]);
      if (distRow?.user_id) {
        distUser = queryOne<any>('SELECT id FROM users WHERE id = ?', [distRow.user_id]);
      } else if (distRow?.mobile) {
        distUser = queryOne<any>('SELECT id FROM users WHERE mobile = ?', [distRow.mobile]);
      }
    }

    const cancelReason = reason ? String(reason).trim() : '';
    const reasonText = cancelReason ? ` कारण: ${cancelReason}` : '';

    if (user.role === 'retailer') {
      // Retailer cancelled: Notify distributor immediately so morning packing/dispatch is updated
      if (distUser) {
        notifyUser(
          distUser.id,
          `ऑर्डर रद्द: ${order.shop_name || 'दुकानदार'}`,
          `${order.shop_name || 'दुकानदार'} ने ऑर्डर #${order.order_number} (₹${order.total_amount}) रद्द कर दिया है।${reasonText}`
        );
      }
      if (order.assigned_user_id) {
        notifyUser(
          order.assigned_user_id,
          'ऑर्डर रद्द हो गया',
          `आपका ऑर्डर #${order.order_number} सफलतापूर्वक रद्द कर दिया गया है।`
        );
      }
    } else {
      // Distributor/Admin cancelled: Notify retailer immediately so they are informed
      if (order.assigned_user_id) {
        notifyUser(
          order.assigned_user_id,
          'ऑर्डर रद्द कर दिया गया (Order Cancelled)',
          `वितरक द्वारा आपका ऑर्डर #${order.order_number} रद्द कर दिया गया है।${reasonText}`
        );
      }
      if (distUser && distUser.id !== user.id) {
        notifyUser(
          distUser.id,
          'ऑर्डर रद्द',
          `ऑर्डर #${order.order_number} (${order.shop_name}) रद्द कर दिया गया है।${reasonText}`
        );
      }
    }

    res.json({
      message: 'ऑर्डर सफलतापूर्वक रद्द कर दिया गया',
      order_id: id,
      order_number: order.order_number,
      status: 'Cancelled',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update order status (Distributor: Confirm, Pack, Partially Deliver, Deliver, Cancel)
apiRouter.post('/orders/:id/status', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { status, items, reason } = req.body as { status: OrderStatus; items?: any[]; reason?: string };

    const validStatuses: OrderStatus[] = ['Pending', 'Confirmed', 'Packed', 'Partially Delivered', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'अमान्य स्थिति (Invalid status)' });
    }

    const distId = resolveAdminDistributorId(user, req.query.distributor_id);

    let orderQuery = `
      SELECT o.*, s.assigned_user_id, s.shop_name, s.distributor_id 
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE o.id = ?
    `;
    const orderParams: any[] = [id];
    if (user.role === 'admin') {
      if (!distId) return res.status(403).json({ error: 'वितरक खाता नहीं मिला' });
      orderQuery += ' AND s.distributor_id = ?';
      orderParams.push(distId);
    }
    const order = queryOne<any>(orderQuery, orderParams);
    if (!order) return res.status(404).json({ error: 'ऑर्डर नहीं मिला' });

    if (order.status === 'Cancelled' && status !== 'Cancelled') {
      return res.status(400).json({
        error: 'रद्द किए गए ऑर्डर (Cancelled) की स्थिति को वापस नहीं बदला जा सकता।'
      });
    }
    if (order.status === 'Delivered' && status !== 'Delivered') {
      return res.status(400).json({
        error: `सफलतापूर्वक डिलीवर हो चुके ऑर्डर ('Delivered') की स्थिति को वापस '${status}' में नहीं बदला जा सकता।`
      });
    }

    const statusRank: Record<string, number> = {
      'Pending': 1,
      'Confirmed': 2,
      'Packed': 3,
      'Partially Delivered': 4,
      'Delivered': 5,
    };
    if (
      status !== 'Cancelled' &&
      statusRank[order.status] &&
      statusRank[status] &&
      statusRank[status] < statusRank[order.status]
    ) {
      return res.status(400).json({
        error: `ऑर्डर की स्थिति को '${order.status}' से वापस '${status}' में नहीं बदला जा सकता। (Invalid backward status transition)`
      });
    }

    const now = new Date().toISOString();
    let confirmed_at = order.confirmed_at;
    let delivered_at = order.delivered_at;

    if (status === 'Confirmed' && !confirmed_at) confirmed_at = now;
    if (status === 'Delivered' || status === 'Partially Delivered') delivered_at = now;

    let updatedTotal = order.total_amount;
    withTransaction(() => {
      // If items with delivered quantities provided, update delivered_quantity and recalculate line_total when Partially Delivered / Delivered
      if (Array.isArray(items) && items.length > 0) {
        for (const it of items) {
          if (it.product_id && it.delivered_quantity != null) {
            const delivQty = Math.max(0, parseInt(it.delivered_quantity, 10) || 0);
            if (status === 'Partially Delivered' || status === 'Delivered') {
              execute(
                'UPDATE order_items SET delivered_quantity = ?, line_total = ROUND(unit_price * ?, 2) WHERE order_id = ? AND product_id = ?',
                [delivQty, delivQty, id, it.product_id]
              );
            } else {
              execute(
                'UPDATE order_items SET delivered_quantity = ? WHERE order_id = ? AND product_id = ?',
                [delivQty, id, it.product_id]
              );
            }
          }
        }
      } else if (status === 'Delivered') {
        // Auto set delivered_quantity = ordered_quantity if marked full delivered without custom item quantities
        execute('UPDATE order_items SET delivered_quantity = ordered_quantity, line_total = ROUND(unit_price * ordered_quantity, 2) WHERE order_id = ?', [id]);
      }

      // Recalculate order subtotal & total_amount from order_items so Khata / Ledger bills the exact delivered amount
      const sumRow = queryOne<any>('SELECT COALESCE(SUM(line_total), 0) as new_total FROM order_items WHERE order_id = ?', [id]);
      updatedTotal = sumRow && sumRow.new_total != null ? Math.round(Number(sumRow.new_total) * 100) / 100 : order.total_amount;

      execute(
        `UPDATE orders 
         SET status = ?, subtotal = ?, total_amount = ?, confirmed_at = ?, delivered_at = ?, updated_at = ?
         WHERE id = ?`,
        [status, updatedTotal, updatedTotal, confirmed_at, delivered_at, now, id]
      );

      enqueueOutboxEvent('ORDER_STATUS_CHANGED', 'order', order.order_number, {
        id,
        order_number: order.order_number,
        status,
        total_amount: updatedTotal,
        confirmed_at,
        delivered_at,
        notes: reason || undefined,
        delivered_items: items || undefined,
      });
    });

    logAudit(user.id, 'CHANGE_ORDER_STATUS', 'order', id, order.status, status, reason || `Status set to ${status}`);

    // Notify shopkeeper with rich status alert
    const statusTitles: Record<OrderStatus, string> = {
      'Pending': `⏳ ऑर्डर लंबित: #${order.order_number}`,
      'Confirmed': `✅ ऑर्डर स्वीकृत! #${order.order_number}`,
      'Packed': `🚚 ऑर्डर तैयार व रवाना! #${order.order_number}`,
      'Partially Delivered': `📦 आंशिक डिलीवरी: #${order.order_number}`,
      'Delivered': `🎉 ऑर्डर डिलीवर हो गया! #${order.order_number}`,
      'Cancelled': `⚠️ ऑर्डर रद्द हुआ: #${order.order_number}`
    };

    const statusBodies: Record<OrderStatus, string> = {
      'Pending': `दुकान "${order.shop_name}": आपका ऑर्डर #${order.order_number} दर्ज हो चुका है।`,
      'Confirmed': `दुकान "${order.shop_name}": वितरक ने आपका ऑर्डर स्वीकृत कर लिया है। समय पर डिलीवरी होगी।`,
      'Packed': `दुकान "${order.shop_name}": आपका ऑर्डर पैक होकर डिलीवरी वाहन में लोड हो चुका है। जल्द पहुंचेगा।`,
      'Partially Delivered': `दुकान "${order.shop_name}": ऑर्डर सामग्री डिलीवर हो गई है। कुल बिल राशि: ₹${updatedTotal}।`,
      'Delivered': `दुकान "${order.shop_name}": ऑर्डर सफलतापूर्वक डिलीवर हो चुका है। कुल राशि: ₹${updatedTotal}।`,
      'Cancelled': `दुकान "${order.shop_name}": ऑर्डर #${order.order_number} रद्द कर दिया गया है।`
    };

    notifyUser(
      order.assigned_user_id,
      statusTitles[status] || `ऑर्डर स्थिति: ${status}`,
      statusBodies[status] || `आपके ऑर्डर #${order.order_number} की स्थिति अब '${status}' है।`
    );

    res.json({
      message: `स्थिति '${status}' में परिवर्तित की गई`,
      status,
      order_id: id,
      order_number: order.order_number,
      total_amount: updatedTotal,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 1-Tap Repeat Last Order (or regular saved defaults)
apiRouter.post('/orders/repeat-last', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    if (user.role !== 'retailer' || !user.shop_id) {
      return res.status(403).json({ error: 'केवल दुकानदार यह कर सकते हैं' });
    }

    const shop = queryOne<any>('SELECT distributor_id FROM shops WHERE id = ?', [user.shop_id]);
    const distId = shop?.distributor_id || user.distributor_id;
    if (distId) {
      const distRow = queryOne<any>(
        'SELECT id, business_name, subscription_status, is_deleted FROM distributors WHERE id = ?',
        [distId]
      );
      if (distRow) {
        if (distRow.subscription_status === 'suspended' || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) {
          return res.status(403).json({
            error: 'वितरक खाता निलंबित या निष्क्रिय है। कृपया अपने वितरक से संपर्क करें।'
          });
        }
        if (distRow.subscription_status === 'expired') {
          return res.status(403).json({
            error: 'वितरक का प्लेटफॉर्म सब्सक्रिप्शन समाप्त (Expired) हो चुका है। ऑर्डर सेवा पुनः शुरू करने के लिए वितरक को रिन्यू करने हेतु कहें।'
          });
        }
      }
    }

    // Try finding the last non-cancelled order
    const lastOrder = queryOne<any>(
      'SELECT id FROM orders WHERE shop_id = ? AND status != "Cancelled" ORDER BY id DESC LIMIT 1',
      [user.shop_id]
    );

    let itemsToRepeat: { product_id: number; quantity: number }[] = [];

    if (lastOrder) {
      // Join with active in-stock products of this distributor
      const items = query<any>(
        "SELECT oi.product_id, oi.ordered_quantity as quantity, p.minimum_quantity " +
        "FROM order_items oi " +
        "JOIN products p ON p.id = oi.product_id " +
        "WHERE oi.order_id = ? " +
        "  AND p.active_status = 1 " +
        "  AND p.stock_available = 1 " +
        "  AND COALESCE(p.is_deleted, 0) = 0 " +
        "  AND (p.distributor_id = ? OR p.distributor_id IS NULL)",
        [lastOrder.id, distId]
      );
      itemsToRepeat = items.map((i) => {
        const minQty = i.minimum_quantity && i.minimum_quantity > 1 ? i.minimum_quantity : 1;
        const finalQty = Math.max(minQty, parseInt(i.quantity, 10) || minQty);
        return { product_id: i.product_id, quantity: finalQty };
      });
    } else {
      // Fallback to regular saved order defaults
      const defaults = query<any>(
        "SELECT ro.product_id, ro.quantity, p.minimum_quantity " +
        "FROM shop_regular_orders ro " +
        "JOIN products p ON p.id = ro.product_id " +
        "WHERE ro.shop_id = ? " +
        "  AND p.active_status = 1 " +
        "  AND p.stock_available = 1 " +
        "  AND COALESCE(p.is_deleted, 0) = 0 " +
        "  AND (p.distributor_id = ? OR p.distributor_id IS NULL)",
        [user.shop_id, distId]
      );
      itemsToRepeat = defaults.map((d) => {
        const minQty = d.minimum_quantity && d.minimum_quantity > 1 ? d.minimum_quantity : 1;
        const finalQty = Math.max(minQty, parseInt(d.quantity, 10) || minQty);
        return { product_id: d.product_id, quantity: finalQty };
      });
    }

    if (itemsToRepeat.length === 0) {
      return res.status(404).json({
        error: 'पिछले ऑर्डर का कोई भी उत्पाद वर्तमान में स्टॉक में उपलब्ध नहीं है। कृपया नई सूची से ऑर्डर करें।'
      });
    }

    res.json({ items: itemsToRepeat });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Save Regular / Default quantities for a shop
apiRouter.post('/orders/save-regular', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const shopId = user.role === 'retailer' ? user.shop_id : (req.body.shop_id || (req.body.defaults ? req.body.defaults[0]?.shop_id : null));
    const itemsList = req.body.items || req.body.defaults || [];

    if (!shopId) return res.status(400).json({ error: 'दुकान आवश्यक है' });
    if (!Array.isArray(itemsList)) return res.status(400).json({ error: 'सामग्री सूची आवश्यक है' });

    const shop = queryOne<any>('SELECT id, distributor_id FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ error: 'दुकान नहीं मिली' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क की दुकान का नियमित ऑर्डर सेट कर सकते हैं' });
      }
    }

    const items = itemsList;
    execute('DELETE FROM shop_regular_orders WHERE shop_id = ?', [shopId]);
    for (const it of items) {
      const qty = parseInt(it.quantity, 10);
      const pId = parseInt(it.product_id, 10);
      if (qty > 0 && !isNaN(pId)) {
        const pCheck = queryOne<any>('SELECT id FROM products WHERE id = ? AND distributor_id = ? AND active_status = 1', [pId, shop.distributor_id]);
        if (pCheck || user.role === 'superadmin') {
          execute(
            'INSERT INTO shop_regular_orders (shop_id, product_id, quantity) VALUES (?, ?, ?)',
            [shopId, pId, qty]
          );
        }
      }
    }
    res.json({ message: 'नियमित ऑर्डर सेटिंग्स सुरक्षित की गईं (Regular order saved)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get regular default order for shop
apiRouter.get('/orders/regular-defaults', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const shopId = user.role === 'retailer' ? user.shop_id : parseInt(req.query.shop_id as string, 10);
    if (!shopId) return res.json([]);

    const shop = queryOne<any>('SELECT id, distributor_id FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ error: 'दुकान नहीं मिली' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क की दुकान का नियमित ऑर्डर देख सकते हैं' });
      }
    }

    const defaults = query<any>(
      `SELECT sro.product_id, sro.quantity, p.name_english, p.name_hindi, p.unit, p.price
       FROM shop_regular_orders sro
       JOIN products p ON p.id = sro.product_id
       WHERE sro.shop_id = ?`,
      [shopId]
    );
    res.json(defaults);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 4. CONSOLIDATED DEMAND (DISTRIBUTOR ONLY)
// -------------------------------------------------------------

apiRouter.get('/demand', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const todayStr = getISTDateStr();
    const date = (req.query.date as string) || todayStr;
    const route = req.query.route as string | undefined;

    let distId: number | null = null;
    if (user.role === 'superadmin' && req.query.distributor_id && req.query.distributor_id !== 'all') {
      distId = parseInt(req.query.distributor_id as string, 10);
    } else if (user.role === 'admin') {
      distId = resolveAdminDistributorId(user);
      if (!distId) {
        return res.status(403).json({ error: 'वितरक खाता नहीं मिला (Distributor account not found)' });
      }
    }

    // Get products strictly belonging to this distributor
    let prodSql = 'SELECT id, name_english, name_hindi, category, unit, price, display_order FROM products WHERE active_status = 1';
    const prodParams: any[] = [];
    if (distId) {
      prodSql += ' AND distributor_id = ?';
      prodParams.push(distId);
    }
    prodSql += ' ORDER BY display_order ASC, id ASC';
    const products = query<any>(prodSql, prodParams);

    // Aggregate demand strictly for this distributor's shops (with optional route filter)
    let aggSql = `
      SELECT oi.product_id,
             SUM(oi.ordered_quantity) as total_ordered,
             SUM(oi.delivered_quantity) as total_delivered,
             COUNT(DISTINCT o.shop_id) as shops_count,
             SUM(oi.line_total) as total_amount
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops s ON s.id = o.shop_id
      WHERE o.order_date = ? AND o.status != 'Cancelled'
    `;
    const aggParams: any[] = [date];
    if (distId) {
      aggSql += ' AND s.distributor_id = ?';
      aggParams.push(distId);
    }
    if (route && route !== 'all') {
      aggSql += ' AND s.route = ?';
      aggParams.push(route);
    }
    aggSql += ' GROUP BY oi.product_id';
    const demandAgg = query<any>(aggSql, aggParams);

    const aggMap = new Map(demandAgg.map((a: any) => [a.product_id, a]));

    let overallOrderedUnits = 0;
    let overallDeliveredUnits = 0;
    let overallPendingUnits = 0;
    let overallAmount = 0;

    const consolidated = products.map(p => {
      const agg = aggMap.get(p.id) || { total_ordered: 0, total_delivered: 0, shops_count: 0, total_amount: 0 };
      const ordered = Number(agg.total_ordered || 0);
      const delivered = Number(agg.total_delivered || 0);
      const pending = Math.max(0, ordered - delivered);
      const amount = Number(agg.total_amount || 0);

      overallOrderedUnits += ordered;
      overallDeliveredUnits += delivered;
      overallPendingUnits += pending;
      overallAmount += amount;

      return {
        product_id: p.id,
        name_english: p.name_english,
        name_hindi: p.name_hindi,
        category: p.category,
        unit: p.unit,
        price: p.price,
        total_ordered: ordered,
        total_delivered: delivered,
        pending_quantity: pending,
        shops_count: Number(agg.shops_count || 0),
        total_amount: amount
      };
    });

    // Total distinct shops ordering on this date strictly for this distributor
    let distinctShopsSql = `
      SELECT COUNT(DISTINCT o.shop_id) as total_shops
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE o.order_date = ? AND o.status != 'Cancelled'
    `;
    const distinctParams: any[] = [date];
    if (distId) {
      distinctShopsSql += ' AND s.distributor_id = ?';
      distinctParams.push(distId);
    }
    if (route && route !== 'all') {
      distinctShopsSql += ' AND s.route = ?';
      distinctParams.push(route);
    }
    const distinctShops = queryOne<any>(distinctShopsSql, distinctParams);

    res.json({
      date,
      summary: {
        total_shops_ordered: distinctShops?.total_shops || 0,
        overall_ordered_units: overallOrderedUnits,
        overall_delivered_units: overallDeliveredUnits,
        overall_pending_units: overallPendingUnits,
        overall_amount: Math.round(overallAmount * 100) / 100
      },
      items: consolidated
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 5. SHOPS & LEDGER ROUTES
// -------------------------------------------------------------

apiRouter.get('/shops/next-code', authenticate, (req, res) => {
  try {
    const rows = query<any>(
      'SELECT shop_code FROM shops WHERE active_status = 1 AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_demo, 0) = 0'
    );
    let maxNum = 100;
    rows.forEach((r) => {
      if (r.shop_code) {
        const baseCode = String(r.shop_code).replace(/_DEL_.*$/i, '');
        const match = baseCode.match(/\d+/g);
        if (match) {
          match.forEach((m) => {
            const num = parseInt(m, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          });
        }
      }
    });
    const nextNum = maxNum + 1;
    res.json({ next_code: `SH-${nextNum}`, next_number: nextNum });
  } catch (error: any) {
    res.json({ next_code: 'SH-101', next_number: 101 });
  }
});

apiRouter.get('/shops', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const todayStr = getISTDateStr();

    if (user.role === 'retailer') {
      // Return single shop details
      const shop = queryOne<any>(`
        SELECT s.*, u.name as user_name, u.email as user_email
        FROM shops s
        JOIN users u ON u.id = s.assigned_user_id
        WHERE s.id = ?
      `, [user.shop_id]);
      return res.json(shop ? [shop] : []);
    }

    // Determine target distributor ID strictly
    let distId: number | null = null;
    if (user.role === 'admin') {
      distId = user.distributor_id || null;
      if (!distId) {
        const dist = queryOne<any>("SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id, user.mobile]);
        distId = dist?.id || null;
      }
    } else if (user.role === 'superadmin') {
      if (req.query.distributor_id && req.query.distributor_id !== 'all') {
        distId = parseInt(req.query.distributor_id as string, 10);
      }
    }

    // STRICT MULTI-TENANCY: A distributor must ONLY see their own shops
    if (user.role === 'admin' && !distId) {
      return res.json([]);
    }

    let sql = `
      SELECT s.*, u.name as user_name, u.email as user_email, u.password_hash as login_pin,
             (SELECT status FROM orders WHERE shop_id = s.id AND order_date = ? AND status != 'Cancelled' LIMIT 1) as today_order_status,
             (SELECT id FROM orders WHERE shop_id = s.id AND order_date = ? AND status != 'Cancelled' LIMIT 1) as today_order_id,
             (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE shop_id = s.id AND status NOT IN ('Pending', 'Cancelled')) as total_billed,
             (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE shop_id = s.id AND (status = 'approved' OR status IS NULL OR status = '')) as total_paid
      FROM shops s
      JOIN users u ON u.id = s.assigned_user_id
    `;
    const params: any[] = [todayStr, todayStr];
    if (distId) {
      sql += ' WHERE s.distributor_id = ? AND s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0 AND COALESCE(s.is_demo, 0) = 0';
      params.push(distId);
    } else if (user.role === 'superadmin') {
      sql += ' WHERE s.active_status = 1 AND COALESCE(s.is_deleted, 0) = 0 AND COALESCE(s.is_demo, 0) = 0';
    } else {
      return res.json([]);
    }
    sql += ' ORDER BY s.route ASC, s.shop_code ASC';

    const shops = query<any>(sql, params);

    const formatted = shops.map(s => ({
      ...s,
      login_pin: decryptPin(s.login_pin),
      outstanding_balance: Math.round(((s.total_billed || 0) - (s.total_paid || 0)) * 100) / 100,
      today_order_status: s.today_order_status || 'Not Ordered'
    }));

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Add new shop and user with custom PIN (Robust and user-friendly)
apiRouter.post('/shops', authenticate, requireAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const { shop_code, shop_name, owner_name, mobile, address, area, route, pin, password } = req.body;

    if (!shop_name || !owner_name || !mobile || !area || !route) {
      return res.status(400).json({ error: 'सभी आवश्यक विवरण (दुकान का नाम, स्वामी, मोबाइल, क्षेत्र, रूट) भरें' });
    }

    const now = new Date().toISOString();
    const cleanMobile = String(mobile).trim().replace(/\D/g, '');
    if (cleanMobile.length < 10) {
      return res.status(400).json({ error: 'कृपया वैध 10-अंकीय मोबाइल नंबर दर्ज करें' });
    }

    // Determine current distributor id strictly - NEVER default to 1!
    const distId = resolveAdminDistributorId(adminUser, req.body.distributor_id);
    if (!distId) {
      return res.status(403).json({ error: 'वितरक खाता नहीं मिला। केवल अधिकृत वितरक ही दुकान जोड़ सकते हैं।' });
    }

    // Enforce distributor subscription status and max_shops plan limit
    const distRecord = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [distId]);
    if (distRecord && adminUser.role !== 'superadmin') {
      if (distRecord.subscription_status === 'suspended' || distRecord.subscription_status === 'expired' || distRecord.subscription_status === 'deleted') {
        return res.status(403).json({
          error: 'आपका वितरक सब्सक्रिप्शन प्लान समाप्त या निलंबित है। नई दुकान जोड़ने के लिए कृपया अपना प्लान रिन्यू करें।'
        });
      }
      const activeShopsCountRow = queryOne<any>(
        'SELECT COUNT(*) as count FROM shops WHERE distributor_id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0',
        [distId]
      );
      const currentShopCount = activeShopsCountRow?.count || 0;
      const maxAllowed = distRecord.max_shops || 30;
      if (currentShopCount >= maxAllowed) {
        return res.status(400).json({
          error: `आपके वर्तमान प्लान (${distRecord.plan_name || 'Starter'}) में अधिकतम ${maxAllowed} सक्रिय दुकानों की सीमा है। अधिक दुकानें जोड़ने के लिए कृपया अपना प्लान अपग्रेड करें।`
        });
      }
    }

    // Determine or clean shop code
    let cleanCode = String(shop_code || '').trim().toUpperCase();
    if (!cleanCode) {
      const rows = query<any>(
        'SELECT shop_code FROM shops WHERE active_status = 1 AND COALESCE(is_deleted, 0) = 0 AND COALESCE(is_demo, 0) = 0'
      );
      let maxNum = 100;
      rows.forEach((r) => {
        if (r.shop_code) {
          const baseCode = String(r.shop_code).replace(/_DEL_.*$/i, '');
          const match = baseCode.match(/\d+/g);
          if (match) {
            match.forEach((m) => {
              const num = parseInt(m, 10);
              if (!isNaN(num) && num > maxNum) maxNum = num;
            });
          }
        }
      });
      cleanCode = `SH-${maxNum + 1}`;
    }

    // Check if shop_code already exists on an ACTIVE shop
    const existingCode = queryOne<any>(
      'SELECT id, shop_name, active_status, is_deleted FROM shops WHERE UPPER(shop_code) = ?',
      [cleanCode]
    );
    if (existingCode) {
      if (existingCode.active_status === 1 && !existingCode.is_deleted) {
        return res.status(400).json({
          error: `यह शॉप कोड "${cleanCode}" पहले से दुकान "${existingCode.shop_name}" को दिया जा चुका है। कृपया दूसरा कोड चुनें।`
        });
      } else {
        // Free up colliding shop_code from soft-deleted shop while preserving its historical row
        execute('UPDATE shops SET shop_code = ? WHERE id = ?', [`${cleanCode}_DEL_${existingCode.id}`, existingCode.id]);
      }
    }

    // Check if mobile is already assigned to an ACTIVE shop
    const existingUser = queryOne<any>('SELECT id, role, mobile, password_hash FROM users WHERE mobile = ?', [cleanMobile]);
    if (existingUser) {
      if (existingUser.role === 'admin' || existingUser.role === 'superadmin') {
        return res.status(400).json({
          error: `यह मोबाइल नंबर (${cleanMobile}) एक वितरक/प्रशासक खाते से जुड़ा है। कृपया दुकानदार के लिए अलग मोबाइल नंबर उपयोग करें।`
        });
      }
      const existingShop = queryOne<any>(
        'SELECT id, shop_name, shop_code FROM shops WHERE assigned_user_id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0',
        [existingUser.id]
      );
      if (existingShop) {
        return res.status(400).json({
          error: `यह मोबाइल नंबर (${cleanMobile}) पहले से दुकान "${existingShop.shop_name}" (${existingShop.shop_code}) से जुड़ा हुआ है।`
        });
      }
    }

    const defaultPin = String(pin || password || '1234').trim();
    const finalPinHash = existingUser
      ? ((pin || password) && String(pin || password).trim()
          ? hashPin(String(pin || password).trim())
          : (String(existingUser.password_hash).startsWith('enc:gcm:') ? existingUser.password_hash : hashPin(existingUser.password_hash)))
      : hashPin(defaultPin);
    const effectivePlainPin = decryptPin(finalPinHash) || defaultPin;

    let userId: number = 0;
    let shopId: number = 0;

    withTransaction(() => {
      if (existingUser) {
        userId = existingUser.id;
        execute(
          `UPDATE users SET name = ?, password_hash = ?, active_status = 1, role = 'retailer' WHERE id = ?`,
          [owner_name, finalPinHash, userId]
        );
      } else {
        const safeEmail = `shop_${cleanMobile}_${Date.now()}@retailer.local`;
        const inserted = execute(
          `INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
           VALUES (?, ?, ?, 'retailer', ?, 1, ?)`,
          [owner_name, cleanMobile, safeEmail, finalPinHash, now]
        );
        userId = inserted.lastInsertRowid;
      }

      const res = execute(
        `INSERT INTO shops (shop_code, shop_name, owner_name, mobile, address, area, route, assigned_user_id, distributor_id, active_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [cleanCode, shop_name, owner_name, cleanMobile, address || '', area, route, userId, distId, now]
      );
      shopId = res.lastInsertRowid;

      enqueueOutboxEvent('SHOP_CREATED', 'shop', cleanCode, {
        id: shopId,
        shop_code: cleanCode,
        shop_name,
        owner_name,
        mobile: cleanMobile,
        address: address || '',
        area,
        route,
        assigned_user_id: userId,
        distributor_id: distId,
        active_status: 1,
        password_hash: finalPinHash,
      });
    });

    logAudit(adminUser.id, 'CREATE_SHOP', 'shop', shopId, undefined, JSON.stringify({ shop_code: cleanCode, shop_name }), 'New shop added by distributor');

    return res.status(201).json({
      id: shopId,
      user_id: userId,
      distributor_id: distId,
      shop_code: cleanCode,
      pin: effectivePlainPin,
      message: 'दुकानदार खाता और सुरक्षा पिन सफलतापूर्वक बनाए गए!'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'दुकानदार जोड़ने में त्रुटि' });
  }
});

// Update shop details and PIN
apiRouter.put('/shops/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { shop_code, shop_name, owner_name, mobile, address, area, route, active_status, pin } = req.body;

    const oldShop = queryOne<any>('SELECT * FROM shops WHERE id = ?', [id]);
    if (!oldShop) return res.status(404).json({ error: 'दुकान नहीं मिली' });

    if (adminUser.role === 'admin') {
      const distId = resolveAdminDistributorId(adminUser);
      if (!distId || oldShop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान को संशोधित कर सकते हैं' });
      }
    }

    // Enforce distributor subscription status & max_shops on shop reactivation (Issue 2)
    const isReactivating = (active_status === 1 || active_status === true || active_status === '1') && oldShop.active_status === 0;
    if (isReactivating && oldShop.distributor_id && adminUser.role !== 'superadmin') {
      const distRecord = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [oldShop.distributor_id]);
      if (distRecord) {
        if (distRecord.subscription_status === 'suspended' || distRecord.subscription_status === 'expired' || distRecord.subscription_status === 'deleted') {
          return res.status(403).json({
            error: 'आपका वितरक सब्सक्रिप्शन प्लान समाप्त या निलंबित है। दुकान सक्रिय करने के लिए कृपया अपना प्लान रिन्यू करें।'
          });
        }
        const activeShopsCountRow = queryOne<any>(
          'SELECT COUNT(*) as count FROM shops WHERE distributor_id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0',
          [oldShop.distributor_id]
        );
        const currentShopCount = activeShopsCountRow?.count || 0;
        const maxAllowed = distRecord.max_shops || 30;
        if (currentShopCount >= maxAllowed) {
          return res.status(400).json({
            error: `आपके वर्तमान प्लान (${distRecord.plan_name || 'Starter Plan'}) में अधिकतम ${maxAllowed} सक्रिय दुकानों की सीमा है। इस दुकान को सक्रिय करने के लिए कृपया अपना प्लान अपग्रेड करें।`
          });
        }
      }
    }

    const cleanCode = String(shop_code || oldShop.shop_code).trim().toUpperCase();
    const codeCheck = queryOne<any>(
      'SELECT id, shop_name, active_status, is_deleted FROM shops WHERE UPPER(shop_code) = ? AND id != ?',
      [cleanCode, id]
    );
    if (codeCheck) {
      if (codeCheck.active_status === 1 && !codeCheck.is_deleted) {
        return res.status(400).json({
          error: `यह शॉप कोड "${cleanCode}" पहले से दुकान "${codeCheck.shop_name}" के पास है।`
        });
      }
    }

    const cleanMobile = String(mobile || oldShop.mobile).trim().replace(/\D/g, "");
    if (cleanMobile.length < 10) {
      return res.status(400).json({ error: "कृपया वैध 10-अंकीय मोबाइल नंबर दर्ज करें" });
    }

    let targetUserId = oldShop.assigned_user_id;

    if (cleanMobile !== oldShop.mobile) {
      const existingUser = queryOne<any>(
        "SELECT id, role, name, password_hash FROM users WHERE mobile = ? AND id != ?",
        [cleanMobile, oldShop.assigned_user_id]
      );
      if (existingUser) {
        if (existingUser.role === "admin" || existingUser.role === "superadmin") {
          return res.status(400).json({
            error: `यह मोबाइल नंबर (${cleanMobile}) एक वितरक/प्रशासक खाते से जुड़ा है। कृपया दूसरा मोबाइल नंबर दर्ज करें।`,
          });
        }
        const existingShop = queryOne<any>(
          "SELECT id, shop_name, shop_code FROM shops WHERE assigned_user_id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0 AND id != ?",
          [existingUser.id, id]
        );
        if (existingShop) {
          return res.status(400).json({
            error: `यह मोबाइल नंबर (${cleanMobile}) पहले से सक्रिय दुकान "${existingShop.shop_name}" (${existingShop.shop_code}) से जुड़ा है।`,
          });
        }

        // Reuse existing dormant user to prevent UNIQUE constraint violation on users.mobile
        targetUserId = existingUser.id;
      }
    }

    withTransaction(() => {
      if (codeCheck && !(codeCheck.active_status === 1 && !codeCheck.is_deleted)) {
        execute('UPDATE shops SET shop_code = ? WHERE id = ?', [`${cleanCode}_DEL_${codeCheck.id}`, codeCheck.id]);
      }

      if (cleanMobile !== oldShop.mobile && targetUserId !== oldShop.assigned_user_id) {
        const existingUser = queryOne<any>("SELECT password_hash FROM users WHERE id = ?", [targetUserId]);
        const targetPin = pin && String(pin).trim()
          ? hashPin(String(pin).trim())
          : (String(existingUser?.password_hash).startsWith('enc:gcm:') ? existingUser.password_hash : hashPin(existingUser?.password_hash || '1234'));
        execute(
          "UPDATE users SET name = ?, password_hash = ?, active_status = ?, role = 'retailer' WHERE id = ?",
          [owner_name, targetPin, active_status ? 1 : 0, targetUserId]
        );

        if (oldShop.assigned_user_id) {
          execute("UPDATE users SET active_status = 0 WHERE id = ?", [oldShop.assigned_user_id]);
        }
      }

      execute(
        `UPDATE shops 
         SET shop_code = ?, shop_name = ?, owner_name = ?, mobile = ?, address = ?, area = ?, route = ?, active_status = ?, assigned_user_id = ?
         WHERE id = ?`,
        [
          cleanCode,
          shop_name,
          owner_name,
          cleanMobile,
          address || "",
          area,
          route,
          active_status ? 1 : 0,
          targetUserId,
          id
        ]
      );

      // Update user active status, name and mobile (if not swapped to existingUser)
      if (targetUserId === oldShop.assigned_user_id) {
        execute("UPDATE users SET active_status = ?, mobile = ?, name = ? WHERE id = ?", [
          active_status ? 1 : 0,
          cleanMobile,
          owner_name,
          oldShop.assigned_user_id
        ]);

        // Update PIN if provided
        if (pin && String(pin).trim()) {
          execute("UPDATE users SET password_hash = ? WHERE id = ?", [hashPin(String(pin).trim()), oldShop.assigned_user_id]);
          invalidateUserSessions(oldShop.assigned_user_id);
        }
      }

      const updatedUserRow = queryOne<any>("SELECT password_hash FROM users WHERE id = ?", [targetUserId]);
      enqueueOutboxEvent('SHOP_UPDATED', 'shop', cleanCode, {
        id,
        shop_code: cleanCode,
        shop_name,
        owner_name,
        mobile: cleanMobile,
        address: address || '',
        area,
        route,
        assigned_user_id: targetUserId,
        distributor_id: oldShop.distributor_id,
        active_status: active_status ? 1 : 0,
        password_hash: pin && String(pin).trim() ? hashPin(String(pin).trim()) : updatedUserRow?.password_hash,
      });
    });

    const { pin: _omitShopPin, password: _omitShopPass, ...safeShopAuditBody } = req.body || {};
    logAudit(adminUser.id, 'UPDATE_SHOP', 'shop', id, JSON.stringify(oldShop), JSON.stringify(safeShopAuditBody), 'Shop updated');
    res.json({ message: 'दुकान की जानकारी और पिन अद्यतन हुई (Shop updated)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Explicit Reset PIN endpoint for shopkeeper
apiRouter.post('/shops/:id/reset-pin', authenticate, requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { pin } = req.body;
    if (!pin || String(pin).trim().length < 4) {
      return res.status(400).json({ error: 'सुरक्षा पिन कम से कम 4 अंकों का होना चाहिए' });
    }
    const adminUser = (req as any).user as User;
    const shop = queryOne<any>('SELECT assigned_user_id, shop_name, shop_code, mobile, distributor_id FROM shops WHERE id = ?', [id]);
    if (!shop) return res.status(404).json({ error: 'दुकान नहीं मिली' });

    if (adminUser.role === 'admin') {
      const distId = resolveAdminDistributorId(adminUser);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान का पिन बदल सकते हैं' });
      }
    }

    const cleanPin = String(pin).trim();
    const encryptedPin = hashPin(cleanPin);
    withTransaction(() => {
      execute('UPDATE users SET password_hash = ? WHERE id = ?', [encryptedPin, shop.assigned_user_id]);
      enqueueOutboxEvent('SHOP_UPDATED', 'shop', shop.shop_code, {
        id,
        shop_code: shop.shop_code,
        shop_name: shop.shop_name,
        mobile: shop.mobile,
        distributor_id: shop.distributor_id,
        password_hash: encryptedPin,
      });
    });
    invalidateUserSessions(shop.assigned_user_id);

    res.json({
      success: true,
      mobile: shop.mobile,
      shop_code: shop.shop_code,
      message: `दुकान (${shop.shop_name}) का नया सुरक्षा पिन सुरक्षित रूप से सेट हो गया: ${pin}`
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Soft Delete / Deactivate shopkeeper & shop (Business-Safe: Preserves historical orders & sales)
apiRouter.delete('/shops/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const id = parseInt(req.params.id, 10);

    const oldShop = queryOne<any>('SELECT * FROM shops WHERE id = ?', [id]);
    if (!oldShop) return res.status(404).json({ error: 'दुकान नहीं मिली (Shop not found)' });

    if (adminUser.role === 'admin') {
      const distId = resolveAdminDistributorId(adminUser);
      if (!distId || oldShop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपने वितरक नेटवर्क की दुकान हटा सकते हैं' });
      }
    }

    withTransaction(() => {
      // Mark shop as inactive (Soft Delete) - historical sales, orders, and ledger remain safe
      execute('UPDATE shops SET active_status = 0 WHERE id = ?', [id]);
      try {
        execute('UPDATE shops SET is_deleted = 1 WHERE id = ?', [id]);
      } catch (e) {}

      // Remove automated regular orders so no new orders generate
      execute('DELETE FROM shop_regular_orders WHERE shop_id = ?', [id]);

      // Deactivate shopkeeper login account
      if (oldShop.assigned_user_id) {
        execute('UPDATE users SET active_status = 0, is_deleted = 1 WHERE id = ?', [oldShop.assigned_user_id]);
      }
      if (oldShop.mobile) {
        execute('UPDATE users SET active_status = 0, is_deleted = 1 WHERE mobile = ?', [oldShop.mobile]);
      }

      enqueueOutboxEvent('SHOP_DELETED', 'shop', oldShop.shop_code || String(id), {
        id,
        shop_code: oldShop.shop_code,
        mobile: oldShop.mobile,
        distributor_id: oldShop.distributor_id,
      });
    });

    logAudit(
      adminUser.id,
      'DEACTIVATE_SHOP',
      'shop',
      id,
      JSON.stringify(oldShop),
      undefined,
      `Shopkeeper ${oldShop.owner_name} (${oldShop.shop_code} - ${oldShop.shop_name}) soft-deleted / deactivated by admin`
    );

    res.json({ message: 'दुकान सफलतापूर्वक हटा दी गई (पुराना ऑर्डर व हिसाब सुरक्षित रखा गया है)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Shop Ledger (Orders + Payments)
apiRouter.get('/shops/:id/ledger', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);

    if (user.role === 'retailer' && user.shop_id !== id) {
      return res.status(403).json({ error: 'निषेध: केवल अपनी दुकान का लेज़र देख सकते हैं' });
    }

    const shop = queryOne<any>('SELECT * FROM shops WHERE id = ?', [id]);
    if (!shop) return res.status(404).json({ error: 'दुकान नहीं मिली' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान का लेज़र देख सकते हैं' });
      }
    }

    // Orders billed (only confirmed and fulfilled orders, never pending/unconfirmed or cancelled)
    const orders = query<any>(
      `SELECT id, order_number, order_date, total_amount, status, created_at
       FROM orders
       WHERE shop_id = ? AND status NOT IN ('Pending', 'Cancelled')
       ORDER BY order_date DESC, id DESC`,
      [id]
    );

    // Pending / unconfirmed orders (tracked separately so they do NOT prematurely inflate ledger balance)
    const pendingOrders = query<any>(
      `SELECT id, order_number, order_date, total_amount, status, created_at
       FROM orders
       WHERE shop_id = ? AND status = 'Pending'
       ORDER BY order_date DESC, id DESC`,
      [id]
    );

    // Payments recorded
    const payments = query<any>(
      `SELECT id, amount, payment_date, payment_mode, notes, status, created_at
       FROM payments
       WHERE shop_id = ?
       ORDER BY payment_date DESC, id DESC`,
      [id]
    );

    const totalBilled = orders.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0);
    const totalPendingOrders = pendingOrders.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0);
    const totalPaid = payments
      .filter((p: any) => p.status === 'approved' || !p.status || p.status === '')
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    const totalPending = payments
      .filter((p: any) => p.status === 'pending')
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    const balance = Math.round((totalBilled - totalPaid) * 100) / 100;

    res.json({
      shop,
      summary: {
        total_billed: Math.round(totalBilled * 100) / 100,
        total_paid: Math.round(totalPaid * 100) / 100,
        total_pending: Math.round(totalPending * 100) / 100,
        pending_orders_amount: Math.round(totalPendingOrders * 100) / 100,
        balance
      },
      orders,
      pending_orders: pendingOrders,
      payments
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 6. PAYMENTS ROUTES
// -------------------------------------------------------------

apiRouter.get('/payments', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { shop_id, date } = req.query;

    let sql = `
      SELECT p.*, s.shop_name, s.shop_code
      FROM payments p
      JOIN shops s ON s.id = p.shop_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (user.role === 'retailer') {
      sql += ' AND p.shop_id = ?';
      params.push(user.shop_id);
    } else if (user.role === 'admin') {
      let distId = user.distributor_id;
      if (!distId) {
        const dist = queryOne<any>("SELECT id FROM distributors WHERE (user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id, user.mobile]);
        distId = dist?.id || null;
      }
      if (distId) {
        sql += ' AND s.distributor_id = ?';
        params.push(distId);
      } else {
        return res.json([]);
      }
      if (shop_id) {
        sql += ' AND p.shop_id = ?';
        params.push(shop_id);
      }
    } else if (user.role === 'superadmin') {
      const qDistId = req.query.distributor_id ? parseInt(req.query.distributor_id as string, 10) : null;
      if (qDistId) {
        sql += ' AND s.distributor_id = ?';
        params.push(qDistId);
      }
      if (shop_id) {
        sql += ' AND p.shop_id = ?';
        params.push(shop_id);
      }
    }

    if (date) {
      sql += ' AND p.payment_date = ?';
      params.push(date);
    }

    sql += ' ORDER BY p.payment_date DESC, p.id DESC';
    const payments = query<any>(sql, params);
    res.json(payments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Record payment (Distributor or Retailer)
apiRouter.post('/payments', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { shop_id, amount, payment_date, payment_mode, notes, order_id } = req.body;

    if (!shop_id || amount == null || !payment_date || !payment_mode) {
      return res.status(400).json({ error: 'सभी भुगतान विवरण भरें (All payment details required)' });
    }

    const targetShopId = parseInt(shop_id, 10);
    if (isNaN(targetShopId)) {
      return res.status(400).json({ error: 'अमान्य दुकान आईडी (Invalid shop ID)' });
    }

    const shop = queryOne<any>('SELECT assigned_user_id, shop_name, shop_code, distributor_id FROM shops WHERE id = ?', [targetShopId]);
    if (!shop) {
      return res.status(404).json({ error: 'दुकान नहीं मिली (Shop not found)' });
    }

    // RBAC: Retailer can only record payment for their own shop; Admin for their own distributor's shops
    if (user.role === 'retailer') {
      if (user.shop_id !== targetShopId && shop.assigned_user_id !== user.id) {
        return res.status(403).json({ error: 'निषेध: आप केवल अपनी दुकान के लिए भुगतान दर्ज कर सकते हैं' });
      }
      if (payment_mode !== 'UPI') {
        return res.status(403).json({ error: 'निषेध: दुकानदार केवल UPI के माध्यम से ऑनलाइन भुगतान दर्ज कर सकते हैं (Retailers can only submit UPI payments)' });
      }
    } else if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || shop.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: यह दुकान आपके अधिकार क्षेत्र में नहीं है' });
      }
    } else if (user.role !== 'superadmin') {
      return res.status(403).json({ error: 'अनधिकृत अनुरोध (Unauthorized request)' });
    }

    const validModes = ['Cash', 'UPI', 'Cheque', 'Bank Transfer'];
    if (!validModes.includes(payment_mode)) {
      return res.status(400).json({ error: 'अमान्य भुगतान माध्यम (Invalid payment mode)' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'अमान्य राशि (Invalid payment amount)' });
    }
    const cleanAmount = Math.round(numAmount * 100) / 100;
    if (cleanAmount <= 0) {
      return res.status(400).json({ error: 'अमान्य राशि' });
    }

    // Verify order_id if supplied
    if (order_id) {
      const ord = queryOne<any>('SELECT id, shop_id FROM orders WHERE id = ?', [order_id]);
      if (!ord || ord.shop_id !== targetShopId) {
        return res.status(400).json({ error: 'अमान्य ऑर्डर संदर्भ (Invalid order reference)' });
      }
    }

    // Check duplicate UTR reference if payment mode is UPI
    const noteStr = String(notes || "").trim();
    const utrMatch = noteStr.match(/(?:Ref\s*#?|UTR\s*:?\s*)(\d{12})/i);
    const generic12Match = noteStr.match(/\b\d{12}\b/);
    const utrNumber = utrMatch ? utrMatch[1] : (generic12Match ? generic12Match[0] : null);

    // If retailer submits UPI payment, 12-digit numeric UTR is strictly mandatory
    if (user.role === 'retailer' && payment_mode === 'UPI' && !utrNumber) {
      return res.status(400).json({
        error: 'कृपया वैध 12-अंकीय UPI UTR / Reference नंबर दर्ज करें (Please provide a valid 12-digit numeric UPI UTR reference number)',
      });
    }

    if (utrNumber) {
      // Check across entire platform payments to prevent cross-shop duplicate UTR revenue leakage (excluding rejected payments)
      const dupPay = queryOne<any>(
        `SELECT p.id, p.payment_date, p.amount, s.shop_name, s.shop_code
         FROM payments p
         JOIN shops s ON s.id = p.shop_id
         WHERE p.notes LIKE ? AND (p.status != 'rejected' OR p.status IS NULL)
         LIMIT 1`,
        [`%${utrNumber}%`]
      );
      if (dupPay) {
        return res.status(400).json({
          error: `यह UPI UTR नंबर (${utrNumber}) पहले से दुकान "${dupPay.shop_name}" (${dupPay.shop_code}) द्वारा दर्ज किया जा चुका है (तारीख: ${dupPay.payment_date}, राशि: ₹${dupPay.amount})। कृपया सही व अद्वितीय UTR दर्ज करें।`,
        });
      }

      // Check across subscription payments to prevent reusing platform subscription UTRs
      const dupSub = queryOne<any>(
        "SELECT id, payment_date, amount FROM subscription_payments WHERE reference_no = ? AND status IN ('approved', 'pending') LIMIT 1",
        [utrNumber]
      );
      if (dupSub) {
        return res.status(400).json({
          error: `यह UPI UTR नंबर (${utrNumber}) पहले से सिस्टम में उपयोग किया जा चुका है (तारीख: ${dupSub.payment_date}, राशि: ₹${dupSub.amount})। कृपया अद्वितीय UTR दर्ज करें।`,
        });
      }
    }

    const paymentStatus = user.role === 'retailer' ? 'pending' : (req.body.status && ['pending', 'approved'].includes(req.body.status) ? req.body.status : 'approved');
    const now = new Date().toISOString();

    const payId = withTransaction(() => {
      const { lastInsertRowid } = execute(
        `INSERT INTO payments (shop_id, order_id, amount, payment_date, payment_mode, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [targetShopId, order_id || null, cleanAmount, payment_date, payment_mode, notes || '', paymentStatus, now]
      );

      enqueueOutboxEvent('PAYMENT_CREATED', 'payment', lastInsertRowid, {
        id: lastInsertRowid,
        shop_id: targetShopId,
        distributor_id: shop.distributor_id,
        order_id: order_id || null,
        amount: cleanAmount,
        payment_date,
        payment_mode,
        notes: notes || '',
        status: paymentStatus,
        created_at: now,
      });

      logAudit(user.id, 'RECORD_PAYMENT', 'payment', lastInsertRowid, undefined, `₹${cleanAmount} via ${payment_mode} (${paymentStatus})`, notes);

      return lastInsertRowid;
    });

    // Notifications:
    if (user.role === 'retailer') {
      // Notify distributor that shopkeeper submitted payment for verification
      const distRow = queryOne<any>('SELECT user_id FROM distributors WHERE id = ?', [shop.distributor_id]);
      if (distRow?.user_id) {
        notifyUser(
          distRow.user_id,
          'दुकान से ऑनलाइन भुगतान (सत्यापन लंबित)',
          `दुकान "${shop.shop_name}" ने ₹${cleanAmount} का UPI भुगतान दर्ज किया है। कृपया लेज़र में जोड़ने हेतु UTR सत्यापित करें।`
        );
      }
    } else {
      // Notify shopkeeper that distributor recorded payment
      if (shop.assigned_user_id) {
        notifyUser(
          shop.assigned_user_id,
          'भुगतान प्राप्त हुआ',
          `वितरक को ₹${cleanAmount} का भुगतान (${payment_mode}) प्राप्त हुआ है। धन्यवाद!`
        );
      }
    }

    res.status(201).json({
      id: payId,
      status: paymentStatus,
      payment: {
        id: payId,
        shop_id: targetShopId,
        distributor_id: shop.distributor_id,
        order_id: order_id || null,
        amount: cleanAmount,
        payment_date,
        payment_mode,
        notes: notes || '',
        status: paymentStatus,
        created_at: now
      },
      message: user.role === 'retailer'
        ? 'भुगतान विवरण सफलतापूर्वक भेजा गया! वितरक द्वारा सत्यापन के बाद यह आपके लेज़र में जुड़ जाएगा।'
        : 'भुगतान सफलतापूर्वक दर्ज किया गया!'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Approve pending shopkeeper payment (Distributor / Admin)
apiRouter.post('/payments/:id/approve', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const pay = queryOne<any>(
      `SELECT p.*, s.shop_name, s.assigned_user_id, s.distributor_id
       FROM payments p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ?`,
      [id]
    );
    if (!pay) return res.status(404).json({ error: 'भुगतान रिकॉर्ड नहीं मिला' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || pay.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: यह भुगतान आपके अधिकार क्षेत्र में नहीं है' });
      }
    }

    if (pay.status === 'approved') {
      return res.json({ message: 'यह भुगतान पहले से स्वीकृत है', id, status: 'approved' });
    }

    withTransaction(() => {
      execute("UPDATE payments SET status = 'approved' WHERE id = ?", [id]);
      enqueueOutboxEvent('PAYMENT_UPDATED', 'payment', id, {
        id,
        status: 'approved',
        shop_id: pay.shop_id,
        distributor_id: pay.distributor_id,
      });
      logAudit(user.id, 'APPROVE_PAYMENT', 'payment', id, pay.status, 'approved', 'Payment approved by distributor');
    });

    if (pay.assigned_user_id) {
      notifyUser(
        pay.assigned_user_id,
        'भुगतान स्वीकृत (Payment Approved)',
        `दुकान "${pay.shop_name}" द्वारा दर्ज किया गया ₹${pay.amount} का भुगतान वितरक द्वारा सत्यापित और स्वीकृत कर दिया गया है।`
      );
    }

    res.json({ success: true, message: 'भुगतान सफलतापूर्वक स्वीकृत किया गया!', id, status: 'approved' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reject invalid shopkeeper payment (Distributor / Admin)
apiRouter.post('/payments/:id/reject', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const reason = req.body?.reason || 'अमान्य UTR या बैंक खाते में भुगतान प्राप्त नहीं हुआ';
    const pay = queryOne<any>(
      `SELECT p.*, s.shop_name, s.assigned_user_id, s.distributor_id
       FROM payments p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ?`,
      [id]
    );
    if (!pay) return res.status(404).json({ error: 'भुगतान रिकॉर्ड नहीं मिला' });

    if (user.role === 'admin') {
      const distId = resolveAdminDistributorId(user);
      if (!distId || pay.distributor_id !== distId) {
        return res.status(403).json({ error: 'निषेध: यह भुगतान आपके अधिकार क्षेत्र में नहीं है' });
      }
    }

    const updatedNotes = pay.notes ? `${pay.notes} | अस्वीकृत: ${reason}` : reason;
    withTransaction(() => {
      execute("UPDATE payments SET status = 'rejected', notes = ? WHERE id = ?", [updatedNotes, id]);
      enqueueOutboxEvent('PAYMENT_UPDATED', 'payment', id, {
        id,
        status: 'rejected',
        notes: updatedNotes,
        notes_rejection: reason,
        shop_id: pay.shop_id,
        distributor_id: pay.distributor_id,
      });
      logAudit(user.id, 'REJECT_PAYMENT', 'payment', id, pay.status, 'rejected', reason);
    });

    if (pay.assigned_user_id) {
      notifyUser(
        pay.assigned_user_id,
        'भुगतान अस्वीकृत (Payment Rejected)',
        `दुकान "${pay.shop_name}" का ₹${pay.amount} का भुगतान अनुरोध अस्वीकार कर दिया गया। कारण: ${reason}`
      );
    }

    res.json({ success: true, message: 'भुगतान अनुरोध अस्वीकार कर दिया गया है', id, status: 'rejected' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 7. REPORTS & DASHBOARD METRICS
// -------------------------------------------------------------

apiRouter.get('/reports/dashboard', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const todayStr = getISTDateStr();
    const targetDate = (req.query.date as string) || todayStr;

    let distId: number | null = null;
    if (user.role === 'superadmin' && req.query.distributor_id && req.query.distributor_id !== 'all') {
      distId = parseInt(req.query.distributor_id as string, 10);
    } else if (user.role === 'admin') {
      distId = resolveAdminDistributorId(user);
      if (!distId) {
        return res.status(403).json({ error: 'वितरक खाता नहीं मिला (Distributor account not found)' });
      }
    }

    // 1. Total active shops for this distributor
    let shopSql = 'SELECT COUNT(*) as count FROM shops WHERE active_status = 1';
    const shopParams: any[] = [];
    if (distId) {
      shopSql += ' AND distributor_id = ?';
      shopParams.push(distId);
    }
    const activeShops = queryOne<any>(shopSql, shopParams);

    // 2. Orders metrics for targetDate strictly for this distributor
    let statsSql = `
      SELECT 
        COUNT(o.id) as total_orders,
        SUM(CASE WHEN o.status = 'Pending' THEN 1 ELSE 0 END) as pending_orders,
        SUM(CASE WHEN o.status = 'Confirmed' THEN 1 ELSE 0 END) as confirmed_orders,
        SUM(CASE WHEN o.status = 'Packed' THEN 1 ELSE 0 END) as packed_orders,
        SUM(CASE WHEN o.status = 'Partially Delivered' THEN 1 ELSE 0 END) as partially_delivered_orders,
        SUM(CASE WHEN o.status = 'Delivered' THEN 1 ELSE 0 END) as delivered_orders,
        SUM(CASE WHEN o.status = 'Cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN o.cutoff_status = 'late' AND o.status != 'Cancelled' THEN 1 ELSE 0 END) as late_orders,
        COALESCE(SUM(CASE WHEN o.status != 'Cancelled' THEN o.total_amount ELSE 0 END), 0) as total_order_value
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE o.order_date = ?
    `;
    const statsParams: any[] = [targetDate];
    if (distId) {
      statsSql += ' AND s.distributor_id = ?';
      statsParams.push(distId);
    }
    const orderStats = queryOne<any>(statsSql, statsParams);

    // 3. Shops that have not ordered today strictly for this distributor
    let unsubmittedSql = `
      SELECT s.id, s.shop_code, s.shop_name, s.owner_name, s.mobile, s.route, s.area, s.distributor_id
      FROM shops s
      WHERE s.active_status = 1 
        AND s.id NOT IN (
          SELECT shop_id FROM orders WHERE order_date = ? AND status != 'Cancelled'
        )
    `;
    const unsubmittedParams: any[] = [targetDate];
    if (distId) {
      unsubmittedSql += ' AND s.distributor_id = ?';
      unsubmittedParams.push(distId);
    } else if (user.role === 'admin') {
      unsubmittedSql += ' AND 1=0';
    }
    unsubmittedSql += ' ORDER BY s.route ASC, s.shop_code ASC';
    const unsubmittedShops = query<any>(unsubmittedSql, unsubmittedParams);

    // 4. Product-wise total quantities for targetDate strictly for this distributor
    let prodSql = `
      SELECT p.id, p.name_english, p.name_hindi, p.unit, p.category,
             COALESCE(SUM(oi.ordered_quantity), 0) as total_ordered,
             COALESCE(SUM(oi.delivered_quantity), 0) as total_delivered
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.order_date = ? AND o.status != 'Cancelled'
      WHERE p.active_status = 1
    `;
    const prodParams: any[] = [targetDate];
    if (distId) {
      prodSql += ' AND p.distributor_id = ?';
      prodParams.push(distId);
    } else if (user.role === 'admin') {
      prodSql += ' AND 1=0';
    }
    prodSql += ' GROUP BY p.id ORDER BY p.display_order ASC';
    const productQuantities = query<any>(prodSql, prodParams);

    res.json({
      date: targetDate,
      total_active_shops: activeShops?.count || 0,
      total_orders: orderStats?.total_orders || 0,
      pending_orders: orderStats?.pending_orders || 0,
      confirmed_orders: orderStats?.confirmed_orders || 0,
      packed_orders: orderStats?.packed_orders || 0,
      partially_delivered_orders: orderStats?.partially_delivered_orders || 0,
      delivered_orders: orderStats?.delivered_orders || 0,
      cancelled_orders: orderStats?.cancelled_orders || 0,
      late_orders: orderStats?.late_orders || 0,
      total_order_value: Math.round((orderStats?.total_order_value || 0) * 100) / 100,
      unsubmitted_shops: unsubmittedShops,
      product_quantities: productQuantities
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger daily reminder to shops that have not ordered
apiRouter.post('/notifications/remind-unsubmitted', authenticate, requireAdmin, (req, res) => {
  try {
    const todayStr = getISTDateStr();
    const user = (req as any).user as User;
    const distId = resolveAdminDistributorId(user, req.body.distributor_id || req.query.distributor_id);
    if (user.role === 'admin' && !distId) {
      return res.status(403).json({ error: 'वितरक खाता नहीं मिला (Distributor account not found)' });
    }

    const cutoffCache = new Map<number, string>();
    const getCutoffForDist = (dId?: number | null) => {
      const key = dId ? Number(dId) : 0;
      if (!cutoffCache.has(key)) {
        cutoffCache.set(key, checkCutoffStatus(dId).cutoffTime);
      }
      return cutoffCache.get(key)!;
    };

    let unsubmittedSql = `
      SELECT s.id, s.shop_name, s.assigned_user_id, s.distributor_id
      FROM shops s
      WHERE s.active_status = 1 
        AND s.id NOT IN (
          SELECT shop_id FROM orders WHERE order_date = ? AND status != 'Cancelled'
        )
    `;
    const unsubmittedParams: any[] = [todayStr];
    if (distId) {
      unsubmittedSql += ' AND s.distributor_id = ?';
      unsubmittedParams.push(distId);
    }
    const unsubmitted = query<any>(unsubmittedSql, unsubmittedParams);

    let sentCount = 0;
    for (const shop of unsubmitted) {
      const timeToDisplay = getCutoffForDist(shop.distributor_id || distId);
      notifyUser(
        shop.assigned_user_id,
        'आज के दूध/डेयरी ऑर्डर की याददिहानी (Order Reminder)',
        `नमस्ते ${shop.shop_name}! कृपया आज का ऑर्डर कटऑफ समय ${timeToDisplay} से पहले दर्ज करें।`
      );
      sentCount++;
    }

    res.json({ message: `${sentCount} दुकानों को आज के ऑर्डर की याददिहानी भेजी गई।`, sentCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 8. NOTIFICATIONS & SETTINGS ROUTES
// -------------------------------------------------------------

apiRouter.get('/notifications', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const notifications = query<any>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30',
      [user.id]
    );
    res.json(notifications);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post('/notifications/:id/read', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    execute('UPDATE notifications SET read_status = 1 WHERE id = ? AND user_id = ?', [id, user.id]);
    res.json({ message: 'पढ़ा गया (Marked as read)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post('/notifications/read-all', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    execute('UPDATE notifications SET read_status = 1 WHERE user_id = ?', [user.id]);
    res.json({ message: 'सभी पढ़े गए' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get('/settings', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    let distId = user.distributor_id || null;
    if (user.role === 'superadmin' && req.query.distributor_id && req.query.distributor_id !== 'all') {
      distId = parseInt(req.query.distributor_id as string, 10);
    } else if (!distId && user.role === 'admin') {
      distId = resolveAdminDistributorId(user);
    } else if (!distId && user.role === 'retailer' && user.shop_id) {
      const shop = queryOne<any>('SELECT distributor_id FROM shops WHERE id = ?', [user.shop_id]);
      distId = shop?.distributor_id || null;
    }

    const rows = query<any>('SELECT key, value FROM settings');
    const settingsMap: Record<string, any> = {};
    rows.forEach(r => {
      settingsMap[r.key] = r.key.startsWith('allow_late_orders') ? r.value === 'true' : r.value;
    });

    if (user.role === 'superadmin') {
      // SuperAdmin gets platform settings and distributor-scoped overrides
      const result: any = { ...settingsMap };
      if (distId) {
        if (settingsMap[`cutoff_time_${distId}`] !== undefined) result.cutoff_time = settingsMap[`cutoff_time_${distId}`];
        if (settingsMap[`allow_late_orders_${distId}`] !== undefined) result.allow_late_orders = Boolean(settingsMap[`allow_late_orders_${distId}`]);
        if (settingsMap[`distributor_name_${distId}`]) result.distributor_name = settingsMap[`distributor_name_${distId}`];
        if (settingsMap[`distributor_mobile_${distId}`]) result.distributor_mobile = settingsMap[`distributor_mobile_${distId}`];
        if (settingsMap[`distributor_upi_${distId}`]) result.distributor_upi = settingsMap[`distributor_upi_${distId}`];
        if (settingsMap[`distributor_qr_image_${distId}`]) result.distributor_qr_image = settingsMap[`distributor_qr_image_${distId}`];
      }
      return res.json(result);
    }

    // Distributors and Retailers only receive scoped settings for their specific distributor
    const scopedSettings: any = {
      cutoff_time: (distId && settingsMap[`cutoff_time_${distId}`]) || settingsMap['cutoff_time'] || '20:00',
      allow_late_orders: (distId && settingsMap[`allow_late_orders_${distId}`] !== undefined)
        ? Boolean(settingsMap[`allow_late_orders_${distId}`])
        : Boolean(settingsMap['allow_late_orders']),
      distributor_name: (distId && settingsMap[`distributor_name_${distId}`]) || settingsMap['distributor_name'] || '',
      distributor_mobile: (distId && settingsMap[`distributor_mobile_${distId}`]) || settingsMap['distributor_mobile'] || '',
      distributor_upi: (distId && settingsMap[`distributor_upi_${distId}`]) || settingsMap['distributor_upi'] || '',
      distributor_qr_image: (distId && settingsMap[`distributor_qr_image_${distId}`]) || settingsMap['distributor_qr_image'] || '',
    };

    res.json(scopedSettings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.put('/settings', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { cutoff_time, allow_late_orders, distributor_name, distributor_mobile, distributor_upi } = req.body;

    const distId = resolveAdminDistributorId(user, req.body.distributor_id || req.query.distributor_id);
    if (user.role === 'admin' && !distId) {
      return res.status(403).json({ error: 'वितरक खाता नहीं मिला' });
    }
    const suffix = distId ? `_${distId}` : '';

    withTransaction(() => {
      if (cutoff_time) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`cutoff_time${suffix}`, cutoff_time, cutoff_time]);
        if (user.role === 'superadmin' && !distId) {
          execute('INSERT INTO settings (key, value) VALUES ("cutoff_time", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [cutoff_time, cutoff_time]);
        }
      }
      if (allow_late_orders != null) {
        const val = allow_late_orders ? 'true' : 'false';
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`allow_late_orders${suffix}`, val, val]);
        if (user.role === 'superadmin' && !distId) {
          execute('INSERT INTO settings (key, value) VALUES ("allow_late_orders", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [val, val]);
        }
      }
      if (distributor_name) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`distributor_name${suffix}`, distributor_name, distributor_name]);
        if (distId) {
          execute('UPDATE distributors SET business_name = ? WHERE id = ?', [String(distributor_name).trim(), distId]);
        }
      }
      if (distributor_mobile) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`distributor_mobile${suffix}`, distributor_mobile, distributor_mobile]);
      }
      if (distributor_upi) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`distributor_upi${suffix}`, distributor_upi, distributor_upi]);
      }
      if (req.body.distributor_qr_image !== undefined) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [`distributor_qr_image${suffix}`, req.body.distributor_qr_image, req.body.distributor_qr_image]);
      }
      // Only superadmin can modify platform-level payment settings
      if (user.role === 'superadmin') {
        if (req.body.platform_upi_id !== undefined) {
          execute('INSERT INTO settings (key, value) VALUES ("platform_upi_id", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [req.body.platform_upi_id, req.body.platform_upi_id]);
        }
        if (req.body.platform_qr_image !== undefined) {
          execute('INSERT INTO settings (key, value) VALUES ("platform_qr_image", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [req.body.platform_qr_image, req.body.platform_qr_image]);
        }
        if (req.body.platform_owner_name !== undefined) {
          execute('INSERT INTO settings (key, value) VALUES ("platform_owner_name", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [req.body.platform_owner_name, req.body.platform_owner_name]);
        }
      }

      enqueueOutboxEvent('SETTINGS_UPDATED', 'settings', distId ? String(distId) : 'global', {
        ...req.body,
        distributor_id: distId || undefined,
      });
    });

    logAudit(user.id, 'UPDATE_SETTINGS', 'settings', distId || 0, undefined, JSON.stringify(req.body), 'Settings modified');
    res.json({ message: 'सेटिंग्स सुरक्षित की गईं (Settings saved)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// SuperAdmin uploads or changes Platform Payment QR Code & UPI ID
apiRouter.put('/superadmin/platform-qr', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const { platform_upi_id, platform_qr_image, platform_owner_name } = req.body;

    withTransaction(() => {
      if (platform_upi_id) {
        execute('INSERT INTO settings (key, value) VALUES ("platform_upi_id", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
          String(platform_upi_id).trim(),
          String(platform_upi_id).trim()
        ]);
      }
      if (platform_qr_image !== undefined) {
        execute('INSERT INTO settings (key, value) VALUES ("platform_qr_image", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
          platform_qr_image,
          platform_qr_image
        ]);
      }
      if (platform_owner_name) {
        execute('INSERT INTO settings (key, value) VALUES ("platform_owner_name", ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
          String(platform_owner_name).trim(),
          String(platform_owner_name).trim()
        ]);
      }

      enqueueOutboxEvent('SETTINGS_UPDATED', 'settings', 'global', {
        platform_upi_id: platform_upi_id ? String(platform_upi_id).trim() : undefined,
        platform_qr_image,
        platform_owner_name: platform_owner_name ? String(platform_owner_name).trim() : undefined,
      });
    });

    logAudit(adminUser.id, 'UPDATE_PLATFORM_QR', 'settings', 0, undefined, JSON.stringify(req.body), 'Platform UPI QR updated by SuperAdmin');
    res.json({ success: true, message: 'प्लेटफॉर्म पेमेंट क्यूआर कोड व UPI आईडी सफलतापूर्वक अपडेट की गई!' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distributor uploads or changes their Dairy Payment QR Code & UPI ID (for shopkeepers)
apiRouter.put('/distributor/payment-qr', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    const { distributor_upi, distributor_qr_image } = req.body;

    const distId = resolveAdminDistributorId(user, req.query.distributor_id || req.body.distributor_id);

    if (!distId && user.role !== 'superadmin') {
      return res.status(403).json({ error: 'वितरक खाता नहीं मिला' });
    }

    const upiKey = distId ? `distributor_upi_${distId}` : 'distributor_upi';
    const qrKey = distId ? `distributor_qr_image_${distId}` : 'distributor_qr_image';

    withTransaction(() => {
      if (distributor_upi) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
          upiKey,
          String(distributor_upi).trim(),
          String(distributor_upi).trim()
        ]);
      }
      if (distributor_qr_image !== undefined) {
        execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
          qrKey,
          distributor_qr_image,
          distributor_qr_image
        ]);
      }

      enqueueOutboxEvent('SETTINGS_UPDATED', 'settings', distId ? String(distId) : 'global', {
        distributor_id: distId,
        distributor_upi: distributor_upi ? String(distributor_upi).trim() : undefined,
        distributor_qr_image,
      });
    });

    logAudit(user.id, 'UPDATE_DISTRIBUTOR_QR', 'settings', 0, undefined, JSON.stringify(req.body), 'Distributor payment QR updated');
    res.json({ success: true, message: 'वितरक पेमेंट क्यूआर कोड व UPI आईडी सफलतापूर्वक सुरक्षित हुई!' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Retailer fetches their distributor details and contact information
apiRouter.get('/retailer/my-distributor', authenticate, (req, res) => {
  try {
    const user = (req as any).user as User;
    // Find shop of this user
    let shop = queryOne<any>('SELECT * FROM shops WHERE assigned_user_id = ?', [user.id]);
    if (!shop && user.shop_id) {
      shop = queryOne<any>('SELECT * FROM shops WHERE id = ?', [user.shop_id]);
    }
    const distId = shop?.distributor_id || null;
    let distributor = null;
    if (distId) {
      distributor = queryOne<any>(`
        SELECT d.*, u.name as user_name, u.mobile as user_mobile, u.email as user_email
        FROM distributors d
        JOIN users u ON u.id = d.user_id
        WHERE d.id = ? AND COALESCE(d.is_deleted, 0) = 0 AND d.subscription_status != 'deleted'
      `, [distId]);
    }

    // Load global settings for QR and cutoff
    const settingsRows = query<any>('SELECT key, value FROM settings');
    const settingsMap: Record<string, any> = {};
    settingsRows.forEach(r => { settingsMap[r.key] = r.value; });

    res.json({
      distributor: distributor ? {
        id: distributor.id,
        business_name: distributor.business_name || settingsMap['distributor_name'] || 'VedirtSetu Wholesale Distributors',
        owner_name: distributor.owner_name || 'Rajesh Kumar',
        mobile: distributor.mobile || settingsMap['distributor_mobile'] || '9876543210',
        email: distributor.email || 'distributor@wholesale.com',
        city: distributor.city || 'Jaipur (North Zone)',
        address: distributor.address || 'Plot 45, Transport Nagar, Jaipur',
        upi_id: (distId && settingsMap[`distributor_upi_${distId}`]) || settingsMap['distributor_upi'] || '',
        qr_image: (distId && settingsMap[`distributor_qr_image_${distId}`]) || settingsMap['distributor_qr_image'] || '',
        notes: distributor.notes,
      } : null,
      shop: shop ? {
        id: shop.id,
        shop_code: shop.shop_code,
        shop_name: shop.shop_name,
        owner_name: shop.owner_name,
        mobile: shop.mobile,
        route: shop.route,
        area: shop.area,
      } : null,
      cutoff_time: (distId && settingsMap[`cutoff_time_${distId}`]) || settingsMap['cutoff_time'] || '20:00',
      allow_late_orders: (distId && settingsMap[`allow_late_orders_${distId}`] !== undefined)
        ? settingsMap[`allow_late_orders_${distId}`] === 'true'
        : settingsMap['allow_late_orders'] === 'true',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Audit logs (Scoped per distributor for admin, full view for superadmin)
apiRouter.get('/audit-logs', authenticate, requireAdmin, (req, res) => {
  try {
    const user = (req as any).user as User;
    if (user.role === 'superadmin') {
      const logs = query<any>(`
        SELECT a.*, u.name as user_name, u.role
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC
        LIMIT 100
      `);
      return res.json(logs);
    }

    const distId = resolveAdminDistributorId(user);
    const logs = query<any>(
      `SELECT a.*, u.name as user_name, u.role
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id = ?
          OR a.user_id IN (SELECT assigned_user_id FROM shops WHERE distributor_id = ?)
       ORDER BY a.id DESC
       LIMIT 100`,
      [user.id, distId || -1]
    );
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 8.5 DISTRIBUTOR SUBSCRIPTION & PLANS (SELF-SERVICE)
// -------------------------------------------------------------

const STANDARD_PLANS = [
  {
    id: 'starter',
    name: 'Starter Plan',
    name_hi: 'स्टार्टर प्लान',
    monthly_fee: 999,
    yearly_fee: 9990,
    max_shops: 30,
    description: 'छोटे वितरकों व लोकल रूट के लिए उपयुक्त',
    description_en: 'Ideal for small distributors managing local morning routes',
    features_hi: [
      '30 दुकानों तक का नेटवर्क',
      'दैनिक दूध व दही मांग एकत्रीकरण',
      '1-क्लिक व्हाट्सएप ऑर्डर पर्ची',
      'बेसिक खाता व लेजर बिलिंग'
    ],
    features_en: [
      'Up to 30 Retailer Shops',
      'Daily Morning & Evening Ordering',
      'Consolidated Demand Summary',
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
      'मल्टीपल डिलीवरी रूट (उत्तर, मध्य, दक्षिण)',
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
  }
];

export function getSubscriptionPlansFromDb(): any[] {
  try {
    const rows = query<any>('SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY monthly_fee ASC');
    if (rows && rows.length > 0) {
      return rows.map((r: any) => ({
        ...r,
        popular: Boolean(r.popular),
        is_active: Boolean(r.is_active),
        features_hi: typeof r.features_hi === 'string' ? JSON.parse(r.features_hi || '[]') : (r.features_hi || []),
        features_en: typeof r.features_en === 'string' ? JSON.parse(r.features_en || '[]') : (r.features_en || []),
      }));
    }
  } catch (e) {
    console.error('Error fetching subscription plans:', e);
  }
  return STANDARD_PLANS;
}

apiRouter.get('/subscription/plans', (req, res) => {
  res.json(getSubscriptionPlansFromDb());
});

// SuperAdmin: Update plan prices and details
apiRouter.put('/superadmin/subscription-plans/:id', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const { id } = req.params;
    const {
      name,
      name_hi,
      monthly_fee,
      yearly_fee,
      max_shops,
      description,
      description_en,
      features_hi,
      features_en,
      popular,
      is_active,
    } = req.body;

    const existing = queryOne<any>('SELECT * FROM subscription_plans WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'प्लान नहीं मिला (Plan not found)' });
    }

    const now = new Date().toISOString();
    const featHiStr = Array.isArray(features_hi) ? JSON.stringify(features_hi) : (features_hi || existing.features_hi);
    const featEnStr = Array.isArray(features_en) ? JSON.stringify(features_en) : (features_en || existing.features_en);

    execute(
      `UPDATE subscription_plans SET
        name = ?,
        name_hi = ?,
        monthly_fee = ?,
        yearly_fee = ?,
        max_shops = ?,
        description = ?,
        description_en = ?,
        features_hi = ?,
        features_en = ?,
        popular = ?,
        is_active = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        name !== undefined ? String(name).trim() : existing.name,
        name_hi !== undefined ? String(name_hi).trim() : existing.name_hi,
        monthly_fee !== undefined ? Number(monthly_fee) : existing.monthly_fee,
        yearly_fee !== undefined ? Number(yearly_fee) : existing.yearly_fee,
        max_shops !== undefined ? Number(max_shops) : existing.max_shops,
        description !== undefined ? String(description).trim() : existing.description,
        description_en !== undefined ? String(description_en).trim() : existing.description_en,
        featHiStr,
        featEnStr,
        popular !== undefined ? (popular ? 1 : 0) : existing.popular,
        is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
        now,
        id,
      ]
    );

    logAudit(
      adminUser.id,
      'UPDATE_SUBSCRIPTION_PLAN',
      'subscription_plan',
      0,
      JSON.stringify(existing),
      JSON.stringify(req.body),
      `Admin updated plan ${id} prices: monthly ₹${monthly_fee}`
    );

    enqueueOutboxEvent('SUBSCRIPTION_PLANS_UPDATED', 'subscription_plan', id, getSubscriptionPlansFromDb());

    const updated = queryOne<any>('SELECT * FROM subscription_plans WHERE id = ?', [id]);
    res.json({
      ...updated,
      popular: Boolean(updated.popular),
      is_active: Boolean(updated.is_active),
      features_hi: typeof updated.features_hi === 'string' ? JSON.parse(updated.features_hi || '[]') : updated.features_hi,
      features_en: typeof updated.features_en === 'string' ? JSON.parse(updated.features_en || '[]') : updated.features_en,
      message: 'सब्सक्रिप्शन प्लान सफलतापूर्वक अपडेट किया गया!',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// SuperAdmin: Create new custom subscription plan
apiRouter.post('/superadmin/subscription-plans', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const {
      id,
      name,
      name_hi,
      monthly_fee,
      yearly_fee,
      max_shops,
      description,
      description_en,
      features_hi,
      features_en,
      popular,
    } = req.body;

    if (!id || !name || monthly_fee == null) {
      return res.status(400).json({ error: 'प्लान आईडी, नाम व मासिक शुल्क आवश्यक है' });
    }

    const cleanId = String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const now = new Date().toISOString();
    const featHiStr = Array.isArray(features_hi) ? JSON.stringify(features_hi) : JSON.stringify([]);
    const featEnStr = Array.isArray(features_en) ? JSON.stringify(features_en) : JSON.stringify([]);

    execute(
      `INSERT OR REPLACE INTO subscription_plans (id, name, name_hi, monthly_fee, yearly_fee, max_shops, description, description_en, features_hi, features_en, popular, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        cleanId,
        String(name).trim(),
        String(name_hi || name).trim(),
        Number(monthly_fee),
        Number(yearly_fee) || Number(monthly_fee) * 10,
        Number(max_shops) || 50,
        String(description || '').trim(),
        String(description_en || '').trim(),
        featHiStr,
        featEnStr,
        popular ? 1 : 0,
        now,
      ]
    );

    logAudit(adminUser.id, 'CREATE_SUBSCRIPTION_PLAN', 'subscription_plan', 0, undefined, JSON.stringify(req.body), `Created plan ${cleanId}`);
    enqueueOutboxEvent('SUBSCRIPTION_PLANS_UPDATED', 'subscription_plan', cleanId, getSubscriptionPlansFromDb());
    res.status(201).json({ message: 'नया प्लान सफलतापूर्वक बनाया गया!' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get('/distributor/subscription', authenticate, (req, res) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      return res.status(403).json({ error: 'केवल वितरक को सब्सक्रिप्शन एक्सेस उपलब्ध है' });
    }

    const platUpiRow = queryOne<any>('SELECT value FROM settings WHERE key = "platform_upi_id"');
    const platQrRow = queryOne<any>('SELECT value FROM settings WHERE key = "platform_qr_image"');
    const platOwnerRow = queryOne<any>('SELECT value FROM settings WHERE key = "platform_owner_name"');

    const platUpi = platUpiRow?.value || process.env.PLATFORM_UPI_ID || '';
    const platQr = platQrRow?.value || '';
    const platOwner = platOwnerRow?.value || process.env.PLATFORM_OWNER_NAME || 'VedirtSetu Platforms';
    const currentPlans = getSubscriptionPlansFromDb();

    // Find distributor safely (preventing cross-distributor IDOR for non-superadmin):
    const reqDistId = req.query.distributor_id ? Number(req.query.distributor_id) : null;
    let dist = null;

    if (reqDistId && (user.role === 'superadmin' || user.distributor_id === reqDistId)) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted'", [reqDistId]);
    }

    // 2. By user_id
    if (!dist) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id]);
    }

    // 3. By mobile
    if (!dist && user.mobile) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE mobile = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.mobile]);
      if (dist && (!dist.user_id || dist.user_id !== user.id) && user.role === 'admin') {
        execute('UPDATE distributors SET user_id = ? WHERE id = ?', [user.id, dist.id]);
      }
    }

    // 4. By distributor_id on user object
    if (!dist && user.distributor_id) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted'", [user.distributor_id]);
    }

    // 5. If superadmin or viewing, get first active non-deleted distributor without overwriting user_id
    if (!dist && user.role === 'superadmin') {
      dist = queryOne<any>("SELECT * FROM distributors WHERE COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' AND COALESCE(is_demo, 0) = 0 ORDER BY id ASC LIMIT 1");
    }

    // If still no distributor, return standard plans gracefully with 200 OK so UI never goes blank
    if (!dist) {
      return res.json({
        distributor: null,
        days_remaining: 30,
        is_expiring_soon: false,
        is_expired: false,
        payments: [],
        plans: currentPlans,
        platform_upi: platUpi,
        platform_qr_image: platQr,
        platform_owner: platOwner
      });
    }

    const todayStr = getISTDateStr();
    let daysRemaining = 30;
    let isExpired = false;
    let isExpiringSoon = false;

    if (dist.subscription_renewal_date) {
      const renewalDateStr = dist.subscription_renewal_date;
      const dRen = new Date(renewalDateStr + 'T23:59:59+05:30');
      const dToday = new Date(todayStr + 'T00:00:00+05:30');
      const diffDays = Math.round((dRen.getTime() - dToday.getTime()) / (1000 * 60 * 60 * 24));
      isExpired = renewalDateStr < todayStr || dist.subscription_status === 'expired';
      daysRemaining = isExpired ? Math.min(0, diffDays) : Math.max(0, diffDays);
      isExpiringSoon = !isExpired && daysRemaining <= 7;

      if (isExpired && (dist.subscription_status === 'active' || dist.subscription_status === 'trial')) {
        execute("UPDATE distributors SET subscription_status = 'expired' WHERE id = ?", [dist.id]);
        dist.subscription_status = 'expired';
      }
    }

    try { execute("ALTER TABLE subscription_payments ADD COLUMN status TEXT DEFAULT 'approved';"); } catch (e) {}
    try { execute("ALTER TABLE subscription_payments ADD COLUMN duration_months INTEGER DEFAULT 1;"); } catch (e) {}
    try { execute("ALTER TABLE subscription_payments ADD COLUMN plan_name TEXT DEFAULT '';"); } catch (e) {}

    const payments = query<any>(
      'SELECT * FROM subscription_payments WHERE distributor_id = ? ORDER BY id DESC LIMIT 50',
      [dist.id]
    );

    res.json({
      distributor: dist,
      days_remaining: daysRemaining,
      is_expiring_soon: isExpiringSoon,
      is_expired: isExpired,
      payments,
      plans: currentPlans,
      platform_upi: platUpi,
      platform_qr_image: platQr,
      platform_owner: platOwner
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post('/distributor/subscription/renew', authenticate, (req, res) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      return res.status(403).json({ error: 'केवल वितरक को सब्सक्रिप्शन रिन्यूअल एक्सेस है' });
    }

    let dist = null;
    const reqDistId = req.body.distributor_id ? Number(req.body.distributor_id) : null;
    if (reqDistId && (user.role === 'superadmin' || user.distributor_id === reqDistId)) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted'", [reqDistId]);
    }
    if (!dist) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.id]);
    }
    if (!dist && user.mobile) {
      dist = queryOne<any>("SELECT * FROM distributors WHERE mobile = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' ORDER BY id DESC LIMIT 1", [user.mobile]);
    }
    if (!dist && user.role === 'superadmin') {
      dist = queryOne<any>("SELECT * FROM distributors WHERE COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted' AND COALESCE(is_demo, 0) = 0 ORDER BY id ASC LIMIT 1");
    }
    if (!dist) {
      return res.status(404).json({ error: 'वितरक रिकॉर्ड नहीं मिला' });
    }

    const { plan_name, duration_months = 1, amount, payment_mode = 'UPI', reference_no = '', notes = '' } = req.body;

    const dbPlans = getSubscriptionPlansFromDb();
    const matchedPlan = dbPlans.find((p: any) => p.name?.toLowerCase() === String(plan_name || '').toLowerCase() || p.id?.toLowerCase() === String(plan_name || '').toLowerCase()) || dbPlans[1] || dbPlans[0] || STANDARD_PLANS[1];
    const months = Math.max(1, parseInt(duration_months, 10) || 1);
    const calculatedFee = matchedPlan.monthly_fee;

    const todayStr = getISTDateStr();
    const currentRenewal = dist.subscription_renewal_date;
    const baseDateStr = (currentRenewal && currentRenewal >= todayStr) ? currentRenewal : todayStr;
    const newRenewalDateStr = addMonthsSafe(baseDateStr, months);

    let defaultCalculatedAmount = calculatedFee * months;
    if (months === 12) {
      defaultCalculatedAmount = matchedPlan.yearly_fee;
    } else if (months === 6) {
      defaultCalculatedAmount = Math.round(calculatedFee * 6 * 0.90);
    } else if (months === 3) {
      defaultCalculatedAmount = Math.round(calculatedFee * 3 * 0.95);
    }
    const finalAmount = amount || defaultCalculatedAmount;

    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN status TEXT DEFAULT 'approved';");
    } catch (e) {}
    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN duration_months INTEGER DEFAULT 1;");
    } catch (e) {}
    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN plan_name TEXT DEFAULT '';");
    } catch (e) {}

    const cleanRef = String(reference_no || '').trim();
    if (!cleanRef || cleanRef.length !== 12 || !/^\d{12}$/.test(cleanRef)) {
      return res.status(400).json({ error: 'कृपया वैध 12-अंकीय संख्यात्मक UPI UTR नंबर दर्ज करें (Please enter a valid 12-digit numeric UPI UTR reference number)' });
    }

    const dupCheck = queryOne<any>(
      "SELECT id FROM subscription_payments WHERE reference_no = ? AND status IN ('approved', 'pending')",
      [cleanRef]
    );
    if (dupCheck) {
      return res.status(400).json({ error: 'This UTR reference has already been submitted or processed' });
    }

    // Prevent cross-entity UTR reuse from retail shop payments (Issue 11)
    const dupShopPay = queryOne<any>(
      "SELECT id, payment_date, amount FROM payments WHERE notes LIKE ? AND (status != 'rejected' OR status IS NULL) LIMIT 1",
      [`%${cleanRef}%`]
    );
    if (dupShopPay) {
      return res.status(400).json({
        error: `यह UPI UTR नंबर (${cleanRef}) पहले से दुकानदारों के भुगतान में दर्ज है (तारीख: ${dupShopPay.payment_date}, राशि: ₹${dupShopPay.amount})। कृपया वैध वितरक सदस्यता UTR दर्ज करें।`
      });
    }

    let payId = 0;
    const nowIso = new Date().toISOString();

    withTransaction(() => {
      // पेंडिंग रिकॉर्ड दर्ज करें (सुपर एडमिन वेरिफिकेशन के बाद एक्टिव होगा)
      const res = execute(
        `INSERT INTO subscription_payments
         (distributor_id, amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, status, duration_months, plan_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          dist.id,
          finalAmount,
          todayStr,
          baseDateStr,
          newRenewalDateStr,
          payment_mode,
          cleanRef,
          notes || `Renewal request submitted for plan ${matchedPlan.name} (${months} month(s))`,
          months,
          matchedPlan.name,
          nowIso
        ]
      );
      payId = res.lastInsertRowid;

      try {
        execute("UPDATE distributors SET payment_status = 'pending_verification' WHERE id = ?", [dist.id]);
      } catch (checkErr) {
        // Fallback if an older DB file without migrated CHECK constraint is mounted
        execute("UPDATE distributors SET payment_status = 'due' WHERE id = ?", [dist.id]);
      }

      execute(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, reason, created_at)
         VALUES (?, 'DISTRIBUTOR_PLAN_RENEW', 'distributor', ?, ?, ?, ?, ?)`,
        [user.id, dist.id, dist.subscription_renewal_date, newRenewalDateStr, `Renewal request submitted for ${matchedPlan.name} (${months} months, UTR: ${cleanRef})`, nowIso]
      );

      execute(
        `INSERT INTO notifications (user_id, title, message, read_status, created_at)
         SELECT id, 'सब्सक्रिप्शन भुगतान सत्यापन अनुरोध', ?, 0, ? FROM users WHERE role = 'superadmin'`,
        [`वितरक ${dist.business_name} ने ${matchedPlan.name} प्लान (₹${finalAmount}, ${months} माह, UTR: ${cleanRef}) के लिए भुगतान सत्यापन अनुरोध भेजा है।`, nowIso]
      );

      enqueueOutboxEvent('SUBSCRIPTION_PAYMENT_CREATED', 'subscription_payment', payId, {
        id: payId,
        distributor_id: dist.id,
        business_name: dist.business_name,
        amount: finalAmount,
        payment_date: todayStr,
        period_start: baseDateStr,
        period_end: newRenewalDateStr,
        payment_mode,
        reference_no: cleanRef,
        notes: notes || `Renewal request submitted for plan ${matchedPlan.name} (${months} month(s))`,
        status: 'pending',
        duration_months: months,
        plan_name: matchedPlan.name,
        created_at: nowIso,
      });

      enqueueOutboxEvent('DISTRIBUTOR_STATUS_CHANGED', 'distributor', dist.id, {
        id: dist.id,
        mobile: dist.mobile,
        subscription_status: dist.subscription_status,
        payment_status: 'pending_verification',
      });
    });

    const insertedSubPayment = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);

    const updatedDist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [dist.id]);

    res.json({
      success: true,
      status: 'pending_verification',
      message: `आपका भुगतान विवरण (UTR: ${cleanRef}) सफलतापूर्वक दर्ज हो गया है! सुपर एडमिन सत्यापन के तुरंत बाद आपका प्लान सक्रिय कर दिया जाएगा।`,
      new_renewal_date: newRenewalDateStr,
      distributor: updatedDist,
      payment: insertedSubPayment
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 9. SUPER ADMIN (PLATFORM FOUNDER) SAAS ROUTES
// -------------------------------------------------------------

// Overall platform metrics
apiRouter.get('/superadmin/metrics', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const today = getISTDateStr();

    // Auto-mark distributors whose renewal date has passed as expired (Issue 5: includes trial)
    execute(
      `UPDATE distributors
       SET subscription_status = 'expired'
       WHERE subscription_renewal_date < ?
         AND subscription_status IN ('active', 'trial')
         AND COALESCE(is_deleted, 0) = 0`,
      [today]
    );

    const baseDistWhere = "(is_demo = 0 OR is_demo IS NULL) AND (subscription_status != 'deleted') AND (is_deleted = 0 OR is_deleted IS NULL)";

    const totalDist = queryOne<any>(`SELECT COUNT(*) as count FROM distributors WHERE ${baseDistWhere}`);
    const activeDist = queryOne<any>(`SELECT COUNT(*) as count FROM distributors WHERE subscription_status = 'active' AND ${baseDistWhere}`);
    const trialDist = queryOne<any>(`SELECT COUNT(*) as count FROM distributors WHERE subscription_status = 'trial' AND ${baseDistWhere}`);
    const expiredDist = queryOne<any>(`SELECT COUNT(*) as count FROM distributors WHERE subscription_status IN ('expired', 'suspended') AND ${baseDistWhere}`);

    const mrrRes = queryOne<any>(`SELECT SUM(monthly_fee) as mrr FROM distributors WHERE subscription_status = 'active' AND ${baseDistWhere}`);
    const shopsTotal = queryOne<any>(`SELECT COUNT(*) as count FROM shops WHERE active_status = 1 AND (is_deleted = 0 OR is_deleted IS NULL) AND distributor_id IN (SELECT id FROM distributors WHERE ${baseDistWhere})`);
    const todayOrders = queryOne<any>(`SELECT COUNT(o.id) as count, SUM(o.total_amount) as total FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.order_date = ? AND o.status != 'Cancelled' AND s.distributor_id IN (SELECT id FROM distributors WHERE ${baseDistWhere})`, [today]);

    const sevenDaysFromNow = getISTDateStr(new Date(Date.now() + 7 * 86400000));
    const renewalsDue = queryOne<any>(
      `SELECT COUNT(*) as count FROM distributors 
       WHERE subscription_renewal_date >= ? 
         AND subscription_renewal_date <= ? 
         AND subscription_status IN ('active', 'trial') 
         AND ${baseDistWhere}`,
      [today, sevenDaysFromNow]
    );

    res.json({
      total_distributors: totalDist?.count || 0,
      active_distributors: activeDist?.count || 0,
      trial_distributors: trialDist?.count || 0,
      expired_distributors: expiredDist?.count || 0,
      total_mrr: mrrRes?.mrr || 0,
      total_shops_network: shopsTotal?.count || 0,
      total_today_orders: todayOrders?.count || 0,
      total_today_sales: todayOrders?.total || 0,
      renewals_due_this_week: renewalsDue?.count || 0,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// All distributors with aggregated counts and login PIN
apiRouter.get('/superadmin/distributors', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const today = getISTDateStr();

    // Auto-mark distributors whose renewal date has passed as expired (Issue 5: includes trial)
    execute(
      `UPDATE distributors
       SET subscription_status = 'expired'
       WHERE subscription_renewal_date < ?
         AND subscription_status IN ('active', 'trial')
         AND COALESCE(is_deleted, 0) = 0`,
      [today]
    );

    const demoDelRow = queryOne<any>("SELECT value FROM settings WHERE key = 'demo_deleted'");
    const isDemoDeleted = demoDelRow?.value === '1';

    const distributors = query<any>(`
      SELECT 
        d.*, 
        COALESCE(u.mobile, d.mobile) as user_mobile, 
        COALESCE(u.email, d.email) as user_email, 
        COALESCE(u.password_hash, '1234') as login_pin
      FROM distributors d
      LEFT JOIN users u ON u.id = d.user_id
      WHERE (d.is_demo = 0 OR d.is_demo IS NULL)
        AND (d.subscription_status != 'deleted')
        AND (d.is_deleted = 0 OR d.is_deleted IS NULL)
      ORDER BY d.id ASC
    `).filter((d: any) => {
      if (isDemoDeleted && (d.is_demo === 1 || d.mobile === '9876543210' || String(d.business_name || '').includes('श्री गणेश'))) {
        return false;
      }
      return true;
    });

    const enriched = distributors.map((d) => {
      const shopCountRes = queryOne<any>(
        'SELECT COUNT(*) as count FROM shops WHERE distributor_id = ? AND active_status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)',
        [d.id]
      );
      const ordersRes = queryOne<any>(
        `SELECT COUNT(o.id) as orders_count, COALESCE(SUM(o.total_amount), 0) as total_amount
         FROM orders o
         JOIN shops s ON s.id = o.shop_id
         WHERE s.distributor_id = ? AND o.order_date = ? AND o.status != 'Cancelled'`,
        [d.id, today]
      );

      return {
        ...d,
        login_pin: decryptPin(d.login_pin),
        shops_count: shopCountRes?.count || 0,
        today_orders_count: ordersRes?.orders_count || 0,
        today_sales_amount: ordersRes?.total_amount || 0,
      };
    });

    res.json(enriched);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Onboard new distributor with custom PIN set by Admin
apiRouter.post('/superadmin/distributors', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const {
      business_name,
      owner_name,
      mobile,
      email,
      city,
      address,
      plan_name,
      monthly_fee,
      subscription_status,
      subscription_renewal_date,
      max_shops,
      pin,
      password,
      notes,
    } = req.body;

    const cleanBusinessName = String(business_name || '').trim();
    const cleanOwnerName = String(owner_name || '').trim();
    const cleanMobile = String(mobile || '').trim().replace(/\D/g, '');
    const cleanCity = String(city || '').trim();
    const cleanPlan = String(plan_name || 'Growth Pro').trim();
    const feeNum = Number(monthly_fee);
    const pinStr = String(pin || password || '').trim();

    if (!cleanBusinessName) {
      return res.status(400).json({ error: 'वितरक / डेयरी का नाम अनिवार्य है।' });
    }
    if (!cleanOwnerName) {
      return res.status(400).json({ error: 'मालिक का नाम अनिवार्य है।' });
    }
    if (!cleanMobile || cleanMobile.length < 10) {
      return res.status(400).json({ error: 'वैध 10-अंकीय मोबाइल नंबर अनिवार्य है।' });
    }
    if (!cleanCity) {
      return res.status(400).json({ error: 'शहर / क्षेत्र अनिवार्य है।' });
    }
    if (isNaN(feeNum) || feeNum <= 0) {
      return res.status(400).json({ error: 'वैध मासिक शुल्क अनिवार्य है।' });
    }
    if (pinStr && pinStr.length < 4) {
      return res.status(400).json({ error: 'सुरक्षा पिन कम से कम 4 अंकों का होना चाहिए।' });
    }

    const cleanEmail = email ? String(email).trim().toLowerCase() : `${cleanMobile}@wholesale.com`;
    const now = new Date().toISOString();
    const todayStr = getISTDateStr();
    const renewalDate = subscription_renewal_date || getISTDateStr(new Date(Date.now() + 30 * 86400000));
    const defaultPin = pinStr || '1234';

    // Check if user already exists
    let existingUser = queryOne<any>('SELECT * FROM users WHERE mobile = ? OR email = ?', [cleanMobile, cleanEmail]);
    const finalDistPinHash = existingUser
      ? ((pin || password) && String(pin || password).trim()
          ? hashPin(String(pin || password).trim())
          : (String(existingUser.password_hash).startsWith('enc:gcm:') ? existingUser.password_hash : hashPin(existingUser.password_hash)))
      : hashPin(defaultPin);
    const effectiveDistPlainPin = decryptPin(finalDistPinHash) || defaultPin;

    let userId: number = 0;
    let distId: number = 0;

    withTransaction(() => {
      if (existingUser) {
        // PRESERVE existing user's password/PIN if new pin/password is not explicitly provided!
        execute(
          `UPDATE users SET name = ?, role = 'admin', password_hash = ?, active_status = 1, is_demo = 0, created_by_admin = ? WHERE id = ?`,
          [`${owner_name} (${business_name})`, finalDistPinHash, adminUser.id, existingUser.id]
        );
        userId = existingUser.id;
      } else {
        const resUser = execute(
          `INSERT INTO users (name, mobile, email, role, password_hash, active_status, is_demo, created_by_admin, created_at)
           VALUES (?, ?, ?, 'admin', ?, 1, 0, ?, ?)`,
          [`${owner_name} (${business_name})`, cleanMobile, cleanEmail, finalDistPinHash, adminUser.id, now]
        );
        userId = resUser.lastInsertRowid;
      }

      // Check if distributor with this mobile or user_id already exists
      let existingDist = queryOne<any>('SELECT * FROM distributors WHERE mobile = ? OR user_id = ?', [cleanMobile, userId]);
      if (existingDist) {
        execute(
          `UPDATE distributors SET
            user_id = ?, business_name = ?, owner_name = ?, mobile = ?, email = ?, city = ?, address = ?,
            plan_name = ?, monthly_fee = ?, subscription_status = ?, subscription_renewal_date = ?,
            max_shops = ?, notes = ?, is_demo = 0, is_deleted = 0, created_by_admin = ?
           WHERE id = ?`,
          [
            userId, business_name, owner_name, cleanMobile, cleanEmail, city, address || '',
            plan_name || 'Growth Pro', Number(monthly_fee) || 1999, subscription_status || 'active',
            renewalDate, Number(max_shops) || 100, notes || '', adminUser.id, existingDist.id
          ]
        );
        distId = existingDist.id;
      } else {
        const resDist = execute(
          `INSERT INTO distributors (user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, is_demo, created_by_admin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            userId, business_name, owner_name, cleanMobile, cleanEmail, city, address || '',
            plan_name || 'Growth Pro', Number(monthly_fee) || 1999, subscription_status || 'active',
            todayStr, renewalDate, Number(max_shops) || 100, subscription_status === 'trial' ? 'due' : 'paid',
            notes || '', adminUser.id, now
          ]
        );
        distId = resDist.lastInsertRowid;
      }

      if (subscription_status === 'active') {
        const onboardRef = `SUB-NEW-REG-${distId}`;
        const subRes = execute(
          `INSERT INTO subscription_payments (distributor_id, amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'UPI', ?, 'Onboarding subscription payment', 'approved', ?)`,
          [distId, Number(monthly_fee) || 1999, todayStr, todayStr, renewalDate, onboardRef, now]
        );

        enqueueOutboxEvent('SUBSCRIPTION_PAYMENT_CREATED', 'subscription_payment', subRes.lastInsertRowid, {
          id: subRes.lastInsertRowid,
          distributor_id: distId,
          business_name,
          amount: Number(monthly_fee) || 1999,
          payment_date: todayStr,
          period_start: todayStr,
          period_end: renewalDate,
          payment_mode: 'UPI',
          reference_no: onboardRef,
          notes: 'Onboarding subscription payment',
          status: 'approved',
          created_at: now,
        });
      }

      enqueueOutboxEvent('DISTRIBUTOR_CREATED', 'distributor', distId, {
        id: distId,
        user_id: userId,
        business_name,
        owner_name,
        mobile: cleanMobile,
        email: cleanEmail,
        city,
        address: address || '',
        plan_name: plan_name || 'Growth Pro',
        monthly_fee: Number(monthly_fee) || 1999,
        subscription_status: subscription_status || 'active',
        subscription_start_date: todayStr,
        subscription_renewal_date: renewalDate,
        max_shops: Number(max_shops) || 100,
        payment_status: subscription_status === 'trial' ? 'due' : 'paid',
        notes: notes || '',
        password_hash: finalDistPinHash,
      });
    });

    logAudit(adminUser.id, 'ONBOARD_DISTRIBUTOR', 'distributor', distId, undefined, JSON.stringify({ business_name, owner_name, city }), 'New distributor onboarded by superadmin');

    const createdDist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [distId]);
    res.status(201).json({ id: distId, pin: effectiveDistPlainPin, message: 'नया वितरक और सुरक्षा पिन सफलतापूर्वक बनाया गया!', distributor: createdDist });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update distributor details & PIN
apiRouter.put('/superadmin/distributors/:id', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const dist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला (Distributor not found)' });

    const {
      business_name,
      owner_name,
      mobile,
      email,
      city,
      address,
      plan_name,
      monthly_fee,
      subscription_status,
      subscription_renewal_date,
      max_shops,
      payment_status,
      pin,
      notes,
    } = req.body;

    const targetMobile = mobile !== undefined ? String(mobile).trim().replace(/\D/g, '') : dist.mobile;
    const targetEmail = email !== undefined ? String(email).trim().toLowerCase() : dist.email;

    if (mobile !== undefined && targetMobile.length < 10) {
      return res.status(400).json({ error: 'कृपया वैध 10-अंकीय मोबाइल नंबर दर्ज करें' });
    }

    // Check if new mobile or email is already taken by another user
    if (dist.user_id && (targetMobile !== dist.mobile || targetEmail !== dist.email)) {
      const collision = queryOne<any>(
        'SELECT id, name, role FROM users WHERE (mobile = ? OR email = ?) AND id != ?',
        [targetMobile, targetEmail, dist.user_id]
      );
      if (collision) {
        return res.status(400).json({
          error: `यह मोबाइल नंबर या ईमेल पहले से अन्य खाते (${collision.name} - ${collision.role}) से जुड़ा हुआ है। कृपया अलग विवरण दर्ज करें।`
        });
      }
    }

    withTransaction(() => {
      execute(
        `UPDATE distributors
         SET business_name = ?, owner_name = ?, mobile = ?, email = ?, city = ?, address = ?,
             plan_name = ?, monthly_fee = ?, subscription_status = ?, subscription_renewal_date = ?,
             max_shops = ?, payment_status = ?, notes = ?
         WHERE id = ?`,
        [
          business_name ?? dist.business_name,
          owner_name ?? dist.owner_name,
          targetMobile,
          targetEmail,
          city ?? dist.city,
          address ?? dist.address,
          plan_name ?? dist.plan_name,
          monthly_fee !== undefined ? Number(monthly_fee) : dist.monthly_fee,
          subscription_status ?? dist.subscription_status,
          subscription_renewal_date ?? dist.subscription_renewal_date,
          max_shops !== undefined ? Number(max_shops) : dist.max_shops,
          payment_status ?? dist.payment_status,
          notes ?? dist.notes,
          id,
        ]
      );

      if (dist.user_id) {
        const currentSubStatus = subscription_status ?? dist.subscription_status;
        const activeState = currentSubStatus === 'suspended' ? 0 : 1;
        execute('UPDATE users SET active_status = ?, mobile = ?, email = ? WHERE id = ?', [
          activeState,
          targetMobile,
          targetEmail,
          dist.user_id,
        ]);

        if (pin && String(pin).trim()) {
          execute('UPDATE users SET password_hash = ? WHERE id = ?', [hashPin(String(pin).trim()), dist.user_id]);
          invalidateUserSessions(dist.user_id);
        }
      }

      const updatedDistUser = dist.user_id ? queryOne<any>('SELECT password_hash FROM users WHERE id = ?', [dist.user_id]) : null;
      enqueueOutboxEvent('DISTRIBUTOR_UPDATED', 'distributor', id, {
        id,
        business_name: business_name ?? dist.business_name,
        owner_name: owner_name ?? dist.owner_name,
        mobile: targetMobile,
        email: targetEmail,
        city: city ?? dist.city,
        address: address ?? dist.address,
        plan_name: plan_name ?? dist.plan_name,
        monthly_fee: monthly_fee !== undefined ? Number(monthly_fee) : dist.monthly_fee,
        subscription_status: subscription_status ?? dist.subscription_status,
        subscription_renewal_date: subscription_renewal_date ?? dist.subscription_renewal_date,
        max_shops: max_shops !== undefined ? Number(max_shops) : dist.max_shops,
        payment_status: payment_status ?? dist.payment_status,
        notes: notes ?? dist.notes,
        password_hash: pin && String(pin).trim() ? hashPin(String(pin).trim()) : updatedDistUser?.password_hash,
      });
    });

    const { pin: _omitDistPin, password: _omitDistPass, ...safeDistAuditBody } = req.body || {};
    logAudit(adminUser.id, 'UPDATE_DISTRIBUTOR', 'distributor', id, JSON.stringify(dist), JSON.stringify(safeDistAuditBody), 'Distributor details updated');

    const updatedDist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    res.json({ message: 'वितरक विवरण और पिन अद्यतन किया गया', distributor: updatedDist });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Explicit Reset PIN endpoint for distributor by SuperAdmin
apiRouter.post('/superadmin/distributors/:id/reset-pin', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { pin } = req.body;
    if (!pin || String(pin).trim().length < 4) {
      return res.status(400).json({ error: 'सुरक्षा पिन कम से कम 4 अंकों का होना चाहिए' });
    }
    const dist = queryOne<any>('SELECT user_id, business_name, mobile FROM distributors WHERE id = ?', [id]);
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला' });

    const cleanPin = String(pin).trim();
    const encryptedPin = hashPin(cleanPin);
    withTransaction(() => {
      execute('UPDATE users SET password_hash = ? WHERE id = ?', [encryptedPin, dist.user_id]);
      enqueueOutboxEvent('DISTRIBUTOR_UPDATED', 'distributor', id, {
        id,
        mobile: dist.mobile,
        password_hash: encryptedPin,
      });
    });
    invalidateUserSessions(dist.user_id);

    res.json({ success: true, message: `वितरक (${dist.business_name}) का नया सुरक्षा पिन सेट हो गया: ${pin}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Comprehensive SuperAdmin endpoint: Network-wide breakdown of all distributors, their shops, and ordered products with quantities & prices
apiRouter.get('/superadmin/network-orders', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const date = (req.query.date as string) || getISTDateStr();
    const filterDistId = req.query.distributor_id && req.query.distributor_id !== 'all'
      ? parseInt(req.query.distributor_id as string, 10)
      : null;

    // Fetch distributors
    let distSql = "SELECT * FROM distributors WHERE (is_demo = 0 OR is_demo IS NULL) AND (subscription_status != 'deleted') AND (is_deleted = 0 OR is_deleted IS NULL)";
    const distParams: any[] = [];
    if (filterDistId) {
      distSql += ' AND id = ?';
      distParams.push(filterDistId);
    }
    distSql += ' ORDER BY id ASC';
    const allDistributors = query<any>(distSql, distParams);

    // Fetch all orders for this date
    const orders = query<any>(`
      SELECT o.id as order_id, o.order_number, o.shop_id, o.order_date, o.status,
             o.subtotal, o.total_amount, o.cutoff_status, o.created_at as order_time,
             s.shop_name, s.shop_code, s.owner_name, s.mobile, s.route, s.area, s.distributor_id
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      WHERE o.order_date = ? AND o.status != 'Cancelled'
      ORDER BY s.route ASC, s.shop_code ASC
    `, [date]);

    // Fetch items for these orders
    const orderIds = orders.map((o: any) => o.order_id);
    let itemsMap: Record<number, any[]> = {};
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const items = query<any>(`
        SELECT oi.*, p.name_english, p.name_hindi, p.category, p.unit
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id IN (${placeholders})
        ORDER BY p.display_order ASC
      `, orderIds);
      items.forEach((it: any) => {
        if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
        itemsMap[it.order_id].push(it);
      });
    }

    let globalTotalOrders = 0;
    let globalTotalSales = 0;
    let globalTotalQty = 0;
    const globalShopsSet = new Set<number>();
    let distributorsWithOrdersCount = 0;

    const distributorsResult = allDistributors.map((dist: any) => {
      // Find orders belonging to shops under this distributor
      const distOrders = orders.filter((o: any) => o.distributor_id === dist.id);
      
      let distTotalAmount = 0;
      let distTotalQty = 0;
      const distShopsSet = new Set<number>();
      const consolidatedItemMap: Record<number, any> = {};

      const formattedShopOrders = distOrders.map((o: any) => {
        distTotalAmount += (o.total_amount || 0);
        distShopsSet.add(o.shop_id);
        globalShopsSet.add(o.shop_id);

        const orderItems = itemsMap[o.order_id] || [];
        orderItems.forEach((it: any) => {
          distTotalQty += (it.ordered_quantity || 0);
          globalTotalQty += (it.ordered_quantity || 0);

          if (!consolidatedItemMap[it.product_id]) {
            consolidatedItemMap[it.product_id] = {
              product_id: it.product_id,
              name_english: it.name_english,
              name_hindi: it.name_hindi,
              category: it.category,
              unit: it.unit,
              price: it.unit_price,
              total_ordered_qty: 0,
              total_delivered_qty: 0,
              total_amount: 0,
              shops_count: 0,
              _shops: new Set<number>()
            };
          }
          const c = consolidatedItemMap[it.product_id];
          c.total_ordered_qty += it.ordered_quantity;
          c.total_delivered_qty += it.delivered_quantity;
          c.total_amount += it.line_total;
          c._shops.add(o.shop_id);
          c.shops_count = c._shops.size;
        });

        return {
          order_id: o.order_id,
          order_number: o.order_number,
          shop_id: o.shop_id,
          shop_name: o.shop_name,
          shop_code: o.shop_code,
          owner_name: o.owner_name,
          mobile: o.mobile,
          route: o.route,
          area: o.area,
          status: o.status,
          subtotal: o.subtotal,
          total_amount: o.total_amount,
          order_time: o.order_time,
          items: orderItems
        };
      });

      globalTotalOrders += distOrders.length;
      globalTotalSales += distTotalAmount;
      if (distOrders.length > 0) distributorsWithOrdersCount++;

      const consolidatedItems = Object.values(consolidatedItemMap).map((ci: any) => {
        const { _shops, ...rest } = ci;
        return rest;
      });

      return {
        distributor_id: dist.id,
        business_name: dist.business_name,
        owner_name: dist.owner_name,
        mobile: dist.mobile,
        city: dist.city,
        plan_name: dist.plan_name,
        subscription_status: dist.subscription_status,
        total_orders_count: distOrders.length,
        total_sales_amount: distTotalAmount,
        total_items_quantity: distTotalQty,
        shops_ordering_count: distShopsSet.size,
        consolidated_items: consolidatedItems,
        shop_orders: formattedShopOrders
      };
    });

    res.json({
      date,
      summary: {
        total_distributors_with_orders: distributorsWithOrdersCount,
        total_shops_ordered: globalShopsSet.size,
        total_orders: globalTotalOrders,
        total_items_quantity: globalTotalQty,
        total_sales_amount: globalTotalSales
      },
      distributors: distributorsResult
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Record subscription payment & extend renewal (Supports custom duration, plan selection & duplicate UTR check)
apiRouter.post('/superadmin/distributors/:id/payments', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const dist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला (Distributor not found)' });

    const { amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, duration_months, plan_name } = req.body;
    const rawRef = String(reference_no || '').trim();
    if (rawRef) {
      const dupSub = queryOne<any>(
        "SELECT id FROM subscription_payments WHERE reference_no = ? AND status IN ('approved', 'pending')",
        [rawRef]
      );
      if (dupSub) {
        return res.status(400).json({ error: `यह संदर्भ संख्या / UTR (${rawRef}) पहले से दर्ज है।` });
      }
    }
    const cleanRef = rawRef || `MAN-SUB-${id}-${Date.now()}`;

    const months = Math.max(1, parseInt(duration_months, 10) || 1);
    const targetPlanName = plan_name || dist.plan_name || 'Growth Pro';
    const dbPlans = getSubscriptionPlansFromDb();
    const matchedPlan = dbPlans.find(
      (p: any) =>
        p.name?.toLowerCase() === String(targetPlanName).toLowerCase() ||
        p.id?.toLowerCase() === String(targetPlanName).toLowerCase()
    );
    const newPlanName = matchedPlan?.name || targetPlanName;
    const newMonthlyFee = matchedPlan?.monthly_fee ?? dist.monthly_fee;
    const newMaxShops = matchedPlan?.max_shops ?? dist.max_shops;

    const now = new Date().toISOString();
    const todayStr = getISTDateStr();
    const payDate = payment_date || todayStr;
    const currentRenewal = dist.subscription_renewal_date;
    const baseDateStr = (currentRenewal && currentRenewal >= todayStr) ? currentRenewal : todayStr;
    const pStart = period_start || baseDateStr;
    const pEnd = period_end || addMonthsSafe(baseDateStr, months);

    let payId = 0;
    withTransaction(() => {
      const res = execute(
        `INSERT INTO subscription_payments (distributor_id, amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, status, duration_months, plan_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
        [
          id,
          Number(amount) || (matchedPlan ? matchedPlan.monthly_fee * months : dist.monthly_fee),
          payDate,
          pStart,
          pEnd,
          payment_mode || 'UPI',
          cleanRef,
          notes || '',
          months,
          newPlanName,
          now,
        ]
      );
      payId = res.lastInsertRowid;

      execute(
        `UPDATE distributors
         SET subscription_renewal_date = ?, subscription_status = 'active', payment_status = 'paid',
             plan_name = ?, monthly_fee = ?, max_shops = ?
         WHERE id = ?`,
        [pEnd, newPlanName, newMonthlyFee, newMaxShops, id]
      );

      if (dist.user_id) {
        execute('UPDATE users SET active_status = 1 WHERE id = ?', [dist.user_id]);
      }

      enqueueOutboxEvent('SUBSCRIPTION_PAYMENT_CREATED', 'subscription_payment', payId, {
        id: payId,
        distributor_id: id,
        amount: Number(amount) || (matchedPlan ? matchedPlan.monthly_fee * months : dist.monthly_fee),
        payment_date: payDate,
        period_start: pStart,
        period_end: pEnd,
        payment_mode: payment_mode || 'UPI',
        reference_no: cleanRef,
        notes: notes || '',
        status: 'approved',
        duration_months: months,
        plan_name: newPlanName,
        created_at: now,
      });

      enqueueOutboxEvent('DISTRIBUTOR_UPDATED', 'distributor', id, {
        id,
        subscription_renewal_date: pEnd,
        subscription_status: 'active',
        payment_status: 'paid',
        plan_name: newPlanName,
        monthly_fee: newMonthlyFee,
        max_shops: newMaxShops,
      });
    });

    const insertedPayment = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);

    logAudit(adminUser.id, 'RECORD_SUBSCRIPTION_PAYMENT', 'distributor', id, undefined, JSON.stringify(req.body), 'Subscription renewal payment recorded');

    const updatedDist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    res.json({
      message: 'सब्सक्रिप्शन भुगतान दर्ज किया गया व वैधता बढ़ाई गई! (Payment recorded and renewed)',
      renewal_date: pEnd,
      distributor_id: id,
      payment: insertedPayment,
      distributor: updatedDist,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Subscription payments history
apiRouter.get('/superadmin/subscription-payments', authenticate, requireSuperAdmin, (req, res) => {
  try {
    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN status TEXT DEFAULT 'approved';");
    } catch (e) {}
    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN duration_months INTEGER DEFAULT 1;");
    } catch (e) {}
    try {
      execute("ALTER TABLE subscription_payments ADD COLUMN plan_name TEXT DEFAULT '';");
    } catch (e) {}
    try {
      execute("ALTER TABLE distributors ADD COLUMN plan_name TEXT DEFAULT 'Growth Pro';");
    } catch (e) {}

    const payments = query<any>(`
      SELECT sp.*, d.business_name, d.owner_name, COALESCE(sp.plan_name, d.plan_name, 'Growth Pro') as plan_name, d.city
      FROM subscription_payments sp
      INNER JOIN distributors d ON d.id = sp.distributor_id
      WHERE (d.is_demo = 0 OR d.is_demo IS NULL)
        AND (d.subscription_status != 'deleted')
        AND (d.is_deleted = 0 OR d.is_deleted IS NULL)
      ORDER BY sp.id DESC
    `);
    res.json(payments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// सुपर एडमिन द्वारा असली पेमेंट स्वीकार करना (plan_name, monthly_fee, max_shops व वैधता अपडेट के साथ)
apiRouter.post('/superadmin/subscription-payments/:id/approve', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const payId = parseInt(req.params.id, 10);
    const pay = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);
    if (!pay) return res.status(404).json({ error: 'भुगतान रिकॉर्ड नहीं मिला' });
    if (pay.status === 'approved') return res.json({ message: 'यह भुगतान पहले से स्वीकृत है', distributor_id: pay.distributor_id });

    const dist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [pay.distributor_id]);
    if (!dist) return res.status(404).json({ error: 'वितरक रिकॉर्ड नहीं मिला' });

    const todayStr = getISTDateStr();
    const currentRenewal = dist.subscription_renewal_date;
    const baseDateStr = (currentRenewal && currentRenewal >= todayStr) ? currentRenewal : todayStr;
    const months = pay.duration_months || 1;
    // Preserve calculated period_end without redundant re-extension (Issue 8)
    const newRenewalDateStr = pay.period_end || addMonthsSafe(baseDateStr, months);

    // Match plan from DB if payment specifies a plan_name
    const dbPlans = getSubscriptionPlansFromDb();
    const targetPlanName = pay.plan_name || dist.plan_name || 'Growth Pro';
    const matchedPlan = dbPlans.find(
      (p: any) =>
        p.name?.toLowerCase() === String(targetPlanName).toLowerCase() ||
        p.id?.toLowerCase() === String(targetPlanName).toLowerCase()
    );

    const newPlanName = matchedPlan?.name || targetPlanName;
    const newMonthlyFee = matchedPlan?.monthly_fee ?? dist.monthly_fee;
    const newMaxShops = matchedPlan?.max_shops ?? dist.max_shops;

    // Check if current active shops exceed new max_shops (downgrade warning - Issue 9)
    const activeShopsRow = queryOne<any>(
      'SELECT COUNT(*) as count FROM shops WHERE distributor_id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0',
      [dist.id]
    );
    const currentActiveShops = activeShopsRow?.count || 0;
    let downgradeWarning = '';
    if (newMaxShops < currentActiveShops) {
      downgradeWarning = ` ध्यान दें: वितरक के पास वर्तमान में ${currentActiveShops} सक्रिय दुकानें हैं, जबकि नए प्लान (${newPlanName}) की सीमा ${newMaxShops} है।`;
    }

    withTransaction(() => {
      execute(
        `UPDATE distributors
         SET subscription_status = 'active',
             subscription_renewal_date = ?,
             payment_status = 'paid',
             plan_name = ?,
             monthly_fee = ?,
             max_shops = ?
         WHERE id = ?`,
        [newRenewalDateStr, newPlanName, newMonthlyFee, newMaxShops, dist.id]
      );
      execute(`UPDATE subscription_payments SET status = 'approved', period_end = ? WHERE id = ?`, [newRenewalDateStr, payId]);

      if (dist.user_id) {
        execute('UPDATE users SET active_status = 1 WHERE id = ?', [dist.user_id]);
      }

      enqueueOutboxEvent('SUBSCRIPTION_PAYMENT_CREATED', 'subscription_payment', payId, {
        ...pay,
        status: 'approved',
        period_end: newRenewalDateStr,
      });

      enqueueOutboxEvent('DISTRIBUTOR_UPDATED', 'distributor', dist.id, {
        id: dist.id,
        subscription_status: 'active',
        subscription_renewal_date: newRenewalDateStr,
        payment_status: 'paid',
        plan_name: newPlanName,
        monthly_fee: newMonthlyFee,
        max_shops: newMaxShops,
      });
    });

    if (dist.user_id) {
      // In-app notification to distributor user on approval (Issue 17)
      notifyUser(
        dist.user_id,
        'सब्सक्रिप्शन नवीनीकरण स्वीकृत (Subscription Renewed)',
        `बधाई हो! आपका ${newPlanName} प्लान सफलतापूर्वक स्वीकृत कर दिया गया है। नई नवीनीकरण तिथि: ${newRenewalDateStr}।${downgradeWarning}`
      );
    }

    const updatedApprovedPayment = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);
    const updatedDist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [dist.id]);
    res.json({
      success: true,
      message: `सब्सक्रिप्शन भुगतान सफलतापूर्वक स्वीकृत किया गया! प्लान सक्रिय है।${downgradeWarning}`,
      distributor_id: dist.id,
      new_renewal_date: newRenewalDateStr,
      payment: updatedApprovedPayment,
      distributor: updatedDist
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// सुपर एडमिन द्वारा अमान्य / फ़र्ज़ी UTR खारिज करना
apiRouter.post('/superadmin/subscription-payments/:id/reject', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const payId = parseInt(req.params.id, 10);
    const reason = req.body?.reason || 'अमान्य / फ़र्ज़ी UTR या बैंक खाते में भुगतान प्राप्त नहीं हुआ';
    const pay = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);
    if (!pay) return res.status(404).json({ error: 'भुगतान रिकॉर्ड नहीं मिला' });

    withTransaction(() => {
      execute(
        `UPDATE subscription_payments SET status = 'rejected', notes = ? WHERE id = ?`,
        [reason, payId]
      );

      if (pay.distributor_id) {
        execute(`UPDATE distributors SET payment_status = 'due' WHERE id = ?`, [pay.distributor_id]);
        const distInfo = queryOne<any>('SELECT id, mobile FROM distributors WHERE id = ?', [pay.distributor_id]);
        enqueueOutboxEvent('DISTRIBUTOR_STATUS_CHANGED', 'distributor', pay.distributor_id, {
          id: pay.distributor_id,
          mobile: distInfo?.mobile,
          payment_status: 'due',
        });
      }

      enqueueOutboxEvent('SUBSCRIPTION_PAYMENT_CREATED', 'subscription_payment', payId, {
        ...pay,
        status: 'rejected',
        notes: reason,
      });
    });

    if (pay.distributor_id) {
      // In-app notification to distributor on rejection (Issue 17)
      const distRow = queryOne<any>('SELECT user_id, business_name FROM distributors WHERE id = ?', [pay.distributor_id]);
      if (distRow?.user_id) {
        notifyUser(
          distRow.user_id,
          'सब्सक्रिप्शन भुगतान अस्वीकृत (Payment Rejected)',
          `आपका सब्सक्रिप्शन भुगतान अनुरोध (UTR: ${pay.reference_no || 'N/A'}) अस्वीकार कर दिया गया है। कारण: ${reason}। कृपया सही UTR के साथ पुनः प्रयास करें।`
        );
      }
    }

    const updatedRejectedPayment = queryOne<any>('SELECT * FROM subscription_payments WHERE id = ?', [payId]);
    const updatedDist = pay.distributor_id ? queryOne<any>('SELECT * FROM distributors WHERE id = ?', [pay.distributor_id]) : null;
    res.json({
      success: true,
      distributor_id: pay.distributor_id,
      message: 'भुगतान अनुरोध अस्वीकार कर दिया गया है',
      payment: updatedRejectedPayment,
      distributor: updatedDist
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
// Delete distributor & associated shops
apiRouter.delete('/superadmin/distributors/:id', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const idParam = req.params.id;
    const id = parseInt(idParam, 10);
    const mobileParam = req.query.mobile ? String(req.query.mobile).trim() : '';

    let dist = !isNaN(id) ? queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]) : null;
    if (!dist && idParam) {
      dist = queryOne<any>('SELECT * FROM distributors WHERE mobile = ? OR id = ?', [idParam, idParam]);
    }
    if (!dist && mobileParam) {
      dist = queryOne<any>('SELECT * FROM distributors WHERE mobile = ?', [mobileParam]);
    }

    if (!dist) {
      if (idParam === '9876543210' || mobileParam === '9876543210') {
        try {
          execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_deleted', '1');");
          execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('starter_seeded', '1');");
        } catch (e) {}
      }
      enqueueOutboxEvent('DISTRIBUTOR_DELETED', 'distributor', idParam || mobileParam || '0', {
        id: idParam,
        mobile: mobileParam || idParam,
      });
      return res.json({ message: 'वितरक पहले से हटाया जा चुका है (Distributor already removed)' });
    }

    const targetDistId = dist.id;

    // BUSINESS-SAFE SOFT DELETE:
    withTransaction(() => {
      // 1. Mark distributor status as 'deleted' (with fallback if old SQLite DB constraint exists)
      try {
        execute("UPDATE distributors SET subscription_status = 'deleted' WHERE id = ?", [targetDistId]);
      } catch (checkErr) {
        // If running SQLite table constraint only allows ('active', 'trial', 'expired', 'suspended'):
        execute("UPDATE distributors SET subscription_status = 'suspended' WHERE id = ?", [targetDistId]);
      }
      try {
        execute("UPDATE distributors SET is_deleted = 1 WHERE id = ?", [targetDistId]);
      } catch (e) {}

      // 2. Deactivate distributor login user
      if (dist.user_id) {
        execute('UPDATE users SET active_status = 0, is_deleted = 1 WHERE id = ?', [dist.user_id]);
      }
      if (dist.mobile) {
        execute('UPDATE users SET active_status = 0, is_deleted = 1 WHERE mobile = ?', [dist.mobile]);
      }

      // 3. Soft-deactivate all shops of this distributor (active_status = 0, is_deleted = 1)
      execute('UPDATE shops SET active_status = 0, is_deleted = 1 WHERE distributor_id = ?', [targetDistId]);
      execute('UPDATE users SET active_status = 0, is_deleted = 1 WHERE id IN (SELECT assigned_user_id FROM shops WHERE distributor_id = ?)', [targetDistId]);

      // 4. Soft-deactivate all products of this distributor (active_status = 0, is_deleted = 1)
      execute('UPDATE products SET active_status = 0, is_deleted = 1 WHERE distributor_id = ?', [targetDistId]);

      // 5. Clear automated standing regular order templates so no ghost orders generate
      execute('DELETE FROM shop_regular_orders WHERE shop_id IN (SELECT id FROM shops WHERE distributor_id = ?)', [targetDistId]);

      // If deleting demo distributor, permanently record demo_deleted so it never re-seeds
      if (dist.is_demo === 1 || dist.mobile === '9876543210' || String(dist.business_name || '').includes('श्री गणेश')) {
        try {
          execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_deleted', '1');");
          execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('starter_seeded', '1');");
        } catch (e) {}
      }

      enqueueOutboxEvent('DISTRIBUTOR_DELETED', 'distributor', targetDistId, {
        id: targetDistId,
        mobile: dist.mobile,
        firestore_id: dist.firestore_id,
      });
    });

    logAudit(adminUser.id, 'SOFT_DELETE_DISTRIBUTOR', 'distributor', targetDistId, JSON.stringify(dist), undefined, 'Distributor and shops soft-deleted by superadmin (historical orders & khata preserved)');

    res.json({ message: 'वितरक सफलतापूर्वक सॉफ्ट-डिलीट किया गया (ऐतिहासिक खाता व ऑर्डर रिकॉर्ड्स सुरक्षित हैं)' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Impersonate / generate distributor token
apiRouter.post('/superadmin/impersonate/:id', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dist = queryOne<any>(
      "SELECT * FROM distributors WHERE id = ? AND COALESCE(is_deleted, 0) = 0 AND subscription_status != 'deleted'",
      [id]
    );
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला या हटाया जा चुका है' });

    const distUser = queryOne<any>(
      'SELECT * FROM users WHERE id = ? AND active_status = 1 AND COALESCE(is_deleted, 0) = 0',
      [dist.user_id]
    );
    if (!distUser) return res.status(404).json({ error: 'वितरक उपयोगकर्ता नहीं मिला या निष्क्रिय है' });

    const sessionUser = {
      ...distUser,
      role: 'admin' as const,
      distributor_id: dist.id,
      business_name: dist.business_name,
    };
    const token = generateToken(sessionUser);
    res.json({
      token,
      user: sessionUser,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distributor detailed real-time monitoring endpoint for SuperAdmin
apiRouter.get('/superadmin/distributors/:id/monitoring', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला (Distributor not found)' });

    const distUser = queryOne<any>('SELECT * FROM users WHERE id = ?', [dist.user_id]);
    const todayStr = getISTDateStr();

    const shops = query<any>(`
      SELECT s.*, u.name as user_name, u.email as user_email, u.mobile as user_mobile,
             (SELECT status FROM orders WHERE shop_id = s.id AND order_date = ? AND status != 'Cancelled' LIMIT 1) as today_order_status,
             (SELECT id FROM orders WHERE shop_id = s.id AND order_date = ? AND status != 'Cancelled' LIMIT 1) as today_order_id,
             (SELECT total_amount FROM orders WHERE shop_id = s.id AND order_date = ? AND status != 'Cancelled' LIMIT 1) as today_order_amount,
             (SELECT MAX(order_date) FROM orders WHERE shop_id = s.id AND status != 'Cancelled') as last_order_date,
             (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE shop_id = s.id AND status NOT IN ('Pending', 'Cancelled')) as total_billed,
             (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE shop_id = s.id AND (status = 'approved' OR status IS NULL OR status = '')) as total_paid
      FROM shops s
      LEFT JOIN users u ON u.id = s.assigned_user_id
      WHERE s.distributor_id = ? AND s.active_status = 1 AND (s.is_deleted = 0 OR s.is_deleted IS NULL)
      ORDER BY s.route ASC, s.shop_name ASC
    `, [todayStr, todayStr, todayStr, id]);

    const formattedShops = shops.map((s) => {
      const balance = Math.round(((s.total_billed || 0) - (s.total_paid || 0)) * 100) / 100;
      return {
        ...s,
        balance,
        outstanding_balance: balance,
        today_order_status: s.today_order_status || 'Not Ordered',
        today_order_amount: s.today_order_amount || 0,
      };
    });

    const totalBalance = formattedShops.reduce((acc, s) => acc + (s.balance > 0 ? s.balance : 0), 0);
    const todayOrdersCount = formattedShops.filter(
      (s) => s.today_order_status && s.today_order_status !== 'Not Ordered'
    ).length;
    const todaySalesAmount = formattedShops.reduce((acc, s) => acc + (s.today_order_amount || 0), 0);

    const sevenDaysAgo = getISTDateStr(new Date(Date.now() - 7 * 86400000));
    const activeShops7d = formattedShops.filter(
      (s) => s.last_order_date && s.last_order_date >= sevenDaysAgo
    ).length;

    const stats = {
      total_shops: formattedShops.length,
      active_shops_7d: activeShops7d,
      total_balance: Math.round(totalBalance * 100) / 100,
      today_orders_count: todayOrdersCount,
      today_sales_amount: Math.round(todaySalesAmount * 100) / 100,
      plan_usage_percentage:
        dist.max_shops > 0
          ? Math.round((formattedShops.length / dist.max_shops) * 100)
          : 0,
      is_over_quota: dist.max_shops > 0 && formattedShops.length > dist.max_shops,
    };

    res.json({
      distributor: {
        ...dist,
        user_name: distUser?.name,
        user_mobile: distUser?.mobile,
        user_email: distUser?.email,
        shops_count: formattedShops.length,
        today_orders_count: todayOrdersCount,
        today_sales_amount: todaySalesAmount,
      },
      shops: formattedShops,
      stats,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Quick status change for distributor (active / suspended / trial / expired)
apiRouter.patch('/superadmin/distributors/:id/status', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const adminUser = (req as any).user as User;
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!['active', 'trial', 'expired', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'अमान्य सब्सक्रिप्शन स्थिति (Invalid status)' });
    }

    const dist = queryOne<any>('SELECT * FROM distributors WHERE id = ?', [id]);
    if (!dist) return res.status(404).json({ error: 'वितरक नहीं मिला (Distributor not found)' });

    withTransaction(() => {
      execute('UPDATE distributors SET subscription_status = ? WHERE id = ?', [status, id]);
      if (dist.mobile) {
        execute('UPDATE distributors SET subscription_status = ? WHERE mobile = ?', [status, dist.mobile]);
      }
      const userActive = status === 'suspended' ? 0 : 1;
      if (dist.user_id) {
        execute('UPDATE users SET active_status = ? WHERE id = ?', [userActive, dist.user_id]);
      }
      if (dist.mobile) {
        execute('UPDATE users SET active_status = ? WHERE mobile = ?', [userActive, dist.mobile]);
      }

      enqueueOutboxEvent('DISTRIBUTOR_STATUS_CHANGED', 'distributor', id, {
        id,
        mobile: dist.mobile,
        subscription_status: status,
        status,
        firestore_id: dist.firestore_id,
      });
    });

    logAudit(
      adminUser.id,
      'CHANGE_DISTRIBUTOR_STATUS',
      'distributor',
      id,
      dist.subscription_status,
      status,
      `SuperAdmin toggled status from ${dist.subscription_status} to ${status}`
    );

    res.json({
      message:
        status === 'active'
          ? 'वितरक खाता सक्रिय कर दिया गया है'
          : 'वितरक खाता निलंबित / निष्क्रिय कर दिया गया है',
      subscription_status: status,
      id,
      mobile: dist.mobile,
      user_id: dist.user_id,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});



// -------------------------------------------------------------
// TRANSACTIONAL OUTBOX MONITORING & DISPATCH ENDPOINTS
// -------------------------------------------------------------
apiRouter.get('/outbox/status', authenticate, (_req, res) => {
  try {
    const stats = getOutboxStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.get('/outbox/pending', authenticate, requireAdmin, (req, res) => {
  try {
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10) || 50);
    const events = getPendingOutboxEvents(limit);
    res.json(events);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post('/outbox/process', authenticate, async (_req, res) => {
  try {
    const result = await processOutboxEvents(50);
    res.json({
      success: true,
      message: 'Outbox batch processed',
      result,
      stats: getOutboxStats(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

apiRouter.post('/outbox/retry', authenticate, requireSuperAdmin, async (_req, res) => {
  try {
    const retriedCount = retryFailedOutboxEvents();
    const result = await processOutboxEvents(50);
    res.json({
      success: true,
      retriedCount,
      result,
      stats: getOutboxStats(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// CLOUD RESTORATION ENDPOINT (FIRESTORE SYNC TO SQLITE)
// -------------------------------------------------------------
apiRouter.post('/sync/restore-from-firestore', authenticate, (req, res) => {
  try {
    try { execute("ALTER TABLE distributors ADD COLUMN is_deleted INTEGER DEFAULT 0;"); } catch (e) {}
    try { execute("ALTER TABLE distributors ADD COLUMN is_demo INTEGER DEFAULT 0;"); } catch (e) {}
    try { execute("ALTER TABLE distributors ADD COLUMN created_by_admin INTEGER;"); } catch (e) {}
    try { execute("ALTER TABLE distributors ADD COLUMN plan_name TEXT DEFAULT 'Growth Pro';"); } catch (e) {}
    try { execute("ALTER TABLE users ADD COLUMN is_deleted INTEGER DEFAULT 0;"); } catch (e) {}
    try { execute("ALTER TABLE shops ADD COLUMN is_deleted INTEGER DEFAULT 0;"); } catch (e) {}
    try { execute("ALTER TABLE shops ADD COLUMN distributor_id INTEGER;"); } catch (e) {}
    try { execute("ALTER TABLE products ADD COLUMN is_deleted INTEGER DEFAULT 0;"); } catch (e) {}
    try { execute("ALTER TABLE products ADD COLUMN distributor_id INTEGER;"); } catch (e) {}

    const user = (req as any).user as User;
    const verifiedAdminDistId = user.role === 'admin' ? resolveAdminDistributorId(user) : null;
    if (user.role === 'admin' && !verifiedAdminDistId) {
      return res.status(403).json({ error: 'निषेध: वितरक खाता नहीं मिला' });
    }

    let retailerShopId: number | null = null;
    let retailerDistId: number | null = null;
    if (user.role === 'retailer') {
      retailerShopId = user.shop_id ? Number(user.shop_id) : null;
      retailerDistId = user.distributor_id ? Number(user.distributor_id) : null;
      if (!retailerShopId) {
        const sRow = queryOne<any>('SELECT id, distributor_id FROM shops WHERE (assigned_user_id = ? OR mobile = ?) AND COALESCE(is_deleted, 0) = 0', [user.id, user.mobile]);
        if (sRow) {
          retailerShopId = sRow.id;
          if (!retailerDistId) retailerDistId = sRow.distributor_id;
        }
      } else if (!retailerDistId) {
        const sRow = queryOne<any>('SELECT distributor_id FROM shops WHERE id = ?', [retailerShopId]);
        if (sRow) retailerDistId = sRow.distributor_id;
      }
    }

    const { distributors, shops, products, subscription_payments, orders, payments } = req.body;
    let restoredDistributors = 0;
    let restoredShops = 0;
    let restoredProducts = 0;
    let restoredOrders = 0;

    const demoDelSetting = queryOne<any>("SELECT value FROM settings WHERE key = 'demo_deleted'");
    const isDemoDeletedSetting = demoDelSetting?.value === '1';

    // Only superadmin is permitted to sync or restore distributors and subscription payments
    if (Array.isArray(distributors) && user.role === 'superadmin') {
      for (const d of distributors) {
        try {
          const cleanMobile = String(d.mobile || d.id || '').trim().replace(/\D/g, '');
          if (!cleanMobile || cleanMobile.length < 10) continue;

          // Never restore demo accounts if demo was deleted
          if (isDemoDeletedSetting && (cleanMobile === '9876543210' || d.is_demo === 1 || String(d.business_name || '').includes('श्री गणेश'))) {
            continue;
          }

          // Skip soft-deleted distributors
          if (
            d.subscription_status === 'deleted' ||
            d.is_deleted === 1 ||
            d.is_deleted === true ||
            d.is_deleted === '1' ||
            d.is_deleted === 'true'
          ) {
            continue;
          }

          const mob10 = cleanMobile.slice(-10);
          const distExists = queryOne<any>(
            'SELECT id, subscription_status, is_deleted FROM distributors WHERE mobile = ? OR mobile = ? OR mobile = ?',
            [cleanMobile, mob10, `+91${mob10}`]
          );
          if (distExists) {
            if (distExists.subscription_status === 'deleted' || distExists.is_deleted === 1) {
              continue;
            }
          }

          // Soft-deleted user accounts ko bhi restore hone se rokein
          const userDeleted = queryOne<any>(
            'SELECT id FROM users WHERE (mobile = ? OR mobile = ?) AND is_deleted = 1',
            [cleanMobile, mob10]
          );
          if (userDeleted) {
            continue;
          }

          // Determine if suspended: once suspended, must remain suspended!
          const isSuspended = distExists?.subscription_status === 'suspended' || d.subscription_status === 'suspended';
          const targetActiveStatus = isSuspended ? 0 : 1;
          const targetSubscriptionStatus = isSuspended ? 'suspended' : (d.subscription_status || 'active');

          const exists = queryOne<any>('SELECT id, active_status, password_hash FROM users WHERE mobile = ?', [cleanMobile]);
          let userId = exists?.id;
          const cloudPinOrHash = String(d.password_hash || d.login_pin || d.pin || d.password || '').trim();
          const targetPin = cloudPinOrHash || '1234';

          let targetEmail = d.email ? String(d.email).trim().toLowerCase() : `${cleanMobile}@wholesale.com`;
          // Prevent SQLite UNIQUE constraint collision on users.email
          const emailCheck = queryOne<any>('SELECT id FROM users WHERE email = ? AND mobile != ?', [targetEmail, cleanMobile]);
          if (emailCheck) {
            targetEmail = `${cleanMobile}@wholesale.com`;
          }

          if (!userId) {
            const uRes = execute(
              `INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
               VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
              [d.owner_name || d.business_name || 'Distributor', cleanMobile, targetEmail, hashPin(targetPin), targetActiveStatus, d.created_at || new Date().toISOString()]
            );
            userId = uRes.lastInsertRowid;
          } else {
            if (cloudPinOrHash) {
              execute(
                `UPDATE users SET name = ?, active_status = ?, password_hash = ? WHERE id = ?`,
                [d.owner_name || d.business_name || 'Distributor', targetActiveStatus, hashPin(cloudPinOrHash), userId]
              );
            } else {
              execute(
                `UPDATE users SET name = ?, active_status = ? WHERE id = ?`,
                [d.owner_name || d.business_name || 'Distributor', targetActiveStatus, userId]
              );
            }
          }

          if (!distExists) {
            const candidateDistId = d.id && Number(d.id) > 0 && Number(d.id) < 1000000000 ? Number(d.id) : null;
            const distIdTaken = candidateDistId ? queryOne<any>('SELECT id FROM distributors WHERE id = ?', [candidateDistId]) : null;
            const explicitDistId = candidateDistId && !distIdTaken ? candidateDistId : null;
            execute(
              `INSERT INTO distributors (id, user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                explicitDistId,
                userId,
                d.business_name || 'Distributor',
                d.owner_name || 'Owner',
                cleanMobile,
                targetEmail,
                d.city || 'City',
                d.address || '',
                d.plan_name || 'Growth Pro',
                Number(d.monthly_fee) || 1999,
                targetSubscriptionStatus,
                d.subscription_start_date || new Date().toISOString().split('T')[0],
                d.subscription_renewal_date || new Date(Date.now() + 30*86400000).toISOString().split('T')[0],
                Number(d.max_shops) || 100,
                d.payment_status || 'paid',
                d.notes || '',
                d.created_at || new Date().toISOString()
              ]
            );
            restoredDistributors++;
          } else {
            if (distExists.subscription_status !== 'deleted' && distExists.is_deleted !== 1) {
              execute(
                `UPDATE distributors SET
                  business_name = ?,
                  owner_name = ?,
                  city = ?,
                  address = COALESCE(?, address),
                  subscription_status = ?,
                  plan_name = COALESCE(?, plan_name),
                  monthly_fee = COALESCE(?, monthly_fee),
                  subscription_renewal_date = COALESCE(?, subscription_renewal_date),
                  max_shops = COALESCE(?, max_shops),
                  payment_status = COALESCE(?, payment_status)
                 WHERE id = ?`,
                [
                  d.business_name || distExists.business_name || 'Distributor',
                  d.owner_name || distExists.owner_name || 'Owner',
                  d.city || distExists.city || 'City',
                  d.address || null,
                  targetSubscriptionStatus || 'active',
                  d.plan_name || null,
                  d.monthly_fee != null ? Number(d.monthly_fee) : null,
                  d.subscription_renewal_date || null,
                  d.max_shops != null ? Number(d.max_shops) : null,
                  d.payment_status || null,
                  distExists.id
                ]
              );
            }
            restoredDistributors++;
          }
        } catch (distErr) {
          console.warn('[Restore Sync] Distributor error for item:', d?.mobile || d?.id, distErr);
        }
      }
    }

    if (Array.isArray(shops)) {
      for (const s of shops) {
        if (!s.mobile && !s.shop_code) continue;
        if (s.active_status === 0 || s.is_deleted) continue;
        if (!s.distributor_id) continue; // CRITICAL: Never restore orphan shops without a valid distributor!

        // Check if distributor exists strictly by distributor id or 10-digit mobile
        let distRow: any = null;
        const numDistId = parseInt(String(s.distributor_id), 10);
        if (!isNaN(numDistId) && numDistId > 0 && numDistId < 1000000000) {
          distRow = queryOne<any>(
            'SELECT id, subscription_status, is_deleted FROM distributors WHERE id = ?',
            [numDistId]
          );
        }
        if (!distRow) {
          const cleanDistMob = String(s.distributor_id || '').replace(/\D/g, '');
          if (cleanDistMob.length >= 10) {
            distRow = queryOne<any>(
              'SELECT id, subscription_status, is_deleted FROM distributors WHERE mobile = ?',
              [cleanDistMob]
            );
          }
        }
        if (!distRow || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) {
          continue; // Skip shops belonging to deleted distributors!
        }
        const targetDistId = distRow.id;
        if (user.role === 'admin' && targetDistId !== verifiedAdminDistId) {
          continue; // Strict multi-tenancy: admin can ONLY sync their own shops
        }
        if (user.role === 'retailer') {
          if (retailerShopId && s.id && Number(s.id) !== retailerShopId) {
            continue; // Strict multi-tenancy: retailer can ONLY sync their own shop record
          }
          if (s.mobile && s.mobile !== user.mobile && (!s.shop_code || s.shop_code !== user.shop_code)) {
            continue;
          }
        }

        const exists = queryOne<any>('SELECT id, password_hash FROM users WHERE mobile = ?', [s.mobile]);
        let userId = exists?.id;
        const shopCloudPinOrHash = String(s.password_hash || s.login_pin || s.pin || s.password || '').trim();
        if (!userId) {
          const uRes = execute(
            `INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
             VALUES (?, ?, ?, 'retailer', ?, 1, ?)`,
            [s.owner_name || s.shop_name, s.mobile, s.email || `${s.mobile}@retailer.com`, hashPin(shopCloudPinOrHash || '1234'), s.created_at || new Date().toISOString()]
          );
          userId = uRes.lastInsertRowid;
        } else {
          if (shopCloudPinOrHash) {
            execute('UPDATE users SET name = ?, active_status = 1, password_hash = ? WHERE id = ?', [s.owner_name || s.shop_name, hashPin(shopCloudPinOrHash), userId]);
          } else {
            execute('UPDATE users SET name = ?, active_status = 1 WHERE id = ?', [s.owner_name || s.shop_name, userId]);
          }
        }

        const shopExists = queryOne<any>('SELECT id, is_deleted, active_status, COALESCE(is_demo, 0) as is_demo FROM shops WHERE shop_code = ?', [s.shop_code]);
        if (shopExists && !shopExists.is_demo && (shopExists.is_deleted === 1 || shopExists.active_status === 0)) {
          continue; // NEVER resurrect soft-deleted real shops!
        }
        if (!shopExists) {
          const candidateShopId = s.id && Number(s.id) > 0 && Number(s.id) < 1000000000 ? Number(s.id) : null;
          const shopIdTaken = candidateShopId ? queryOne<any>('SELECT id FROM shops WHERE id = ?', [candidateShopId]) : null;
          const explicitShopId = candidateShopId && !shopIdTaken ? candidateShopId : null;
          execute(
            `INSERT INTO shops (id, shop_code, shop_name, owner_name, mobile, address, area, route, assigned_user_id, distributor_id, active_status, is_demo, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
              explicitShopId,
              s.shop_code,
              s.shop_name,
              s.owner_name || s.shop_name,
              s.mobile,
              s.address || '',
              s.area || '',
              s.route || 'Route 1',
              userId,
              targetDistId,
              s.is_demo ? 1 : 0,
              s.created_at || new Date().toISOString()
            ]
          );
          restoredShops++;
        } else {
          execute(
            'UPDATE shops SET shop_name = ?, owner_name = ?, mobile = ?, address = ?, area = ?, route = ?, distributor_id = ?, assigned_user_id = ?, active_status = 1, is_deleted = 0, is_demo = ? WHERE id = ?',
            [
              s.shop_name,
              s.owner_name || s.shop_name,
              s.mobile,
              s.address || '',
              s.area || '',
              s.route || 'Route 1',
              targetDistId,
              userId,
              s.is_demo ? 1 : 0,
              shopExists.id
            ]
          );
        }
      }
    }

    if (Array.isArray(products)) {
      for (const p of products) {
        if (!p.name_english && !p.name_hindi) continue;
        if (p.active_status === 0 || p.is_deleted) continue;
        const pDistId = p.distributor_id ? Number(p.distributor_id) : null;
        if (!pDistId) continue; // CRITICAL: Never restore orphan products without a valid distributor!

        const distRow = queryOne<any>('SELECT id, subscription_status, is_deleted FROM distributors WHERE id = ?', [pDistId]);
        if (!distRow || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) {
          continue; // Skip products belonging to deleted distributors!
        }
        if (user.role === 'admin' && pDistId !== verifiedAdminDistId) {
          continue; // Strict multi-tenancy: admin can ONLY sync their own products
        }
        if (user.role === 'retailer' && retailerDistId && pDistId !== retailerDistId) {
          continue; // Strict multi-tenancy: retailer can ONLY sync their distributor's products
        }

        const pExists = queryOne<any>('SELECT id, active_status, is_deleted FROM products WHERE (name_english = ? OR name_hindi = ? OR id = ?) AND distributor_id = ?', [p.name_english, p.name_hindi, p.id || -1, pDistId]);
        if (pExists && (pExists.is_deleted === 1 || pExists.active_status === 0)) {
          continue; // Never resurrect soft-deleted products from cloud sync
        }
        if (!pExists) {
          const candidateProdId = p.id && Number(p.id) > 0 && Number(p.id) < 1000000000 ? Number(p.id) : null;
          const prodIdTaken = candidateProdId ? queryOne<any>('SELECT id FROM products WHERE id = ?', [candidateProdId]) : null;
          const explicitProdId = candidateProdId && !prodIdTaken ? candidateProdId : null;
          execute(
            `INSERT INTO products (id, distributor_id, name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              explicitProdId,
              pDistId,
              p.name_english || p.name || 'Product',
              p.name_hindi || p.name_english || 'उत्पाद',
              p.category || 'Dairy',
              p.unit || 'pkt',
              p.price || 0,
              p.minimum_quantity || 0,
              p.stock_available ?? 1,
              p.active_status ?? 1,
              p.display_order || 0
            ]
          );
          restoredProducts++;
        } else {
          execute(
            `UPDATE products
             SET name_english = ?, name_hindi = ?, category = ?, unit = ?, price = ?, minimum_quantity = ?, stock_available = ?, active_status = ?, display_order = ?
             WHERE id = ?`,
            [
              p.name_english || p.name || 'Product',
              p.name_hindi || p.name_english || 'उत्पाद',
              p.category || 'Milk',
              p.unit || 'pkt',
              p.price || 0,
              p.minimum_quantity || 0,
              p.stock_available ?? 1,
              p.active_status ?? 1,
              p.display_order || 0,
              pExists.id
            ]
          );
        }
      }
    }

    let restoredPayments = 0;
    if (Array.isArray(subscription_payments) && (user.role === 'superadmin' || user.role === 'admin')) {
      for (const sp of subscription_payments) {
        try {
          if (!sp.amount) continue;
          // Secure multi-tenancy mapping: Admin restores exclusively to their verified distributor ID
          const targetDistId = user.role === 'admin' ? verifiedAdminDistId : (Number(sp.distributor_id) || verifiedAdminDistId);
          if (!targetDistId) continue;
          const distExists = queryOne<any>('SELECT id FROM distributors WHERE id = ?', [targetDistId]);
          if (!distExists) continue;

          const rawRef = String(sp.reference_no || '').trim();
          const refNo = !rawRef || rawRef === 'SUB-NEW-REG' ? `SUB-NEW-REG-${targetDistId}` : rawRef;
          const existingPay =
            rawRef && rawRef !== 'SUB-NEW-REG'
              ? queryOne<any>('SELECT id, status, notes FROM subscription_payments WHERE reference_no = ?', [rawRef])
              : queryOne<any>(
                  'SELECT id, status, notes FROM subscription_payments WHERE distributor_id = ? AND (reference_no = ? OR (payment_date = ? AND amount = ?))',
                  [targetDistId, refNo, sp.payment_date, sp.amount]
                );
          if (existingPay) {
            if ((sp.status && existingPay.status !== sp.status) || (sp.notes && existingPay.notes !== sp.notes)) {
              execute(
                'UPDATE subscription_payments SET status = COALESCE(?, status), notes = COALESCE(?, notes), period_end = COALESCE(?, period_end) WHERE id = ?',
                [sp.status || null, sp.notes || null, sp.period_end || null, existingPay.id]
              );
            }
          } else {
            execute(
              `INSERT INTO subscription_payments (distributor_id, amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, status, duration_months, plan_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                targetDistId,
                Number(sp.amount),
                sp.payment_date || getISTDateStr(),
                sp.period_start || sp.payment_date || getISTDateStr(),
                sp.period_end || sp.payment_date || getISTDateStr(),
                sp.payment_mode || 'UPI',
                refNo,
                sp.notes || '',
                sp.status || 'approved',
                Number(sp.duration_months) || 1,
                sp.plan_name || 'Growth Pro',
                sp.created_at || new Date().toISOString()
              ]
            );
            restoredPayments++;
          }
        } catch (e) {}
      }
    }

    // Restore Orders & Order Items from Firestore Cloud
    if (Array.isArray(orders)) {
      for (const ord of orders) {
        try {
          if (!ord.order_number) continue;
          const orderNum = String(ord.order_number).trim();
          if (orderNum.match(/^ORD-\d{10,14}$/) && (!ord.shop_id || !ord.order_date)) continue; // Skip rogue documents
          let targetShopId = ord.shop_id ? Number(ord.shop_id) : null;
          if (!targetShopId && ord.shop_code) {
            const shRow = queryOne<any>('SELECT id FROM shops WHERE UPPER(shop_code) = ?', [String(ord.shop_code).toUpperCase()]);
            if (shRow) targetShopId = shRow.id;
          }
          if (!targetShopId) continue;

          // If distributor admin, ensure order belongs to their network
          if (user.role === 'admin' && verifiedAdminDistId) {
            const shDist = queryOne<any>('SELECT distributor_id FROM shops WHERE id = ?', [targetShopId]);
            if (!shDist || shDist.distributor_id !== verifiedAdminDistId) continue;
          }

          // If retailer, ensure order belongs to their own shop
          if (user.role === 'retailer' && retailerShopId) {
            if (targetShopId !== retailerShopId) continue;
          }

          const existingOrd = queryOne<any>('SELECT id, status, total_amount FROM orders WHERE order_number = ?', [orderNum]);
          if (existingOrd) {
            const statusChanged = ord.status && ord.status !== existingOrd.status;
            const totalChanged = ord.total_amount != null && Number(ord.total_amount) !== Number(existingOrd.total_amount);
            if (statusChanged || totalChanged || (Array.isArray(ord.items) && ord.items.length > 0)) {
              withTransaction(() => {
                if (statusChanged || totalChanged) {
                  execute(
                    'UPDATE orders SET status = COALESCE(?, status), subtotal = COALESCE(?, subtotal), total_amount = COALESCE(?, total_amount), notes = COALESCE(?, notes), confirmed_at = COALESCE(?, confirmed_at), delivered_at = COALESCE(?, delivered_at), updated_at = ? WHERE id = ?',
                    [
                      ord.status || null,
                      ord.subtotal != null ? Number(ord.subtotal) : null,
                      ord.total_amount != null ? Number(ord.total_amount) : null,
                      ord.notes != null ? String(ord.notes) : null,
                      ord.confirmed_at || null,
                      ord.delivered_at || null,
                      ord.updated_at || new Date().toISOString(),
                      existingOrd.id
                    ]
                  );
                }
                if (Array.isArray(ord.items) && ord.items.length > 0) {
                  const validItems: any[] = [];
                  for (const it of ord.items) {
                    const pId = Number(it.product_id);
                    if (!pId) continue;
                    const prodRow = queryOne<any>('SELECT id, price FROM products WHERE id = ?', [pId]);
                    if (!prodRow) continue;
                    const ordQty = Number(it.ordered_quantity || it.quantity || 0);
                    const delQty = Number(it.delivered_quantity || 0);
                    let uPrice = Number(it.unit_price || it.price || 0);
                    if (uPrice <= 0 && prodRow.price) uPrice = Number(prodRow.price);
                    const lTotal = Number(it.line_total || Math.round(uPrice * ordQty * 100) / 100);
                    validItems.push([existingOrd.id, pId, ordQty, delQty, uPrice, lTotal]);
                  }
                  if (validItems.length > 0) {
                    execute('DELETE FROM order_items WHERE order_id = ?', [existingOrd.id]);
                    for (const vi of validItems) {
                      execute(
                        `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        vi
                      );
                    }
                  }
                }
              });
            }
          } else {
            const ordDate = ord.order_date || getISTDateStr();
            const now = ord.created_at || new Date().toISOString();
            const totalAmt = Number(ord.total_amount) || 0;
            const subtotalAmt = Number(ord.subtotal) || totalAmt;
            const cutoffSt = ord.cutoff_status || 'on_time';
            const notesText = ord.notes || '';
            const ordStatus = ord.status || 'Pending';

            // Validate created_by against users(id) to prevent FOREIGN KEY constraint failure
            const rawCreatedBy = ord.created_by ? Number(ord.created_by) : 0;
            const validUserRow = rawCreatedBy > 0 ? queryOne<any>('SELECT id FROM users WHERE id = ?', [rawCreatedBy]) : null;
            const shopUserRow = !validUserRow ? queryOne<any>('SELECT assigned_user_id FROM shops WHERE id = ?', [targetShopId]) : null;
            const fallbackUserRow = (!validUserRow && !shopUserRow?.assigned_user_id) ? queryOne<any>('SELECT id FROM users ORDER BY id ASC LIMIT 1') : null;
            const createdById = validUserRow?.id || shopUserRow?.assigned_user_id || fallbackUserRow?.id || 1;

            // Preserve original order id if available and unused so payments.order_id references remain valid
            const candidateOrdId = ord.id && Number(ord.id) > 0 && Number(ord.id) < 1000000000 ? Number(ord.id) : null;
            const ordIdTaken = candidateOrdId ? queryOne<any>('SELECT id FROM orders WHERE id = ?', [candidateOrdId]) : null;
            const explicitOrdId = candidateOrdId && !ordIdTaken ? candidateOrdId : null;

            withTransaction(() => {
              const res = execute(
                `INSERT INTO orders (id, order_number, shop_id, created_by, order_date, status, subtotal, total_amount, cutoff_status, notes, created_at, updated_at, confirmed_at, delivered_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  explicitOrdId,
                  orderNum,
                  targetShopId,
                  createdById,
                  ordDate,
                  ordStatus,
                  subtotalAmt,
                  totalAmt,
                  cutoffSt,
                  notesText,
                  now,
                  ord.updated_at || now,
                  ord.confirmed_at || null,
                  ord.delivered_at || null
                ]
              );
              const newOrdId = explicitOrdId || res.lastInsertRowid;

              if (Array.isArray(ord.items) && ord.items.length > 0 && newOrdId) {
                for (const it of ord.items) {
                  const pId = Number(it.product_id);
                  if (!pId) continue;
                  const prodRow = queryOne<any>('SELECT id, price FROM products WHERE id = ?', [pId]);
                  if (!prodRow) continue; // Skip missing product to prevent FOREIGN KEY rollback of entire order
                  const ordQty = Number(it.ordered_quantity || it.quantity || 0);
                  const delQty = Number(it.delivered_quantity || 0);
                  let uPrice = Number(it.unit_price || it.price || 0);
                  if (uPrice <= 0 && prodRow.price) {
                    uPrice = Number(prodRow.price);
                  }
                  const lTotal = Number(it.line_total || Math.round(uPrice * ordQty * 100) / 100);

                  execute(
                    `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [newOrdId, pId, ordQty, delQty, uPrice, lTotal]
                  );
                }
              }
            });
            restoredOrders++;
          }
        } catch (ordErr) {
          console.warn('[Restore Sync] Order restore error:', ord?.order_number, ordErr);
        }
      }
    }

    let restoredShopPayments = 0;
    if (Array.isArray(payments)) {
      for (const py of payments) {
        try {
          if (!py.shop_id || py.amount == null) continue;
          const targetShopId = Number(py.shop_id);
          const shopRow = queryOne<any>('SELECT id, distributor_id FROM shops WHERE id = ?', [targetShopId]);
          if (!shopRow) continue;

          // Strict multi-tenancy: admin can only restore payments for shops belonging to their distributor
          if (user.role === 'admin' && verifiedAdminDistId && shopRow.distributor_id !== verifiedAdminDistId) {
            continue;
          }

          // Strict multi-tenancy: retailer can only restore payments for their own shop
          if (user.role === 'retailer' && retailerShopId && targetShopId !== retailerShopId) {
            continue;
          }

          const pyAmount = Number(py.amount);
          const pyDate = py.payment_date || getISTDateStr();
          const pyMode = py.payment_mode || 'Cash';
          const pyNotes = py.notes || '';
          const pyStatus = py.status || 'approved';
          const pyCreatedAt = py.created_at || new Date().toISOString();
          const rawOrderId = py.order_id ? Number(py.order_id) : null;
          const validOrdRow = rawOrderId ? queryOne<any>('SELECT id FROM orders WHERE id = ?', [rawOrderId]) : null;
          const pyOrderId = validOrdRow ? validOrdRow.id : null;

          let existingPay = null;
          if (py.id && Number(py.id) > 0) {
            existingPay = queryOne<any>('SELECT id, status, notes FROM payments WHERE id = ?', [Number(py.id)]);
          }
          if (!existingPay && pyNotes) {
            existingPay = queryOne<any>(
              'SELECT id, status, notes FROM payments WHERE shop_id = ? AND payment_date = ? AND amount = ? AND notes = ?',
              [targetShopId, pyDate, pyAmount, pyNotes]
            );
          }
          if (!existingPay) {
            existingPay = queryOne<any>(
              'SELECT id, status, notes FROM payments WHERE shop_id = ? AND payment_date = ? AND amount = ? AND payment_mode = ?',
              [targetShopId, pyDate, pyAmount, pyMode]
            );
          }

          if (existingPay) {
            if ((pyStatus && existingPay.status !== pyStatus) || (pyNotes && existingPay.notes !== pyNotes)) {
              execute('UPDATE payments SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?', [pyStatus || null, pyNotes || null, existingPay.id]);
            }
          } else {
            execute(
              `INSERT INTO payments (id, shop_id, order_id, amount, payment_date, payment_mode, notes, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                py.id && Number(py.id) > 0 ? Number(py.id) : null,
                targetShopId,
                pyOrderId,
                pyAmount,
                pyDate,
                pyMode,
                pyNotes,
                pyStatus,
                pyCreatedAt
              ]
            );
            restoredShopPayments++;
          }
        } catch (pyErr) {
          console.warn('[Restore Sync] Shop payment restore error:', py?.id, pyErr);
        }
      }
    }

    res.json({
      success: true,
      message: `पुनर्स्थापित: ${restoredDistributors} वितरक, ${restoredShops} दुकानें, ${restoredProducts} उत्पाद, ${restoredPayments} सब्सक्रिप्शन, ${restoredOrders} ऑर्डर्स, ${restoredShopPayments} दुकान भुगतान`,
      counts: { restoredDistributors, restoredShops, restoredProducts, restoredPayments, restoredOrders, restoredShopPayments }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// RESTORE SUBSCRIPTION PLANS FROM CLOUD FIRESTORE (Accessible by both Distributor & SuperAdmin)
apiRouter.post('/sync/restore-plans', authenticate, requireAdmin, (req, res) => {
  try {
    const { plans } = req.body;
    if (Array.isArray(plans)) {
      for (const p of plans) {
        if (!p.id) continue;
        const exists = queryOne<any>('SELECT id FROM subscription_plans WHERE id = ?', [p.id]);
        if (exists) {
          execute(
            `UPDATE subscription_plans SET
              name = COALESCE(?, name),
              name_hi = COALESCE(?, name_hi),
              monthly_fee = COALESCE(?, monthly_fee),
              yearly_fee = COALESCE(?, yearly_fee),
              max_shops = COALESCE(?, max_shops),
              popular = COALESCE(?, popular),
              is_active = COALESCE(?, is_active)
             WHERE id = ?`,
            [
              p.name || null,
              p.name_hi || null,
              p.monthly_fee != null ? Number(p.monthly_fee) : null,
              p.yearly_fee != null ? Number(p.yearly_fee) : null,
              p.max_shops != null ? Number(p.max_shops) : null,
              p.popular != null ? (p.popular ? 1 : 0) : null,
              p.is_active != null ? (p.is_active ? 1 : 0) : null,
              p.id
            ]
          );
        } else {
          execute(
            `INSERT INTO subscription_plans (id, name, name_hi, monthly_fee, yearly_fee, max_shops, description, description_en, features_hi, features_en, popular, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              p.id,
              p.name || p.id,
              p.name_hi || p.name || p.id,
              Number(p.monthly_fee || 999),
              Number(p.yearly_fee || 9999),
              Number(p.max_shops || 100),
              p.description || '',
              p.description_en || '',
              typeof p.features_hi === 'string' ? p.features_hi : JSON.stringify(p.features_hi || []),
              typeof p.features_en === 'string' ? p.features_en : JSON.stringify(p.features_en || []),
              p.popular ? 1 : 0,
              p.is_active !== undefined ? (p.is_active ? 1 : 0) : 1,
              new Date().toISOString()
            ]
          );
        }
      }
      saveToDisk();
    }
    res.json({ success: true, message: 'सब्सक्रिप्शन प्लान सफलतापूर्वक सिंक हो गए (Plans synced successfully)' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Automatic Server-Boot Hydration from Primary Firebase Firestore Cloud
export async function hydrateServerFromFirestore(): Promise<void> {
  try {
    const fb = await import('../services/firebase.ts');
    const [plans, generalSettings, distributors, shops, products, subPayments, orders, payments] = await Promise.all([
      fb.getSubscriptionPlansFromFirestore().catch(() => []),
      fb.getSettingsFromFirestore().catch(() => null),
      fb.getDistributorsFromFirestore().catch(() => []),
      fb.getShopsFromFirestore().catch(() => []),
      fb.getProductsFromFirestore().catch(() => []),
      fb.getSubscriptionPaymentsFromFirestore().catch(() => []),
      fb.getOrdersFromFirestore().catch(() => []),
      fb.getPaymentsFromFirestore().catch(() => []),
    ]);

    // 1. Restore Subscription Plans
    if (Array.isArray(plans) && plans.length > 0) {
      for (const p of plans) {
        if (!p.id) continue;
        const exists = queryOne<any>('SELECT id FROM subscription_plans WHERE id = ?', [p.id]);
        if (exists) {
          execute(
            `UPDATE subscription_plans SET
              name = COALESCE(?, name),
              name_hi = COALESCE(?, name_hi),
              monthly_fee = COALESCE(?, monthly_fee),
              yearly_fee = COALESCE(?, yearly_fee),
              max_shops = COALESCE(?, max_shops),
              popular = COALESCE(?, popular),
              is_active = COALESCE(?, is_active)
             WHERE id = ?`,
            [
              p.name || null,
              p.name_hi || null,
              p.monthly_fee != null ? Number(p.monthly_fee) : null,
              p.yearly_fee != null ? Number(p.yearly_fee) : null,
              p.max_shops != null ? Number(p.max_shops) : null,
              p.popular != null ? (p.popular ? 1 : 0) : null,
              p.is_active != null ? (p.is_active ? 1 : 0) : null,
              p.id,
            ]
          );
        } else {
          execute(
            `INSERT INTO subscription_plans (id, name, name_hi, monthly_fee, yearly_fee, max_shops, description, description_en, features_hi, features_en, popular, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              p.id,
              p.name || p.id,
              p.name_hi || p.name || p.id,
              Number(p.monthly_fee || 999),
              Number(p.yearly_fee || 9990),
              Number(p.max_shops || 100),
              p.description || '',
              p.description_en || '',
              typeof p.features_hi === 'string' ? p.features_hi : JSON.stringify(p.features_hi || []),
              typeof p.features_en === 'string' ? p.features_en : JSON.stringify(p.features_en || []),
              p.popular ? 1 : 0,
              p.is_active !== undefined ? (p.is_active ? 1 : 0) : 1,
              new Date().toISOString(),
            ]
          );
        }
      }
    }

    // 2. Restore Platform Settings
    if (generalSettings && typeof generalSettings === 'object') {
      const settingKeys = ['platform_upi_id', 'platform_qr_image', 'platform_owner_name', 'cutoff_time', 'allow_late_orders'];
      for (const k of settingKeys) {
        if (generalSettings[k] !== undefined && generalSettings[k] !== null) {
          const val = String(generalSettings[k]);
          execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [k, val, val]);
        }
      }
    }

    // 3. Restore Distributors & their Scoped Settings
    const demoDelSetting = queryOne<any>("SELECT value FROM settings WHERE key = 'demo_deleted'");
    const isDemoDeletedSetting = demoDelSetting?.value === '1';

    if (Array.isArray(distributors)) {
      for (const d of distributors) {
        try {
          const cleanMobile = String(d.mobile || d.id || '').trim().replace(/\D/g, '');
          if (!cleanMobile || cleanMobile.length < 10) continue;
          if (isDemoDeletedSetting && (cleanMobile === '9876543210' || d.is_demo === 1 || String(d.business_name || '').includes('श्री गणेश'))) continue;
          if (d.subscription_status === 'deleted' || d.is_deleted === 1 || d.is_deleted === true || d.is_deleted === '1' || d.is_deleted === 'true') continue;

          const mob10 = cleanMobile.slice(-10);
          const distExists = queryOne<any>(
            'SELECT id, subscription_status, is_deleted FROM distributors WHERE mobile = ? OR mobile = ?',
            [cleanMobile, mob10]
          );
          if (distExists && (distExists.subscription_status === 'deleted' || distExists.is_deleted === 1)) continue;

          const isSuspended = distExists?.subscription_status === 'suspended' || d.subscription_status === 'suspended';
          const targetActiveStatus = isSuspended ? 0 : 1;
          const targetSubscriptionStatus = isSuspended ? 'suspended' : (d.subscription_status || 'active');

          const exists = queryOne<any>('SELECT id, password_hash FROM users WHERE mobile = ?', [cleanMobile]);
          let userId = exists?.id;
          const cloudUser = !exists?.password_hash && !d.password_hash ? await fb.findUserInFirestore(cleanMobile).catch(() => null) : null;
          const rawPinOrHash = String(d.password_hash || cloudUser?.password_hash || d.login_pin || d.pin || d.password || '').trim();
          const finalPasswordHash = rawPinOrHash
            ? (rawPinOrHash.startsWith('enc:gcm:') ? rawPinOrHash : hashPin(rawPinOrHash))
            : (exists?.password_hash || hashPin('1234'));

          let targetEmail = d.email ? String(d.email).trim().toLowerCase() : `${cleanMobile}@wholesale.com`;
          const emailCheck = queryOne<any>('SELECT id FROM users WHERE email = ? AND mobile != ?', [targetEmail, cleanMobile]);
          if (emailCheck) targetEmail = `${cleanMobile}@wholesale.com`;

          if (!userId) {
            const uRes = execute(
              `INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
               VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
              [d.owner_name || d.business_name || 'Distributor', cleanMobile, targetEmail, finalPasswordHash, targetActiveStatus, d.created_at || new Date().toISOString()]
            );
            userId = uRes.lastInsertRowid;
          } else {
            execute(
              `UPDATE users SET name = ?, password_hash = COALESCE(?, password_hash), active_status = ? WHERE id = ?`,
              [d.owner_name || d.business_name || 'Distributor', rawPinOrHash ? finalPasswordHash : null, targetActiveStatus, userId]
            );
          }

          let finalDistId = distExists?.id;
          if (!distExists) {
            const candidateDistId = d.id && Number(d.id) > 0 && Number(d.id) < 1000000000 ? Number(d.id) : null;
            const distIdTaken = candidateDistId ? queryOne<any>('SELECT id FROM distributors WHERE id = ?', [candidateDistId]) : null;
            const explicitDistId = candidateDistId && !distIdTaken ? candidateDistId : null;
            const dRes = execute(
              `INSERT INTO distributors (id, user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                explicitDistId,
                userId,
                d.business_name || 'Distributor',
                d.owner_name || 'Owner',
                cleanMobile,
                targetEmail,
                d.city || 'City',
                d.address || '',
                d.plan_name || 'Growth Pro',
                Number(d.monthly_fee) || 1999,
                targetSubscriptionStatus,
                d.subscription_start_date || getISTDateStr(),
                d.subscription_renewal_date || getISTDateStr(new Date(Date.now() + 30 * 86400000)),
                Number(d.max_shops) || 100,
                d.payment_status || 'paid',
                d.notes || '',
                d.created_at || new Date().toISOString(),
              ]
            );
            finalDistId = explicitDistId || dRes.lastInsertRowid;
          } else {
            execute(
              `UPDATE distributors SET
                business_name = ?, owner_name = ?, city = ?, address = COALESCE(?, address),
                subscription_status = ?, plan_name = COALESCE(?, plan_name), monthly_fee = COALESCE(?, monthly_fee),
                subscription_renewal_date = COALESCE(?, subscription_renewal_date), max_shops = COALESCE(?, max_shops),
                payment_status = COALESCE(?, payment_status)
               WHERE id = ?`,
              [
                d.business_name || distExists.business_name || 'Distributor',
                d.owner_name || distExists.owner_name || 'Owner',
                d.city || distExists.city || 'City',
                d.address || null,
                targetSubscriptionStatus,
                d.plan_name || null,
                d.monthly_fee != null ? Number(d.monthly_fee) : null,
                d.subscription_renewal_date || null,
                d.max_shops != null ? Number(d.max_shops) : null,
                d.payment_status || null,
                distExists.id,
              ]
            );
          }

          if (finalDistId) {
            const distSett = await fb.getSettingsFromFirestore(finalDistId).catch(() => null);
            const mergedSett = { ...(d || {}), ...(distSett || {}) };
            const distKeys = ['cutoff_time', 'allow_late_orders', 'distributor_name', 'distributor_mobile', 'distributor_upi', 'distributor_qr_image'];
            for (const dk of distKeys) {
              if (mergedSett[dk] !== undefined && mergedSett[dk] !== null) {
                const sKey = `${dk}_${finalDistId}`;
                const sVal = String(mergedSett[dk]);
                execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [sKey, sVal, sVal]);
              }
            }
          }
        } catch (e) {}
      }
    }

    // 4. Restore Shops
    if (Array.isArray(shops)) {
      for (const s of shops) {
        try {
          if ((!s.mobile && !s.shop_code) || s.active_status === 0 || s.is_deleted || !s.distributor_id) continue;
          const distRow = queryOne<any>('SELECT id, subscription_status, is_deleted FROM distributors WHERE id = ? OR mobile = ?', [Number(s.distributor_id) || 0, String(s.distributor_id).replace(/\D/g, '')]);
          if (!distRow || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) continue;

          const exists = queryOne<any>('SELECT id, password_hash FROM users WHERE mobile = ?', [s.mobile]);
          let userId = exists?.id;
          const cloudUser = !exists?.password_hash && !s.password_hash ? await fb.findUserInFirestore(s.mobile).catch(() => null) : null;
          const rawShopPinOrHash = String(s.password_hash || cloudUser?.password_hash || s.login_pin || s.pin || s.password || '').trim();
          const finalShopHash = rawShopPinOrHash
            ? (rawShopPinOrHash.startsWith('enc:gcm:') ? rawShopPinOrHash : hashPin(rawShopPinOrHash))
            : (exists?.password_hash || hashPin('1234'));

          if (!userId) {
            const uRes = execute(
              `INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
               VALUES (?, ?, ?, 'retailer', ?, 1, ?)`,
              [s.owner_name || s.shop_name, s.mobile, s.email || `${s.mobile}@retailer.com`, finalShopHash, s.created_at || new Date().toISOString()]
            );
            userId = uRes.lastInsertRowid;
          } else {
            execute(
              'UPDATE users SET name = ?, password_hash = COALESCE(?, password_hash), active_status = 1 WHERE id = ?',
              [s.owner_name || s.shop_name, rawShopPinOrHash ? finalShopHash : null, userId]
            );
          }

          const shopExists = queryOne<any>('SELECT id, is_deleted, active_status, COALESCE(is_demo, 0) as is_demo FROM shops WHERE shop_code = ?', [s.shop_code]);
          if (shopExists && !shopExists.is_demo && (shopExists.is_deleted === 1 || shopExists.active_status === 0)) continue;
          if (!shopExists) {
            const candidateShopId = s.id && Number(s.id) > 0 && Number(s.id) < 1000000000 ? Number(s.id) : null;
            const shopIdTaken = candidateShopId ? queryOne<any>('SELECT id FROM shops WHERE id = ?', [candidateShopId]) : null;
            const explicitShopId = candidateShopId && !shopIdTaken ? candidateShopId : null;
            execute(
              `INSERT INTO shops (id, shop_code, shop_name, owner_name, mobile, address, area, route, assigned_user_id, distributor_id, active_status, is_demo, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
              [
                explicitShopId,
                s.shop_code,
                s.shop_name,
                s.owner_name || s.shop_name,
                s.mobile,
                s.address || '',
                s.area || '',
                s.route || 'Route 1',
                userId,
                distRow.id,
                s.is_demo ? 1 : 0,
                s.created_at || new Date().toISOString(),
              ]
            );
          } else {
            execute(
              'UPDATE shops SET shop_name = ?, owner_name = ?, mobile = ?, address = ?, area = ?, route = ?, distributor_id = ?, assigned_user_id = ?, active_status = 1, is_deleted = 0, is_demo = ? WHERE id = ?',
              [
                s.shop_name,
                s.owner_name || s.shop_name,
                s.mobile,
                s.address || '',
                s.area || '',
                s.route || 'Route 1',
                distRow.id,
                userId,
                s.is_demo ? 1 : 0,
                shopExists.id,
              ]
            );
          }
        } catch (e) {}
      }
    }

    // 5. Restore Products
    if (Array.isArray(products)) {
      for (const p of products) {
        try {
          if ((!p.name_english && !p.name_hindi) || p.active_status === 0 || p.is_deleted) continue;
          const pDistId = p.distributor_id ? Number(p.distributor_id) : null;
          if (!pDistId) continue;
          const distRow = queryOne<any>('SELECT id, subscription_status, is_deleted FROM distributors WHERE id = ?', [pDistId]);
          if (!distRow || distRow.subscription_status === 'deleted' || distRow.is_deleted === 1) continue;

          const pExists = queryOne<any>('SELECT id, active_status, is_deleted FROM products WHERE (name_english = ? OR name_hindi = ? OR id = ?) AND distributor_id = ?', [p.name_english, p.name_hindi, p.id || -1, pDistId]);
          if (pExists && (pExists.is_deleted === 1 || pExists.active_status === 0)) continue;
          if (!pExists) {
            const candidateProdId = p.id && Number(p.id) > 0 && Number(p.id) < 1000000000 ? Number(p.id) : null;
            const prodIdTaken = candidateProdId ? queryOne<any>('SELECT id FROM products WHERE id = ?', [candidateProdId]) : null;
            const explicitProdId = candidateProdId && !prodIdTaken ? candidateProdId : null;
            execute(
              `INSERT INTO products (id, distributor_id, name_english, name_hindi, category, unit, price, minimum_quantity, stock_available, active_status, display_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                explicitProdId,
                pDistId,
                p.name_english || p.name || 'Product',
                p.name_hindi || p.name_english || 'उत्पाद',
                p.category || 'Dairy',
                p.unit || 'pkt',
                p.price || 0,
                p.minimum_quantity || 0,
                p.stock_available ?? 1,
                p.active_status ?? 1,
                p.display_order || 0,
              ]
            );
          }
        } catch (e) {}
      }
    }

    // 6. Restore Subscription Payments
    if (Array.isArray(subPayments)) {
      for (const sp of subPayments) {
        try {
          const targetDistId = Number(sp.distributor_id);
          if (!targetDistId || !sp.amount) continue;
          const distExists = queryOne<any>('SELECT id FROM distributors WHERE id = ?', [targetDistId]);
          if (!distExists) continue;
          const rawRef = String(sp.reference_no || '').trim();
          const refNo = !rawRef || rawRef === 'SUB-NEW-REG' ? `SUB-NEW-REG-${targetDistId}` : rawRef;
          const existingPay =
            rawRef && rawRef !== 'SUB-NEW-REG'
              ? queryOne<any>('SELECT id, status, notes FROM subscription_payments WHERE reference_no = ?', [rawRef])
              : queryOne<any>(
                  'SELECT id, status, notes FROM subscription_payments WHERE distributor_id = ? AND (reference_no = ? OR (payment_date = ? AND amount = ?))',
                  [targetDistId, refNo, sp.payment_date, sp.amount]
                );
          if (existingPay) {
            if ((sp.status && existingPay.status !== sp.status) || (sp.notes && existingPay.notes !== sp.notes)) {
              execute(
                'UPDATE subscription_payments SET status = COALESCE(?, status), notes = COALESCE(?, notes), period_end = COALESCE(?, period_end) WHERE id = ?',
                [sp.status || null, sp.notes || null, sp.period_end || null, existingPay.id]
              );
            }
          } else {
            execute(
              `INSERT INTO subscription_payments (distributor_id, amount, payment_date, period_start, period_end, payment_mode, reference_no, notes, status, duration_months, plan_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                targetDistId,
                Number(sp.amount),
                sp.payment_date || getISTDateStr(),
                sp.period_start || sp.payment_date || getISTDateStr(),
                sp.period_end || sp.payment_date || getISTDateStr(),
                sp.payment_mode || 'UPI',
                refNo,
                sp.notes || '',
                sp.status || 'approved',
                Number(sp.duration_months) || 1,
                sp.plan_name || 'Growth Pro',
                sp.created_at || new Date().toISOString(),
              ]
            );
          }
        } catch (e) {}
      }
    }

    // 7. Restore Orders & Order Items
    if (Array.isArray(orders)) {
      for (const ord of orders) {
        try {
          if (!ord.order_number) continue;
          const orderNum = String(ord.order_number).trim();
          if (orderNum.match(/^ORD-\d{10,14}$/) && (!ord.shop_id || !ord.order_date)) continue;
          let targetShopId = ord.shop_id ? Number(ord.shop_id) : null;
          if (!targetShopId && ord.shop_code) {
            const shRow = queryOne<any>('SELECT id FROM shops WHERE UPPER(shop_code) = ?', [String(ord.shop_code).toUpperCase()]);
            if (shRow) targetShopId = shRow.id;
          }
          if (!targetShopId) continue;
          const shopCheck = queryOne<any>('SELECT id, assigned_user_id FROM shops WHERE id = ?', [targetShopId]);
          if (!shopCheck) continue;

          const existingOrd = queryOne<any>('SELECT id, status, total_amount FROM orders WHERE order_number = ?', [orderNum]);
          if (existingOrd) {
            const statusChanged = ord.status && ord.status !== existingOrd.status;
            const totalChanged = ord.total_amount != null && Number(ord.total_amount) !== Number(existingOrd.total_amount);
            if (statusChanged || totalChanged || (Array.isArray(ord.items) && ord.items.length > 0)) {
              withTransaction(() => {
                if (statusChanged || totalChanged) {
                  execute(
                    'UPDATE orders SET status = COALESCE(?, status), subtotal = COALESCE(?, subtotal), total_amount = COALESCE(?, total_amount), notes = COALESCE(?, notes), confirmed_at = COALESCE(?, confirmed_at), delivered_at = COALESCE(?, delivered_at), updated_at = ? WHERE id = ?',
                    [
                      ord.status || null,
                      ord.subtotal != null ? Number(ord.subtotal) : null,
                      ord.total_amount != null ? Number(ord.total_amount) : null,
                      ord.notes != null ? String(ord.notes) : null,
                      ord.confirmed_at || null,
                      ord.delivered_at || null,
                      ord.updated_at || new Date().toISOString(),
                      existingOrd.id,
                    ]
                  );
                }
                if (Array.isArray(ord.items) && ord.items.length > 0) {
                  const validItems: any[] = [];
                  for (const it of ord.items) {
                    const pId = Number(it.product_id);
                    if (!pId) continue;
                    const prodRow = queryOne<any>('SELECT id, price FROM products WHERE id = ?', [pId]);
                    if (!prodRow) continue;
                    const ordQty = Number(it.ordered_quantity || it.quantity || 0);
                    const delQty = Number(it.delivered_quantity || 0);
                    let uPrice = Number(it.unit_price || it.price || 0);
                    if (uPrice <= 0 && prodRow.price) uPrice = Number(prodRow.price);
                    const lTotal = Number(it.line_total || Math.round(uPrice * ordQty * 100) / 100);
                    validItems.push([existingOrd.id, pId, ordQty, delQty, uPrice, lTotal]);
                  }
                  if (validItems.length > 0) {
                    execute('DELETE FROM order_items WHERE order_id = ?', [existingOrd.id]);
                    for (const vi of validItems) {
                      execute(
                        `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        vi
                      );
                    }
                  }
                }
              });
            }
          } else {
            const ordDate = ord.order_date || getISTDateStr();
            const now = ord.created_at || new Date().toISOString();
            const totalAmt = Number(ord.total_amount) || 0;
            const subtotalAmt = Number(ord.subtotal) || totalAmt;

            const rawCreatedBy = ord.created_by ? Number(ord.created_by) : 0;
            const validUserRow = rawCreatedBy > 0 ? queryOne<any>('SELECT id FROM users WHERE id = ?', [rawCreatedBy]) : null;
            const fallbackUserRow = (!validUserRow && !shopCheck.assigned_user_id) ? queryOne<any>('SELECT id FROM users ORDER BY id ASC LIMIT 1') : null;
            const createdById = validUserRow?.id || shopCheck.assigned_user_id || fallbackUserRow?.id || 1;

            const candidateOrdId = ord.id && Number(ord.id) > 0 && Number(ord.id) < 1000000000 ? Number(ord.id) : null;
            const ordIdTaken = candidateOrdId ? queryOne<any>('SELECT id FROM orders WHERE id = ?', [candidateOrdId]) : null;
            const explicitOrdId = candidateOrdId && !ordIdTaken ? candidateOrdId : null;

            withTransaction(() => {
              const res = execute(
                `INSERT INTO orders (id, order_number, shop_id, created_by, order_date, status, subtotal, total_amount, cutoff_status, notes, created_at, updated_at, confirmed_at, delivered_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  explicitOrdId,
                  orderNum,
                  targetShopId,
                  createdById,
                  ordDate,
                  ord.status || 'Pending',
                  subtotalAmt,
                  totalAmt,
                  ord.cutoff_status || 'on_time',
                  ord.notes || '',
                  now,
                  ord.updated_at || now,
                  ord.confirmed_at || null,
                  ord.delivered_at || null,
                ]
              );
              const newOrdId = explicitOrdId || res.lastInsertRowid;
              if (Array.isArray(ord.items) && ord.items.length > 0 && newOrdId) {
                for (const it of ord.items) {
                  const pId = Number(it.product_id);
                  if (!pId) continue;
                  const prodRow = queryOne<any>('SELECT id, price FROM products WHERE id = ?', [pId]);
                  if (!prodRow) continue;
                  const ordQty = Number(it.ordered_quantity || it.quantity || 0);
                  const delQty = Number(it.delivered_quantity || 0);
                  let uPrice = Number(it.unit_price || it.price || 0);
                  if (uPrice <= 0 && prodRow.price) uPrice = Number(prodRow.price);
                  const lTotal = Number(it.line_total || Math.round(uPrice * ordQty * 100) / 100);
                  execute(
                    `INSERT INTO order_items (order_id, product_id, ordered_quantity, delivered_quantity, unit_price, line_total)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [newOrdId, pId, ordQty, delQty, uPrice, lTotal]
                  );
                }
              }
            });
          }
        } catch (e) {}
      }
    }

    // 8. Restore Shop Payments
    if (Array.isArray(payments)) {
      for (const py of payments) {
        try {
          if (!py.shop_id || py.amount == null) continue;
          const targetShopId = Number(py.shop_id);
          const shopRow = queryOne<any>('SELECT id FROM shops WHERE id = ?', [targetShopId]);
          if (!shopRow) continue;
          const pyAmount = Number(py.amount);
          const pyDate = py.payment_date || getISTDateStr();
          const pyNotes = py.notes || '';
          const pyStatus = py.status || 'approved';
          const rawOrderId = py.order_id ? Number(py.order_id) : null;
          const validOrdRow = rawOrderId ? queryOne<any>('SELECT id FROM orders WHERE id = ?', [rawOrderId]) : null;
          const pyOrderId = validOrdRow ? validOrdRow.id : null;

          const existingPay = (py.id && Number(py.id) > 0 ? queryOne<any>('SELECT id, status, notes FROM payments WHERE id = ?', [Number(py.id)]) : null)
            || queryOne<any>('SELECT id, status, notes FROM payments WHERE shop_id = ? AND payment_date = ? AND amount = ? AND notes = ?', [targetShopId, pyDate, pyAmount, pyNotes])
            || queryOne<any>('SELECT id, status, notes FROM payments WHERE shop_id = ? AND payment_date = ? AND amount = ? AND payment_mode = ?', [targetShopId, pyDate, pyAmount, py.payment_mode || 'Cash']);
          if (existingPay) {
            if ((pyStatus && existingPay.status !== pyStatus) || (pyNotes && existingPay.notes !== pyNotes)) {
              execute('UPDATE payments SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?', [pyStatus || null, pyNotes || null, existingPay.id]);
            }
          } else {
            execute(
              `INSERT INTO payments (id, shop_id, order_id, amount, payment_date, payment_mode, notes, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                py.id && Number(py.id) > 0 ? Number(py.id) : null,
                targetShopId,
                pyOrderId,
                pyAmount,
                pyDate,
                py.payment_mode || 'Cash',
                pyNotes,
                pyStatus,
                py.created_at || new Date().toISOString(),
              ]
            );
          }
        } catch (e) {}
      }
    }

    saveToDisk();
    console.log('✓ Primary Firestore Cloud state hydrated into local SQLite engine');
  } catch (err) {
    console.warn('[Firestore Boot Hydration] Skipped or partial:', err);
  }
}


