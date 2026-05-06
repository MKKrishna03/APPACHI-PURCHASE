require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { Pool } = require("pg");
const crypto = require("crypto");

function generateResetKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(5);
  let key = "";
  for (let i = 0; i < 5; i++) key += chars[bytes[i] % chars.length];
  return key;
}

const dbUrl = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: dbUrl.hostname,
  port: dbUrl.port || 5432,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 90000,
  keepAlive: true,
  allowExitOnIdle: false,
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4 }, callback);
  },
});

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

const _origQuery = pool.query.bind(pool);
pool.query = async function (...args) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await _origQuery(...args);
    } catch (err) {
      lastErr = err;
      if (
        err.code === "ETIMEDOUT" ||
        err.message?.includes("ETIMEDOUT") ||
        err.message?.includes("Connection terminated")
      ) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// Keep-alive ping
setInterval(() => {
  pool.query("SELECT 1").catch(() => {});
}, 240000);

async function initDB() {
  // ── Core tables ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      alias TEXT UNIQUE NOT NULL,
      company_name TEXT,
      address TEXT,
      city TEXT,
      pincode TEXT,
      state TEXT,
      state_code TEXT,
      gst_number TEXT,
      pan_number TEXT,
      contact1 TEXT,
      contact2 TEXT,
      email TEXT,
      ac_holder TEXT,
      bank_name TEXT,
      account_number TEXT,
      ifsc_code TEXT,
      branch TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS voucher_types (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS labour (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id),
      company_name TEXT,
      date DATE,
      issue_number TEXT,
      labour_item_type TEXT,
      voucher_type TEXT,
      receipt_bill_no TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS labour_items (
      id SERIAL PRIMARY KEY,
      labour_id INTEGER REFERENCES labour(id),
      sl_no INTEGER,
      description TEXT,
      quantity NUMERIC,
      rate NUMERIC,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id),
      voucher_type TEXT,
      date DATE,
      bill_no TEXT,
      entry_type TEXT,
      description TEXT,
      qty NUMERIC,
      rate NUMERIC,
      va NUMERIC,
      taxable_value NUMERIC,
      tax_percent NUMERIC,
      igst NUMERIC,
      cgst NUMERIC,
      sgst NUMERIC,
      tax_amount NUMERIC,
      total_value NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      giver TEXT,
      receiver TEXT,
      date DATE,
      time TEXT,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      seen_at TIMESTAMP,
      done_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id SERIAL PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT,
      password TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_templates (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      receiver TEXT DEFAULT 'all',
      priority TEXT DEFAULT 'medium',
      day_of_month INTEGER NOT NULL,
      deadline_days INTEGER DEFAULT 3,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_instances (
      id SERIAL PRIMARY KEY,
      template_id INTEGER REFERENCES schedule_templates(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      receiver TEXT DEFAULT 'all',
      priority TEXT DEFAULT 'medium',
      notes TEXT,
      scheduled_date DATE,
      deadline_date DATE,
      status TEXT DEFAULT 'pending',
      done_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id),
      date DATE,
      bill_no TEXT,
      description TEXT,
      taxable_value NUMERIC,
      cgst NUMERIC,
      sgst NUMERIC,
      igst NUMERIC,
      round_off NUMERIC,
      total_value NUMERIC,
      tds NUMERIC,
      net_value NUMERIC,
      linked_voucher_id INTEGER,
      linked_chittai_id INTEGER,
      created_by TEXT,
      photo_url TEXT,
      linked_purchase_ids INTEGER[],
      linked_voucher_ids INTEGER[],
      linked_chittai_ids INTEGER[],
      is_accounted BOOLEAN DEFAULT false,
      remaining_value NUMERIC,
      voucher_type TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
      sl_no INTEGER,
      description TEXT,
      quantity NUMERIC,
      rate NUMERIC,
      tax_percent NUMERIC,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chittai (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id),
      chittai_no TEXT,
      date DATE,
      weight NUMERIC,
      rate NUMERIC,
      value NUMERIC,
      others NUMERIC DEFAULT 0,
      total NUMERIC,
      tds NUMERIC DEFAULT 0,
      rtgs_amount NUMERIC,
      is_paid BOOLEAN DEFAULT false,
      linked_purchase_id INTEGER,
      linked_voucher_id INTEGER,
      created_by TEXT,
      photo_url TEXT,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      date DATE,
      time TIME,
      notes TEXT,
      company TEXT,
      alerted_day_before BOOLEAN DEFAULT false,
      alerted_on_day BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS labour_item_types (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tax_format (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      percent NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tds (
      id SERIAL PRIMARY KEY,
      pan_4th_letter TEXT,
      section TEXT,
      entity_type TEXT,
      tds_percentage NUMERIC,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS descriptions (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      metal_type TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hallmark_expenses (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES profiles(id),
      date DATE,
      bill_no TEXT,
      voucher_type TEXT,
      description TEXT,
      taxable_value NUMERIC,
      tax_percent NUMERIC DEFAULT 0,
      cgst NUMERIC,
      sgst NUMERIC,
      igst NUMERIC,
      round_off NUMERIC,
      total_value NUMERIC,
      tds NUMERIC,
      net_value NUMERIC,
      linked_voucher_id INTEGER,
      linked_voucher_ids INTEGER[],
      linked_chittai_id INTEGER,
      linked_chittai_ids INTEGER[],
      photo_url TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hallmark_expense_items (
      id SERIAL PRIMARY KEY,
      hallmark_expense_id INTEGER REFERENCES hallmark_expenses(id) ON DELETE CASCADE,
      sl_no INTEGER,
      description TEXT,
      quantity NUMERIC,
      rate NUMERIC,
      tax_percent NUMERIC,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Upload sessions table (replaces in-memory Map) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      bill_no TEXT,
      company TEXT,
      folder TEXT,
      bill_date TEXT,
      photo_url TEXT,
      photo_urls TEXT[] DEFAULT '{}',
      done BOOLEAN DEFAULT false,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Sequences ──
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS payment_voucher_seq START 1`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS receipt_voucher_seq START 1`);

  // ── Additive column migrations ──
  const alterIfNotExists = async (sql) => { try { await pool.query(sql); } catch (_) {} };

  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_labour_id INTEGER REFERENCES labour(id)`);
  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_chittai_id INTEGER REFERENCES chittai(id)`);
  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_purchase_id INTEGER REFERENCES purchases(id)`);
  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS voucher_no TEXT`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS linked_purchase_id INTEGER REFERENCES purchases(id)`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS linked_voucher_id INTEGER REFERENCES vouchers(id)`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS taxable_total NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS cgst NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS sgst NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS igst NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS round_off NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS total NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS tds NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS bill_value_after_deduction NUMERIC`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN DEFAULT false`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS remaining_value NUMERIC`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN DEFAULT false`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_purchase_ids INTEGER[]`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS remaining_value NUMERIC`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_voucher_ids INTEGER[]`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_chittai_ids INTEGER[]`);
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS voucher_type TEXT`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS remarks TEXT`);
  await alterIfNotExists(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`);
  await alterIfNotExists(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS photo TEXT`);
  await alterIfNotExists(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS replies JSONB DEFAULT '[]'`);
  await alterIfNotExists(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS can_delete BOOLEAN DEFAULT FALSE`);
  await alterIfNotExists(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS reset_key TEXT`);
  await alterIfNotExists(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ledger_types TEXT[] DEFAULT '{}'`);
  await alterIfNotExists(`ALTER TABLE hallmark_expenses ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`);
  await alterIfNotExists(`ALTER TABLE hallmark_expenses ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN DEFAULT false`);
  await alterIfNotExists(`ALTER TABLE hallmark_expenses ADD COLUMN IF NOT EXISTS remaining_value NUMERIC`);

  // ── Soft delete columns ──
  await alterIfNotExists(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await alterIfNotExists(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await alterIfNotExists(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await alterIfNotExists(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await alterIfNotExists(`ALTER TABLE hallmark_expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await alterIfNotExists(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);

  // Generate reset_key for users missing one
  const usersWithoutKey = await pool.query(`SELECT id FROM auth_users WHERE reset_key IS NULL`);
  for (const row of usersWithoutKey.rows) {
    await pool.query(`UPDATE auth_users SET reset_key=$1 WHERE id=$2`, [generateResetKey(), row.id]);
  }

  // Fix photo_urls columns that may have been created as JSONB
  for (const table of ["purchases", "labour", "chittai", "hallmark_expenses"]) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${table}' AND column_name = 'photo_urls' AND udt_name IN ('jsonb','json')
        ) THEN
          ALTER TABLE ${table} ALTER COLUMN photo_urls TYPE TEXT[]
          USING CASE
            WHEN photo_urls IS NULL THEN NULL::TEXT[]
            WHEN jsonb_typeof(photo_urls::jsonb) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(photo_urls::jsonb))
            ELSE NULL::TEXT[]
          END;
        END IF;
      END $$;
    `);
  }

  // Fix INTEGER[] columns that were mistakenly created as JSONB
  for (const col of ["linked_voucher_ids", "linked_chittai_ids", "linked_purchase_ids"]) {
    const check = await pool.query(
      `SELECT udt_name FROM information_schema.columns WHERE table_name='purchases' AND column_name=$1`,
      [col],
    );
    if (check.rows[0] && (check.rows[0].udt_name === "jsonb" || check.rows[0].udt_name === "json")) {
      await pool.query(`ALTER TABLE purchases DROP COLUMN ${col}`);
      await pool.query(`ALTER TABLE purchases ADD COLUMN ${col} INTEGER[]`);
    }
  }

  // Drop stray items jsonb column on purchases
  await pool.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS items`);

  // Clean expired upload sessions
  await pool.query(`DELETE FROM upload_sessions WHERE expires_at < NOW()`);

  console.log("[DB] Ready");
}

module.exports = { pool, initDB, generateResetKey };
