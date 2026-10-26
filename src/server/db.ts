import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let dbInstance: Database | null = null;
const ROOT_DB_FILE = path.resolve(process.cwd(), 'vedirtsetu.sqlite');
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'dairy.sqlite');

const LEGACY_SECRET = 'vedirt_super_secure_master_key_8700320804';
const BUNDLED_DB_SECRET = 'e08b9e0e3a197d14df05ae892b88eb00a05bc19cff3df6c37bdbc81c8ac239c8';
const LEGACY_KEY = crypto.createHash('sha256').update(LEGACY_SECRET).digest();
const BUNDLED_DB_KEY = crypto.createHash('sha256').update(BUNDLED_DB_SECRET).digest();

let cachedServerSecret: string | null = null;

/**
 * Get or initialize deterministic server secret for token signing and PIN encryption.
 * Ensures that even if a container wipes local SQLite and restores from Firestore, the exact same key is used.
 */
export function getServerSecret(): string {
  const canonicalSecret = process.env.JWT_SECRET || LEGACY_SECRET;
  if (cachedServerSecret) return cachedServerSecret;
  if (!dbInstance) {
    return canonicalSecret;
  }
  try {
    const res = dbInstance.exec("SELECT value FROM settings WHERE key = 'server_jwt_secret';");
    const val = res[0]?.values[0]?.[0] as string;
    if (val !== canonicalSecret) {
      dbInstance.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('server_jwt_secret', ?);", [canonicalSecret]);
    }
    cachedServerSecret = canonicalSecret;
    return canonicalSecret;
  } catch (e) {
    return canonicalSecret;
  }
}

function getPinKey(): Buffer {
  const secret = process.env.PIN_SECRET || getServerSecret();
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext PIN or password using AES-256-GCM.
 * Output format: enc:gcm:<iv_hex>:<authTag_hex>:<cipher_hex>
 */
export function hashPin(plainPin: string): string {
  if (!plainPin) return '';
  const str = String(plainPin).trim();
  if (str.startsWith('enc:gcm:')) return str;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getPinKey(), iv);
  let encrypted = cipher.update(str, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:gcm:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted PIN/password. Returns plaintext as-is if legacy unencrypted.
 * Supports fallback to legacy key and bundled DB key for zero-downtime key unification.
 */
export function decryptPin(storedValue: string): string {
  if (!storedValue) return '';
  const str = String(storedValue).trim();
  if (!str.startsWith('enc:gcm:')) return str;
  try {
    const parts = str.split(':');
    if (parts.length !== 5) return str;
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const cipherHex = parts[4];

    const candidateKeys = [getPinKey(), LEGACY_KEY, BUNDLED_DB_KEY];
    for (const key of candidateKeys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch {
        // Try next candidate key
      }
    }
    return '';
  } catch (err) {
    return '';
  }
}

/**
 * Constant-time PIN verification comparing entered PIN with stored value.
 * Supports both encrypted PINs and legacy plaintext PINs.
 */
export function verifyPin(enteredPin: string, storedValue: string): boolean {
  if (!enteredPin || !storedValue) return false;
  const cleanEntered = String(enteredPin).trim();
  const decrypted = decryptPin(storedValue);
  if (!decrypted) return false;
  const a = Buffer.from(cleanEntered);
  const b = Buffer.from(decrypted);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Migration helper: automatically encrypts all legacy plaintext passwords in users table
 * and re-encrypts any older key hashes with the canonical server key.
 */
export function migrateUserPinsToEncrypted(db: Database) {
  try {
    const res = db.exec("SELECT id, password_hash FROM users;");
    const primaryKey = getPinKey();
    if (res[0]?.values) {
      for (const row of res[0].values) {
        const id = row[0] as number;
        const pass = String(row[1] || '').trim();
        if (!pass) continue;
        if (!pass.startsWith('enc:gcm:')) {
          const encrypted = hashPin(pass);
          db.run("UPDATE users SET password_hash = ? WHERE id = ?;", [encrypted, id]);
        } else {
          // Verify if already encrypted with primaryKey; if encrypted with older key, re-encrypt with primaryKey
          let worksWithPrimary = false;
          try {
            const parts = pass.split(':');
            if (parts.length === 5) {
              const decipher = crypto.createDecipheriv('aes-256-gcm', primaryKey, Buffer.from(parts[2], 'hex'));
              decipher.setAuthTag(Buffer.from(parts[3], 'hex'));
              decipher.update(parts[4], 'hex', 'utf8');
              decipher.final('utf8');
              worksWithPrimary = true;
            }
          } catch {
            worksWithPrimary = false;
          }
          if (!worksWithPrimary) {
            const plain = decryptPin(pass);
            if (plain) {
              const reEncrypted = hashPin(plain);
              db.run("UPDATE users SET password_hash = ? WHERE id = ?;", [reEncrypted, id]);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to migrate user PINs:', err);
  }
}

export function saveToDisk() {
  if (!dbInstance) return;
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);

    if (!buffer || buffer.length === 0) return;

    // 1. Primary: Atomic safe write to project root via temporary file
    const rootTmp = `${ROOT_DB_FILE}.tmp`;
    try {
      fs.writeFileSync(rootTmp, buffer);
      fs.renameSync(rootTmp, ROOT_DB_FILE);
    } catch {
      fs.writeFileSync(ROOT_DB_FILE, buffer);
    }

    // 2. Secondary: Atomic safe write in data/ for backward compatibility
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const dbTmp = `${DB_FILE}.tmp`;
    try {
      fs.writeFileSync(dbTmp, buffer);
      fs.renameSync(dbTmp, DB_FILE);
    } catch {
      fs.writeFileSync(DB_FILE, buffer);
    }
  } catch (err) {
    console.error('Failed to persist database to disk:', err);
  }
}

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  const SQL = await initSqlJs();

  let loadedBuffer: Buffer | null = null;
  // Load from root file first, then fallback to data/ directory
  if (fs.existsSync(ROOT_DB_FILE)) {
    try {
      const buf = fs.readFileSync(ROOT_DB_FILE);
      if (buf && buf.length >= 100) loadedBuffer = buf;
    } catch (e) {
      console.warn('Error reading ROOT_DB_FILE:', e);
    }
  }

  if (!loadedBuffer && fs.existsSync(DB_FILE)) {
    try {
      const buf = fs.readFileSync(DB_FILE);
      if (buf && buf.length >= 100) loadedBuffer = buf;
    } catch (e) {
      console.warn('Error reading DB_FILE:', e);
    }
  }

  if (loadedBuffer) {
    try {
      dbInstance = new SQL.Database(loadedBuffer);
    } catch (e) {
      console.warn('Existing db file corrupted, creating fresh database:', e);
      dbInstance = new SQL.Database();
    }
  } else {
    dbInstance = new SQL.Database();
  }

  initTablesAndSeed(dbInstance);
  return dbInstance;
}

function initTablesAndSeed(db: Database) {
  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('superadmin', 'admin', 'retailer')),
      password_hash TEXT NOT NULL,
      active_status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      created_by_admin INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS distributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      mobile TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT DEFAULT '',
      plan_name TEXT NOT NULL DEFAULT 'Growth Pro',
      monthly_fee REAL NOT NULL DEFAULT 1999,
      subscription_status TEXT NOT NULL DEFAULT 'active' CHECK(subscription_status IN ('active', 'trial', 'expired', 'suspended', 'deleted')),
      subscription_start_date TEXT NOT NULL,
      subscription_renewal_date TEXT NOT NULL,
      max_shops INTEGER NOT NULL DEFAULT 100,
      payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('paid', 'due', 'overdue', 'pending_verification')),
      notes TEXT DEFAULT '',
      is_demo INTEGER DEFAULT 0,
      created_by_admin INTEGER,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscription_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      distributor_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      reference_no TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      duration_months INTEGER DEFAULT 1,
      plan_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (distributor_id) REFERENCES distributors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_code TEXT NOT NULL UNIQUE,
      shop_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      address TEXT NOT NULL,
      area TEXT NOT NULL,
      route TEXT NOT NULL,
      assigned_user_id INTEGER NOT NULL,
      distributor_id INTEGER,
      active_status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      distributor_id INTEGER,
      name_english TEXT NOT NULL,
      name_hindi TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL,
      minimum_quantity INTEGER NOT NULL DEFAULT 0,
      stock_available INTEGER NOT NULL DEFAULT 1,
      active_status INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      shop_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Pending', 'Confirmed', 'Packed', 'Partially Delivered', 'Delivered', 'Cancelled')),
      subtotal REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      cutoff_status TEXT NOT NULL DEFAULT 'on_time' CHECK(cutoff_status IN ('on_time', 'late', 'exempt')),
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      delivered_at TEXT,
      FOREIGN KEY (shop_id) REFERENCES shops(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      ordered_quantity INTEGER NOT NULL,
      delivered_quantity INTEGER NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      order_id INTEGER,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      payment_mode TEXT NOT NULL CHECK(payment_mode IN ('Cash', 'UPI', 'Cheque', 'Bank Transfer')),
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      created_at TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_status INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shop_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      custom_price REAL NOT NULL,
      UNIQUE(shop_id, product_id),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shop_regular_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      UNIQUE(shop_id, product_id),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_shop_id ON payments(shop_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_sub_payments_dist_id ON subscription_payments(distributor_id);
    CREATE INDEX IF NOT EXISTS idx_sub_payments_ref ON subscription_payments(reference_no);
    CREATE INDEX IF NOT EXISTS idx_sub_payments_status ON subscription_payments(status);
    CREATE INDEX IF NOT EXISTS idx_outbox_status_retry ON outbox(status, retry_count);
    CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox(created_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_entity ON outbox(entity_type, entity_id);
  `);

  // 1. Ensure columns exist first via PRAGMA check before running any table constraint migrations
  function ensureCol(tbl: string, col: string, def: string) {
    try {
      const info = db.exec(`PRAGMA table_info(${tbl});`);
      const cols = (info[0]?.values || []).map((v: any) => v[1]);
      if (cols.length > 0 && !cols.includes(col)) {
        db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def};`);
      }
    } catch (e) {}
  }
  ensureCol('shops', 'distributor_id', 'INTEGER');
  ensureCol('products', 'distributor_id', 'INTEGER');
  ensureCol('distributors', 'is_deleted', 'INTEGER DEFAULT 0');
  ensureCol('distributors', 'is_demo', 'INTEGER DEFAULT 0');
  ensureCol('distributors', 'created_by_admin', 'INTEGER');
  ensureCol('distributors', 'plan_name', "TEXT DEFAULT 'Growth Pro'");
  ensureCol('users', 'is_deleted', 'INTEGER DEFAULT 0');
  ensureCol('users', 'is_demo', 'INTEGER DEFAULT 0');
  ensureCol('users', 'created_by_admin', 'INTEGER');
  ensureCol('shops', 'is_deleted', 'INTEGER DEFAULT 0');
  ensureCol('shops', 'is_demo', 'INTEGER DEFAULT 0');
  ensureCol('products', 'is_deleted', 'INTEGER DEFAULT 0');
  ensureCol('subscription_payments', 'status', "TEXT DEFAULT 'approved'");
  ensureCol('subscription_payments', 'duration_months', 'INTEGER DEFAULT 1');
  ensureCol('subscription_payments', 'plan_name', "TEXT DEFAULT ''");
  ensureCol('payments', 'status', "TEXT DEFAULT 'approved'");

  // 1a. Check constraint migration for users (if existing db only allowed 'admin', 'retailer')
  try {
    db.run("INSERT INTO users (id, name, mobile, email, role, password_hash, active_status, created_at) VALUES (-999, 'tmp', '0000000000', 'tmp@tmp.com', 'superadmin', 'tmp', 0, '2026-01-01');");
    db.run("DELETE FROM users WHERE id = -999;");
  } catch (e) {
    db.run(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE IF NOT EXISTS users_temp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('superadmin', 'admin', 'retailer')),
        password_hash TEXT NOT NULL,
        active_status INTEGER NOT NULL DEFAULT 1,
        is_deleted INTEGER DEFAULT 0,
        is_demo INTEGER DEFAULT 0,
        created_by_admin INTEGER,
        created_at TEXT NOT NULL
      );
      INSERT INTO users_temp (id, name, mobile, email, role, password_hash, active_status, is_deleted, is_demo, created_by_admin, created_at)
        SELECT id, name, mobile, email, role, password_hash, active_status, COALESCE(is_deleted, 0), COALESCE(is_demo, 0), created_by_admin, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_temp RENAME TO users;
      PRAGMA foreign_keys = ON;
    `);
  }

  // 1b. Check constraint migration for distributors (allow 'deleted' status & 'pending_verification' payment_status)
  try {
    db.run("INSERT INTO distributors (id, user_id, business_name, owner_name, mobile, email, city, subscription_status, payment_status, subscription_start_date, subscription_renewal_date, created_at) VALUES (-999, 1, 'tmp', 'tmp', '0000000000', 'tmp@tmp.com', 'tmp', 'deleted', 'pending_verification', '2026-01-01', '2026-01-01', '2026-01-01');");
    db.run("DELETE FROM distributors WHERE id = -999;");
  } catch (e) {
    try {
      db.run(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE IF NOT EXISTS distributors_temp (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          business_name TEXT NOT NULL,
          owner_name TEXT NOT NULL,
          mobile TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL,
          city TEXT NOT NULL,
          address TEXT DEFAULT '',
          plan_name TEXT NOT NULL DEFAULT 'Growth Pro',
          monthly_fee REAL NOT NULL DEFAULT 1999,
          subscription_status TEXT NOT NULL DEFAULT 'active' CHECK(subscription_status IN ('active', 'trial', 'expired', 'suspended', 'deleted')),
          subscription_start_date TEXT NOT NULL,
          subscription_renewal_date TEXT NOT NULL,
          max_shops INTEGER NOT NULL DEFAULT 100,
          payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('paid', 'due', 'overdue', 'pending_verification')),
          notes TEXT DEFAULT '',
          is_demo INTEGER DEFAULT 0,
          created_by_admin INTEGER,
          is_deleted INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );
        INSERT INTO distributors_temp (id, user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, is_demo, created_by_admin, is_deleted, created_at)
          SELECT id, user_id, business_name, owner_name, mobile, email, city, address, plan_name, monthly_fee, subscription_status, subscription_start_date, subscription_renewal_date, max_shops, payment_status, notes, COALESCE(is_demo, 0), created_by_admin, COALESCE(is_deleted, 0), created_at FROM distributors;
        DROP TABLE distributors;
        ALTER TABLE distributors_temp RENAME TO distributors;
        PRAGMA foreign_keys = ON;
      `);
    } catch (migErr) {
      console.warn('Distributors table migration note:', migErr);
    }
  }

  // 2. Set default distributor_id where NULL
  try {
    db.run("UPDATE shops SET distributor_id = 1 WHERE distributor_id IS NULL;");
  } catch (e) {}
  try {
    db.run("UPDATE products SET distributor_id = 1 WHERE distributor_id IS NULL;");
  } catch (e) {}

  // 3. Superadmin Account Setup - Configurable via environment with safe defaults
  const now = new Date().toISOString();
  try {
    const SUPERADMIN_MOBILE = process.env.SUPERADMIN_MOBILE || '8700320804';
    const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'vedirt.india@gmail.com';
    const SUPERADMIN_PASS = process.env.SUPERADMIN_PASSWORD || 'Vedirt@rich';

    // Remove any unauthorized/stale superadmin accounts
    db.run(`DELETE FROM users WHERE role = 'superadmin' AND mobile != '${SUPERADMIN_MOBILE}';`);

    const adminCheck = db.exec(`SELECT id FROM users WHERE mobile = '${SUPERADMIN_MOBILE}';`);
    const hashedSuperAdminPass = hashPin(SUPERADMIN_PASS);
    if (adminCheck[0]?.values?.length) {
      db.run(`
        UPDATE users 
        SET name = 'Platform Admin', mobile = '${SUPERADMIN_MOBILE}', email = '${SUPERADMIN_EMAIL}', password_hash = '${hashedSuperAdminPass}', role = 'superadmin', active_status = 1
        WHERE mobile = '${SUPERADMIN_MOBILE}';
      `);
    } else {
      db.run(`
        INSERT INTO users (name, mobile, email, role, password_hash, active_status, created_at)
        VALUES ('Platform Admin', '${SUPERADMIN_MOBILE}', '${SUPERADMIN_EMAIL}', 'superadmin', '${hashedSuperAdminPass}', 1, '${now}');
      `);
    }
  } catch (e) {
    console.warn('Superadmin user setup note:', e);
  }

  // 4. Create subscription_plans table if not exists
  db.run(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_hi TEXT NOT NULL,
      monthly_fee REAL NOT NULL,
      yearly_fee REAL NOT NULL,
      max_shops INTEGER NOT NULL,
      description TEXT NOT NULL,
      description_en TEXT NOT NULL,
      features_hi TEXT NOT NULL,
      features_en TEXT NOT NULL,
      popular INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);

  // 5. Ensure tracking columns exist on distributors & users
  try {
    db.run("ALTER TABLE distributors ADD COLUMN is_demo INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    db.run("ALTER TABLE distributors ADD COLUMN created_by_admin INTEGER;");
  } catch (e) {}
  try {
    db.run("ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    db.run("ALTER TABLE users ADD COLUMN created_by_admin INTEGER;");
  } catch (e) {}

  // 6. Ensure default subscription plans exist in database
  ensureSubscriptionPlans(db);
  ensureStarterData(db);
  // 7. Ensure all legacy user passwords & PINs are securely encrypted
  migrateUserPinsToEncrypted(db);

  saveToDisk();
}


function ensureStarterData(db: Database) {
  try {
    // 1. Check if database has EVER been initialized with starter seed data
    // Always normalize legacy product categories & units and clean up test artifacts before early return
    db.run("UPDATE products SET name_hindi = 'टोंड मिल्क 500ml', category = 'Dairy', unit = 'crate', price = 300, display_order = 1 WHERE id = 1 AND price = 27 AND display_order = 0;");
    db.run("UPDATE products SET category = 'Dairy' WHERE category IN ('डेयरी', 'Milk');");
    db.run("UPDATE products SET category = 'Bakery' WHERE category = 'बेकरी';");
    db.run("UPDATE products SET category = 'Grocery' WHERE category = 'राशन';");
    db.run("UPDATE products SET unit = 'pkt' WHERE unit = 'Pouch';");
    db.run("UPDATE products SET unit = 'crate' WHERE unit = 'Crates';");
    db.run("UPDATE products SET unit = 'carton' WHERE unit = 'Cartons';");
    db.run("UPDATE products SET unit = 'box' WHERE unit = 'Boxes';");
    db.run("UPDATE products SET unit = 'bag' WHERE unit = 'Bags';");
    db.run("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE notes LIKE '%Test BUG-09%' OR order_number IN ('ORD-20261023-SH-101-773', 'ORD-20261023-SH-101-869', 'ORD-20261024-SH-101-825', 'ORD-20261023-SH-101-693'));");
    db.run("DELETE FROM orders WHERE notes LIKE '%Test BUG-09%' OR order_number IN ('ORD-20261023-SH-101-773', 'ORD-20261023-SH-101-869', 'ORD-20261024-SH-101-825', 'ORD-20261023-SH-101-693');");
    db.run("DELETE FROM notifications WHERE message LIKE '%ORD-20261023-SH-101-%' OR message LIKE '%ORD-20261024-SH-101-825%';");
    db.run("DELETE FROM audit_logs WHERE created_at LIKE '2026-10-23T08:%' OR created_at LIKE '2026-10-23T09:06:%';");
    try {
      db.run("DELETE FROM outbox WHERE payload LIKE '%Test BUG-09%' OR entity_id IN ('ORD-20261023-SH-101-773', 'ORD-20261023-SH-101-869', 'ORD-20261024-SH-101-825', 'ORD-20261023-SH-101-693') OR created_at LIKE '2026-10-23T08:%' OR created_at LIKE '2026-10-23T09:06:%';");
    } catch {}

    // Permanently disable demo account seeding so 0-byte SQLite cold starts never collide with real Firestore cloud data
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('starter_seeded', '1');");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_deleted', '1');");

    // Clean up any leftover demo distributor, demo shops (SH-101..103), or demo products safely
    db.run("DELETE FROM shops WHERE is_demo = 1 AND id NOT IN (SELECT DISTINCT shop_id FROM orders WHERE shop_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT shop_id FROM payments WHERE shop_id IS NOT NULL);");
    db.run("UPDATE shops SET shop_code = shop_code || '_DEMO_DEL_' || id, active_status = 0, is_deleted = 1 WHERE is_demo = 1 AND shop_code NOT LIKE '%_DEL_%';");
    db.run("DELETE FROM products WHERE distributor_id IN (SELECT id FROM distributors WHERE is_demo = 1 OR mobile = '9876543210') AND id NOT IN (SELECT DISTINCT product_id FROM order_items WHERE product_id IS NOT NULL);");
    db.run("DELETE FROM distributors WHERE (is_demo = 1 OR mobile = '9876543210') AND id NOT IN (SELECT DISTINCT distributor_id FROM shops WHERE distributor_id IS NOT NULL);");
    db.run("DELETE FROM users WHERE is_demo = 1 AND role != 'superadmin' AND id NOT IN (SELECT DISTINCT assigned_user_id FROM shops WHERE assigned_user_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT user_id FROM distributors WHERE user_id IS NOT NULL) AND id NOT IN (SELECT DISTINCT created_by FROM orders WHERE created_by IS NOT NULL);");
    } catch (err) {
    console.warn('ensureStarterData note:', err);
  }
}

function ensureSubscriptionPlans(db: Database) {
  try {
    const check = db.exec("SELECT COUNT(*) as count FROM subscription_plans;");
    const count = check[0]?.values[0]?.[0] as number;
    if (count === 0) {
      const now = new Date().toISOString();
      const starterFeaturesHi = JSON.stringify([
        '30 दुकानों तक का नेटवर्क',
        'दैनिक कटऑफ व रूट ऑर्डर समेकन',
        '1-क्लिक व्हाट्सएप ऑर्डर पर्ची',
        'डिजिटल लेज़र व बेसिक बिलिंग'
      ]);
      const starterFeaturesEn = JSON.stringify([
        'Up to 30 Retailer Shops',
        'Daily Morning & Evening Ordering',
        'Consolidated Demand Summary',
        '1-Click WhatsApp Order Slips',
        'Basic Ledger & Billing'
      ]);

      const growthFeaturesHi = JSON.stringify([
        '100 दुकानों तक का नेटवर्क',
        'मल्टीपल डिलीवरी रूट (उत्तर, मध्य, दक्षिण)',
        'UPI QR कोड से तुरंत बकाया वसूली',
        'व्हाट्सएप ऑटोमैटिक रिमाइंडर',
        'थर्मल प्रिंटर चालान व विस्तृत लेजर'
      ]);
      const growthFeaturesEn = JSON.stringify([
        'Up to 100 Retailer Shops',
        'Multiple Delivery Routes',
        'Instant UPI QR Code Payment Collection',
        'Automated WhatsApp Reminders',
        'Full Outstanding Ledger & Thermal Slip Printing'
      ]);

      const enterpriseFeaturesHi = JSON.stringify([
        'असीमित दुकानें (500+ तक)',
        'कस्टम डिलीवरी व्हीकल रूट्स व ड्राइवर पर्चियां',
        'समर्पित अकाउंट मैनेजर व 24x7 फोन सपोर्ट',
        'एडवांस्ड सेल्स एनालिटिक्स व CSV रिपोर्ट्स'
      ]);
      const enterpriseFeaturesEn = JSON.stringify([
        'Unlimited Retailer Shops (up to 500+)',
        'Custom Vehicle Delivery Routes & Driver Slips',
        'Dedicated Account Manager & 24x7 Phone Support',
        'Advanced Sales Analytics & CSV Exports'
      ]);

      db.run(`
        INSERT INTO subscription_plans (id, name, name_hi, monthly_fee, yearly_fee, max_shops, description, description_en, features_hi, features_en, popular, is_active, updated_at) VALUES
        ('starter', 'Starter Plan', 'स्टार्टर प्लान', 999, 9990, 30, 'छोटे एवं नए थोक वितरकों के लिए आदर्श', 'Ideal for small or emerging wholesale distributors', '${starterFeaturesHi.replace(/'/g, "''")}', '${starterFeaturesEn.replace(/'/g, "''")}', 0, 1, '${now}'),
        ('growth', 'Growth Pro', 'ग्रोथ प्रो', 1999, 19990, 100, 'मध्यम व बड़े डेयरी डिस्ट्रीब्यूटर्स के लिए सर्वाधिक लोकप्रिय', 'Designed for high volume city milk distributors', '${growthFeaturesHi.replace(/'/g, "''")}', '${growthFeaturesEn.replace(/'/g, "''")}', 1, 1, '${now}'),
        ('enterprise', 'Enterprise Hub', 'एंटरप्राइज हब', 3999, 39990, 500, 'जिले स्तर की बड़ी एजेंसियां व बहु-रूट नेटवर्क', 'District level distributors with 250+ outlets', '${enterpriseFeaturesHi.replace(/'/g, "''")}', '${enterpriseFeaturesEn.replace(/'/g, "''")}', 0, 1, '${now}');
      `);
    }
  } catch (err) {
    console.error('Failed to ensure subscription plans:', err);
  }
}

// Helper to sanitize parameters for sql.js (converting undefined to null to prevent binding errors)
function sanitizeSqlParams(params: any[] = []): any[] {
  return params.map(p => (p === undefined ? null : p));
}

// Helper wrapper to execute queries cleanly and return array of objects
export function query<T = any>(sql: string, params: any[] = []): T[] {
  if (!dbInstance) throw new Error('Database not initialized');
  const stmt = dbInstance.prepare(sql);
  const safeParams = sanitizeSqlParams(params);
  if (safeParams.length > 0) {
    stmt.bind(safeParams);
  }
  const result: T[] = [];
  while (stmt.step()) {
    result.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return result;
}

export function queryOne<T = any>(sql: string, params: any[] = []): T | null {
  const rows = query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

let isInTransaction = false;

export function withTransaction<T>(fn: () => T): T {
  if (!dbInstance) throw new Error('Database not initialized');
  if (isInTransaction) {
    return fn();
  }
  isInTransaction = true;
  dbInstance.run('BEGIN TRANSACTION;');
  try {
    const result = fn();
    dbInstance.run('COMMIT;');
    isInTransaction = false;
    saveToDisk();
    return result;
  } catch (err) {
    try {
      dbInstance.run('ROLLBACK;');
    } catch (rbErr) {
      console.error('Failed to rollback transaction:', rbErr);
    }
    isInTransaction = false;
    throw err;
  }
}

export function execute(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number } {
  if (!dbInstance) throw new Error('Database not initialized');
  const safeParams = sanitizeSqlParams(params);
  dbInstance.run(sql, safeParams);
  const res = dbInstance.exec("SELECT changes() as chg, last_insert_rowid() as lid;");
  const chg = (res[0]?.values[0]?.[0] as number) || 0;
  const lid = (res[0]?.values[0]?.[1] as number) || 0;
  if (!isInTransaction) {
    saveToDisk();
  }
  return { changes: chg, lastInsertRowid: lid };
}

export function logAudit(userId: number, action: string, entityType: string, entityId: number, oldValue?: string, newValue?: string, reason?: string) {
  const now = new Date().toISOString();
  execute(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, action, entityType, entityId, oldValue || null, newValue || null, reason || null, now]
  );
}

export function notifyUser(userId: number, title: string, message: string) {
  const now = new Date().toISOString();
  execute(
    `INSERT INTO notifications (user_id, title, message, read_status, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    [userId, title, message, now]
  );
}