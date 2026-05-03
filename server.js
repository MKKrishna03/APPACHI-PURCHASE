require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
process.env.TZ = "Asia/Kolkata";
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const bcrypt = require("bcrypt");
const multer = require("multer");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { GoogleGenAI } = require("@google/genai");
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Allowed folder names
const ALLOWED_FOLDERS = new Set([
  "purchase_bills",
  "chittai_bills",
  "labour_receipts",
  "hallmark_bills",
  "expense_bills",
  "credit_notes",
  "debit_notes",
  "refinery_bills",
]);

function resolveFolder(req, defaultFolder) {
  const token = req.params && req.params.token;
  const session = token ? uploadSessions.get(token) : null;
  if (session && ALLOWED_FOLDERS.has(session.folder)) return session.folder;
  if (req.body && ALLOWED_FOLDERS.has(req.body.folder)) return req.body.folder;
  if (req.query && ALLOWED_FOLDERS.has(req.query.folder))
    return req.query.folder;
  return defaultFolder;
}

function makeUploader(defaultFolder) {
  return multer({
    storage: new CloudinaryStorage({
      cloudinary,
      params: (req, file) => {
        const isPdf = file.mimetype === "application/pdf";
        const folder = resolveFolder(req, defaultFolder);
        console.log(
          `[CLOUDINARY UPLOAD] folder=${folder} token=${req.params?.token || "none"} sessionFolder=${uploadSessions.get(req.params?.token)?.folder || "none"} bodyFolder=${req.body?.folder || "none"}`,
        );
        const session = req.params?.token
          ? uploadSessions.get(req.params.token)
          : null;
        const bill_date = session?.bill_date || req.body?.bill_date || null;
        return {
          folder,
          resource_type: isPdf ? "raw" : "image",
          allowed_formats: isPdf
            ? ["pdf"]
            : ["jpg", "jpeg", "png", "webp", "heic"],
          ...(bill_date ? { context: `bill_date=${bill_date}` } : {}),
          ...(isPdf
            ? {}
            : {
                transformation: [
                  { width: 1600, height: 1600, crop: "limit", quality: "auto" },
                ],
              }),
        };
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
  });
}

const upload = makeUploader("purchase_bills");
const uploadChittai = makeUploader("chittai_bills");

// In-memory upload sessions (token -> { bill_no, company, photo_url, expires })
const uploadSessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of uploadSessions) {
    if (v.expires < now) uploadSessions.delete(k);
  }
}, 60000);
const app = express();
const PORT = process.env.PORT || 3000;

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
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 90000,
  keepAlive: true,
  allowExitOnIdle: false,
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4 }, callback);
  },
});

pool.on("error", (err) => {
  console.error("PG POOL ERROR:", err.message);
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

setInterval(() => {
  pool.query("SELECT 1").catch(() => {});
}, 240000);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

async function initDB() {
  await pool.query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_labour_id INTEGER REFERENCES labour(id)`,
  );
  await pool.query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_chittai_id INTEGER REFERENCES chittai(id)`,
  );
  await pool.query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS linked_purchase_id INTEGER REFERENCES purchases(id)`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS linked_purchase_id INTEGER REFERENCES purchases(id)`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS linked_voucher_id INTEGER REFERENCES vouchers(id)`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS taxable_total NUMERIC`,
  );
  await pool.query(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS cgst NUMERIC`);
  await pool.query(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS sgst NUMERIC`);
  await pool.query(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS igst NUMERIC`);
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS round_off NUMERIC`,
  );
  await pool.query(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS total NUMERIC`);
  await pool.query(`ALTER TABLE labour ADD COLUMN IF NOT EXISTS tds NUMERIC`);
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS bill_value_after_deduction NUMERIC`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS photo_url TEXT`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN DEFAULT false`,
  );
  await pool.query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS photo_url TEXT`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN DEFAULT false`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_purchase_ids INTEGER[]`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS remaining_value NUMERIC`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS remaining_value NUMERIC`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS photo_url TEXT`,
  );
  await pool.query(`ALTER TABLE chittai ADD COLUMN IF NOT EXISTS remarks TEXT`);
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
  await pool.query(
    `ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`,
  );
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS photo TEXT`);
  await pool.query(
    `ALTER TABLE todos ADD COLUMN IF NOT EXISTS replies JSONB DEFAULT '[]'`,
  );
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
  await pool.query(
    `ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS can_delete BOOLEAN DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS reset_key TEXT`,
  );
  // Generate reset_key for any user that doesn't have one yet
  const usersWithoutKey = await pool.query(
    `SELECT id FROM auth_users WHERE reset_key IS NULL`,
  );
  for (const row of usersWithoutKey.rows) {
    await pool.query(`UPDATE auth_users SET reset_key=$1 WHERE id=$2`, [
      generateResetKey(),
      row.id,
    ]);
  }

  // ── Base tables that may not exist on a fresh setup ──
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

  // ── Sequences for voucher numbering ──
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS payment_voucher_seq START 1`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS receipt_voucher_seq START 1`);

  // ── Missing columns on existing tables ──
  await pool.query(
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ledger_types TEXT[] DEFAULT '{}'`,
  );
  await pool.query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS voucher_no TEXT`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_voucher_ids INTEGER[]`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS linked_chittai_ids INTEGER[]`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS voucher_type TEXT`,
  );

  // ── Multiple photos per bill ──
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`,
  );
  await pool.query(
    `ALTER TABLE labour ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`,
  );
  await pool.query(
    `ALTER TABLE hallmark_expenses ADD COLUMN IF NOT EXISTS photo_urls TEXT[]`,
  );

  // Fix photo_urls columns that may have been created as JSON/JSONB in an earlier migration.
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

  // Fix purchases.linked_voucher_ids / linked_chittai_ids / linked_purchase_ids
  // if they were created as JSONB. Drop and recreate as INTEGER[] (link metadata is rebuilt from vouchers side).
  for (const col of [
    "linked_voucher_ids",
    "linked_chittai_ids",
    "linked_purchase_ids",
  ]) {
    const check = await pool.query(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name='purchases' AND column_name=$1`,
      [col],
    );
    if (
      check.rows[0] &&
      (check.rows[0].udt_name === "jsonb" || check.rows[0].udt_name === "json")
    ) {
      await pool.query(`ALTER TABLE purchases DROP COLUMN ${col}`);
      await pool.query(`ALTER TABLE purchases ADD COLUMN ${col} INTEGER[]`);
      console.log(`Migrated purchases.${col} from jsonb to INTEGER[]`);
    }
  }

  // Drop the stray "items" jsonb column on purchases (line items live in purchase_items table).
  await pool.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS items`);

  console.log("DB ready");
}

initDB().catch((err) => {
  console.error("INITDB FAILED:");
  console.error(err);
  process.exit(1);
});

// ── PROFILE ROUTES ──

app.get("/api/profile/headers", (req, res) => {
  res.json([
    "COMPANY NAME",
    "ALIAS",
    "ADDRESS",
    "CITY",
    "PINCODE",
    "STATE",
    "STATE CODE",
    "GST NUMBER",
    "PAN NUMBER",
    "CONTACT NUMBER 01",
    "CONTACT NUMBER 02",
    "E-MAIL ID",
    "A/C HOLDER'S NAME",
    "BANK NAME",
    "ACCOUNT NUMBER",
    "IFSC CODE",
    "BRANCH",
  ]);
});

app.get("/api/profile/all", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, alias, company_name AS company, state_code, ledger_types, pan_number FROM profiles ORDER BY company_name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/profiles/list", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, alias, company_name AS name, state_code, ledger_types FROM profiles ORDER BY company_name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/profile/:alias", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM profiles WHERE alias=$1", [
      req.params.alias,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    const r = result.rows[0];
    res.json({
      "COMPANY NAME": r.company_name,
      LEDGER_TYPES: r.ledger_types || [],
      ALIAS: r.alias,
      ADDRESS: r.address,
      CITY: r.city,
      PINCODE: r.pincode,
      STATE: r.state,
      "STATE CODE": r.state_code,
      "GST NUMBER": r.gst_number,
      "PAN NUMBER": r.pan_number,
      "CONTACT NUMBER 01": r.contact1,
      "CONTACT NUMBER 02": r.contact2,
      "E-MAIL ID": r.email,
      "A/C HOLDER'S NAME": r.ac_holder,
      "BANK NAME": r.bank_name,
      "ACCOUNT NUMBER": r.account_number,
      "IFSC CODE": r.ifsc_code,
      BRANCH: r.branch,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/profile", async (req, res) => {
  const d = req.body;
  try {
    await pool.query(
      `INSERT INTO profiles
        (alias,company_name,address,city,pincode,state,state_code,gst_number,pan_number,
         contact1,contact2,email,ac_holder,bank_name,account_number,ifsc_code,branch,ledger_types)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        d["ALIAS"],
        d["COMPANY NAME"],
        d["ADDRESS"],
        d["CITY"],
        d["PINCODE"],
        d["STATE"],
        d["STATE CODE"],
        d["GST NUMBER"],
        d["PAN NUMBER"],
        d["CONTACT NUMBER 01"],
        d["CONTACT NUMBER 02"],
        d["E-MAIL ID"],
        d["A/C HOLDER'S NAME"],
        d["BANK NAME"],
        d["ACCOUNT NUMBER"],
        d["IFSC CODE"],
        d["BRANCH"],
        d["LEDGER_TYPES"] || [],
      ],
    );
    res.json({ status: "SUCCESS" });
  } catch (err) {
    console.error("PROFILE POST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/profile/:alias", async (req, res) => {
  const d = req.body;
  const alias = req.params.alias;
  try {
    await pool.query(
      `UPDATE profiles SET
        alias=$1, company_name=$2, address=$3, city=$4, pincode=$5, state=$6,
        state_code=$7, gst_number=$8, pan_number=$9, contact1=$10,
        contact2=$11, email=$12, ac_holder=$13, bank_name=$14,
        account_number=$15, ifsc_code=$16, branch=$17, ledger_types=$18, updated_at=NOW()
      WHERE alias=$19`,
      [
        d["ALIAS"],
        d["COMPANY NAME"],
        d["ADDRESS"],
        d["CITY"],
        d["PINCODE"],
        d["STATE"],
        d["STATE CODE"],
        d["GST NUMBER"],
        d["PAN NUMBER"],
        d["CONTACT NUMBER 01"],
        d["CONTACT NUMBER 02"],
        d["E-MAIL ID"],
        d["A/C HOLDER'S NAME"],
        d["BANK NAME"],
        d["ACCOUNT NUMBER"],
        d["IFSC CODE"],
        d["BRANCH"],
        d["LEDGER_TYPES"] || [],
        alias,
      ],
    );
    await pool.query(
      `UPDATE labour l SET company_name = p.company_name FROM profiles p WHERE l.profile_id = p.id AND p.alias = $1`,
      [d["ALIAS"]],
    );

    let duplicate_created = false;
    if (d["CREATE_DUPLICATE"] && d["DUPLICATE_ALIAS"]) {
      const dupAlias = d["DUPLICATE_ALIAS"];
      const exists = await pool.query(
        "SELECT id FROM profiles WHERE alias=$1",
        [dupAlias],
      );
      if (exists.rows[0]) {
        await pool.query(
          `UPDATE profiles SET ledger_types=$1, updated_at=NOW() WHERE alias=$2`,
          [d["DUPLICATE_LEDGER_TYPES"] || [], dupAlias],
        );
      } else {
        await pool.query(
          `INSERT INTO profiles
            (alias,company_name,address,city,pincode,state,state_code,gst_number,pan_number,
             contact1,contact2,email,ac_holder,bank_name,account_number,ifsc_code,branch,ledger_types)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            dupAlias,
            d["COMPANY NAME"] + " II",
            d["ADDRESS"],
            d["CITY"],
            d["PINCODE"],
            d["STATE"],
            d["STATE CODE"],
            d["GST NUMBER"],
            d["PAN NUMBER"],
            d["CONTACT NUMBER 01"],
            d["CONTACT NUMBER 02"],
            d["E-MAIL ID"],
            d["A/C HOLDER'S NAME"],
            d["BANK NAME"],
            d["ACCOUNT NUMBER"],
            d["IFSC CODE"],
            d["BRANCH"],
            d["DUPLICATE_LEDGER_TYPES"] || [],
          ],
        );
      }
      duplicate_created = true;
    }

    res.json({ status: "SUCCESS", duplicate_created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function num(v) {
  return v === "" || v == null ? null : v;
}

// ── VOUCHER TYPE ROUTES ──

app.get("/api/voucher-types", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name FROM voucher_types ORDER BY name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/labour-item-types", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name FROM labour_item_types ORDER BY name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/voucher-type", async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query(
      "INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING",
      [name],
    );
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/seed-voucher-types", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO voucher_types (name) VALUES ('Create Issue Voucher'), ('Close Issue Voucher') ON CONFLICT DO NOTHING",
    );
    res.json({ status: "SUCCESS", message: "Voucher types seeded" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LABOUR ROUTES ──

app.get("/api/labour/list", async (req, res) => {
  console.log("HIT LABOUR LIST", req.query);
  const { profile_id, voucher_type } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id) {
      params.push(profile_id);
      where += `${where ? " AND" : " WHERE"} l.profile_id = $${params.length}`;
    }
    if (voucher_type) {
      params.push(voucher_type);
      where += `${where ? " AND" : " WHERE"} l.voucher_type ILIKE $${params.length}`;
    }
    const result = await pool.query(
      `SELECT l.id, l.profile_id, l.company_name, l.date, l.issue_number, l.receipt_bill_no,
              l.voucher_type, l.receipt_bill_no, l.bill_value_after_deduction, l.total, l.remaining_value,
              COALESCE(SUM(li.amount::numeric), 0) AS total_value
       FROM labour l
       LEFT JOIN labour_items li ON li.labour_id = l.id
       ${where}
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      params,
    );
    console.log("LABOUR LIST RESULT:", result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error("LABOUR LIST ERROR FULL:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/labour/rv-references", async (req, res) => {
  const { issue_number, profile_id } = req.query;
  if (!issue_number || !profile_id) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT id, receipt_bill_no, issue_number, date FROM labour
       WHERE voucher_type = 'Receipt Voucher'
         AND profile_id = $1
         AND issue_number IS NOT NULL
         AND (
           issue_number = $2
           OR issue_number LIKE $3
           OR issue_number LIKE $4
           OR issue_number LIKE $5
         )`,
      [
        profile_id,
        issue_number,
        `${issue_number},%`,
        `%,${issue_number}`,
        `%,${issue_number},%`,
      ],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/labour/:id", async (req, res) => {
  if (req.params.id === "list")
    return res.status(404).json({ error: "Not found" });
  if (req.params.id === "rv-references")
    return res.status(404).json({ error: "Not found" });
  if (isNaN(req.params.id)) return res.status(404).json({ error: "Not found" });
  try {
    const labourResult = await pool.query(
      "SELECT * FROM labour WHERE id = $1",
      [req.params.id],
    );
    if (!labourResult.rows[0])
      return res.status(404).json({ error: "Labour not found" });
    const itemsResult = await pool.query(
      "SELECT * FROM labour_items WHERE labour_id = $1 ORDER BY sl_no",
      [req.params.id],
    );
    res.json({ labour: labourResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/labour", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.name AS created_by_name FROM labour l LEFT JOIN auth_users u ON u.user_id::text = l.created_by ORDER BY l.created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── CLOSE ISSUE VOUCHER ROUTES ──

app.post("/api/close-issue-voucher", async (req, res) => {
  const {
    labour_id,
    labour_ids,
    closing_type_map,
    closing_date,
    closing_type,
    partial_qty,
    items,
    payment_voucher_id,
    taxable_total,
    cgst,
    sgst,
    igst,
    round_off,
    total,
    tds,
    bill_value_after_deduction,
  } = req.body;

  // Multi-bill: create ONE receipt linked to all selected issue vouchers
  if (labour_ids && labour_ids.length) {
    try {
      const firstRes = await pool.query("SELECT * FROM labour WHERE id = $1", [
        labour_ids[0],
      ]);
      if (!firstRes.rows[0])
        return res.status(404).json({ error: "Labour bill not found" });
      const labour = firstRes.rows[0];
      await pool.query(
        "INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING",
        ["Receipt Voucher"],
      );
      const result = await pool.query(
        `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by, photo_url, photo_urls)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [
          labour.profile_id,
          labour.company_name,
          closing_date,
          (
            await Promise.all(
              labour_ids.map(async (id) => {
                const r = await pool.query(
                  "SELECT issue_number FROM labour WHERE id = $1",
                  [id],
                );
                return r.rows[0] ? r.rows[0].issue_number : id;
              }),
            )
          ).join(","),
          "Receipt Voucher",
          req.body.bill_no || null,
          taxable_total || null,
          cgst || null,
          sgst || null,
          igst || null,
          round_off || null,
          total || null,
          tds || null,
          bill_value_after_deduction || null,
          req.body.created_by || null,
          req.body.photo_url || null,
          req.body.photo_urls?.length ? req.body.photo_urls : null,
        ],
      );
      const close_labour_id = result.rows[0].id;
      if (items && items.length) {
        for (const item of items) {
          await pool.query(
            `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              close_labour_id,
              item.sl_no,
              item.description,
              item.quantity,
              item.rate,
              item.amount,
            ],
          );
        }
      }
      if (payment_voucher_id) {
        await pool.query(
          `UPDATE vouchers SET linked_labour_id = $1 WHERE id = $2`,
          [close_labour_id, payment_voucher_id],
        );
      }
      return res.json({ status: "SUCCESS", id: close_labour_id });
    } catch (err) {
      console.error("CLOSE ISSUE VOUCHER MULTI ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const labourResult = await pool.query(
      "SELECT * FROM labour WHERE id = $1",
      [labour_id],
    );

    if (!labourResult.rows[0]) {
      return res.status(404).json({ error: "Labour bill not found" });
    }

    const labour = labourResult.rows[0];

    // Ensure Receipt Voucher type exists
    await pool.query(
      "INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING",
      ["Receipt Voucher"],
    );

    const result = await pool.query(
      `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by, photo_url, photo_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        labour.profile_id,
        labour.company_name,
        closing_date,
        labour.issue_number,
        "Receipt Voucher",
        req.body.bill_no || null,
        taxable_total || null,
        cgst || null,
        sgst || null,
        igst || null,
        round_off || null,
        total || null,
        tds || null,
        bill_value_after_deduction || null,
        req.body.created_by || null,
        req.body.photo_url || null,
        req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );

    const close_labour_id = result.rows[0].id;

    // Insert items if provided
    if (items && items.length > 0) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            close_labour_id,
            item.sl_no,
            item.description,
            partial_qty && closing_type === "partial"
              ? partial_qty
              : item.quantity,
            item.rate,
            item.amount,
          ],
        );
      }
    }

    if (payment_voucher_id) {
      await pool.query(
        `UPDATE vouchers SET linked_labour_id = $1 WHERE id = $2`,
        [close_labour_id, payment_voucher_id],
      );
    }

    res.json({ status: "SUCCESS", id: close_labour_id });
  } catch (err) {
    console.error("CLOSE ISSUE VOUCHER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/labour/unlinked-receipts", async (req, res) => {
  const { profile_id } = req.query;
  if (!profile_id)
    return res.status(400).json({ error: "profile_id required" });
  try {
    const linkedIds = await pool.query(
      `SELECT linked_labour_id FROM vouchers WHERE linked_labour_id IS NOT NULL`,
    );
    const linkedSet = linkedIds.rows.map((r) => r.linked_labour_id);
    let query = `SELECT id, issue_number, receipt_bill_no, date FROM labour WHERE voucher_type = 'Receipt Voucher' AND profile_id = $1`;
    const result = await pool.query(query, [profile_id]);
    const unlinked = result.rows.filter((r) => !linkedSet.includes(r.id));
    res.json(unlinked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/chittai", (req, res) =>
  res.sendFile(path.join(__dirname, "chittai.html")),
);

// ── VOUCHER ROUTES ──

app.post("/api/vouchers", async (req, res) => {
  const {
    profile_id,
    voucher_type,
    date,
    bill_no,
    entry_type,
    description,
    qty,
    rate,
    va,
    taxable_value,
    tax_percent,
    igst,
    cgst,
    sgst,
    tax_amount,
    total_value,
  } = req.body;
  try {
    let linked_labour_id = null;
    if (
      entry_type === "against" &&
      bill_no &&
      voucher_type &&
      voucher_type.toLowerCase().includes("labour")
    ) {
      const labourMatch = await pool.query(
        `SELECT id FROM labour WHERE receipt_bill_no = $1 AND profile_id = $2 AND voucher_type = 'Receipt Voucher' LIMIT 1`,
        [bill_no, profile_id],
      );
      if (labourMatch.rows[0]) linked_labour_id = labourMatch.rows[0].id;
    }
    let linked_chittai_id = null;
    if (entry_type === "against" && bill_no) {
      const chittaiMatch = await pool.query(
        `SELECT id FROM chittai WHERE chittai_no = $1 AND profile_id = $2 LIMIT 1`,
        [bill_no, profile_id],
      );
      if (chittaiMatch.rows[0]) {
        linked_chittai_id = chittaiMatch.rows[0].id;
        await pool.query(`UPDATE chittai SET is_paid=true WHERE id=$1`, [
          linked_chittai_id,
        ]);
      }
    }
    let voucher_no = null;
    if (voucher_type === "Payment Voucher") {
      const seq = await pool.query(
        `SELECT nextval('payment_voucher_seq') AS val`,
      );
      voucher_no = "P-" + String(seq.rows[0].val).padStart(2, "0");
    } else if (voucher_type === "Receipt Voucher") {
      const seq = await pool.query(
        `SELECT nextval('receipt_voucher_seq') AS val`,
      );
      voucher_no = "R-" + String(seq.rows[0].val).padStart(2, "0");
    }

    const result = await pool.query(
      `INSERT INTO vouchers
        (profile_id,voucher_type,date,bill_no,entry_type,description,
         qty,rate,va,taxable_value,tax_percent,igst,cgst,sgst,tax_amount,total_value,linked_labour_id,linked_chittai_id,created_by,voucher_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        profile_id,
        voucher_type,
        date,
        bill_no,
        entry_type,
        description,
        num(qty),
        num(rate),
        num(va),
        num(taxable_value),
        num(tax_percent),
        num(igst),
        num(cgst),
        num(sgst),
        num(tax_amount),
        num(total_value),
        linked_labour_id,
        linked_chittai_id,
        req.body.created_by || null,
        voucher_no,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("VOUCHER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.patch("/api/vouchers/:id", async (req, res) => {
  const {
    date,
    total_value,
    description,
    linked_chittai_id,
    profile_id,
    voucher_type,
    bill_no,
    entry_type,
  } = req.body;
  try {
    let result;
    if (linked_chittai_id !== undefined && Object.keys(req.body).length === 1) {
      result = await pool.query(
        `UPDATE vouchers SET linked_chittai_id=$1 WHERE id=$2 RETURNING *`,
        [linked_chittai_id, req.params.id],
      );
    } else {
      // Handle chittai linking if against chittai
      let linked_chittai_id_val = null;
      if (entry_type === "against" && bill_no && profile_id) {
        const chittaiMatch = await pool.query(
          `SELECT id FROM chittai WHERE chittai_no = $1 AND profile_id = $2 LIMIT 1`,
          [bill_no, profile_id],
        );
        if (chittaiMatch.rows[0]) {
          linked_chittai_id_val = chittaiMatch.rows[0].id;
          await pool.query(`UPDATE chittai SET is_paid=true WHERE id=$1`, [
            linked_chittai_id_val,
          ]);
        }
      }
      result = await pool.query(
        `UPDATE vouchers SET profile_id=$1, voucher_type=$2, date=$3, bill_no=$4, entry_type=$5, description=$6, total_value=$7, linked_chittai_id=COALESCE($8, linked_chittai_id) WHERE id=$9 RETURNING *`,
        [
          profile_id,
          voucher_type,
          date,
          bill_no,
          entry_type,
          description,
          total_value,
          linked_chittai_id_val,
          req.params.id,
        ],
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/vouchers/list", async (req, res) => {
  const { profile_id, voucher_type, unlinked_only } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id && profile_id !== "undefined" && profile_id !== "null") {
      params.push(profile_id);
      where += `${where ? " AND" : " WHERE"} profile_id = $${params.length}`;
    }
    if (voucher_type) {
      params.push(`%${voucher_type}%`);
      where += `${where ? " AND" : " WHERE"} voucher_type ILIKE $${params.length}`;
    }
    if (unlinked_only === "true") {
      where += `${where ? " AND" : " WHERE"} linked_labour_id IS NULL AND linked_chittai_id IS NULL AND linked_purchase_id IS NULL AND voucher_type NOT IN ('Payment Voucher', 'Receipt Voucher', 'Chittai Payment')`;
    }
    const result = await pool.query(
      `SELECT v.id, v.profile_id, v.voucher_type, v.date, v.bill_no, v.total_value, v.entry_type, v.description, v.linked_labour_id, v.linked_chittai_id, v.linked_purchase_id, v.created_at, v.created_by, u.name AS created_by_name FROM vouchers v LEFT JOIN auth_users u ON u.user_id::text = v.created_by
       ${where.replace("profile_id", "v.profile_id").replace("voucher_type", "v.voucher_type")}
       ORDER BY v.created_at DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(
      "VOUCHER LIST ERROR:",
      err.message,
      err.stack,
      err.code,
      err.detail,
    );
    res.status(500).json({ error: err.message });
  }
});

// ── PAGES ──
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/profile", (req, res) =>
  res.sendFile(path.join(__dirname, "profile.html")),
);
app.get("/labour", (req, res) =>
  res.sendFile(path.join(__dirname, "labour.html")),
);
app.get("/transaction", (req, res) =>
  res.sendFile(path.join(__dirname, "newtrns.html")),
);
app.get("/newtrns", (req, res) =>
  res.sendFile(path.join(__dirname, "newtrns.html")),
);
app.get("/receipt", (req, res) =>
  res.sendFile(path.join(__dirname, "newtrns.html")),
);
app.get("/payment", (req, res) =>
  res.sendFile(path.join(__dirname, "newtrns.html")),
);
app.get("/api/reminders", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, to_char(date,'YYYY-MM-DD') as date, to_char(time,'HH24:MI') as time, notes, company, alerted_day_before, alerted_on_day FROM reminders ORDER BY date ASC, time ASC",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/reminders", async (req, res) => {
  const { title, date, time, notes, company } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO reminders (title, date, time, notes, company) VALUES ($1, $2::date, $3, $4, $5) RETURNING *",
      [title, date, time, notes || null, company || null],
    );
    res.json({ status: "SUCCESS", reminder: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete("/api/reminders/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM reminders WHERE id=$1", [req.params.id]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.patch("/api/reminders/:id/alerted", async (req, res) => {
  const { type, date, time } = req.body;
  try {
    if (type === "snooze") {
      await pool.query(
        `UPDATE reminders SET date=$1, time=$2, alerted_on_day=false, alerted_day_before=false WHERE id=$3`,
        [date, time, req.params.id],
      );
    } else {
      const col =
        type === "day_before" ? "alerted_day_before" : "alerted_on_day";
      await pool.query(`UPDATE reminders SET ${col}=true WHERE id=$1`, [
        req.params.id,
      ]);
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── PURCHASE ROUTES ──
app.get("/api/purchases/list", async (req, res) => {
  const { profile_id, unlinked_only } = req.query;
  try {
    let where = "";
    const params = [];
    if (profile_id) {
      params.push(profile_id);
      where = `WHERE profile_id = $1`;
    }
    const result = await pool.query(
      `SELECT p.*, u.name AS created_by_name FROM purchases p LEFT JOIN auth_users u ON u.user_id::text = p.created_by ${where ? where.replace("WHERE", "WHERE p.") : ""} ORDER BY p.created_at DESC`,
      params,
    );
    let purchases = result.rows;

    if (unlinked_only === "true") {
      // Sum all voucher payments linked to each purchase
      const vRes = await pool.query(
        `SELECT linked_purchase_id, SUM(total_value::numeric) as paid
         FROM vouchers
         WHERE linked_purchase_id IS NOT NULL
         GROUP BY linked_purchase_id`,
      );
      const paidMap = {};
      vRes.rows.forEach((r) => {
        paidMap[parseInt(r.linked_purchase_id)] = parseFloat(r.paid || 0);
      });

      // Also check payments linked via bill_no match (belt and suspenders)
      const billRes = await pool.query(
        `SELECT p.id, COALESCE(SUM(v.total_value::numeric), 0) as paid
         FROM purchases p
         LEFT JOIN vouchers v ON v.bill_no = p.bill_no
           AND v.profile_id = p.profile_id
           AND v.entry_type = 'against'
           AND v.voucher_type IN ('Payment Voucher','Receipt Voucher','Chittai Payment')
         GROUP BY p.id`,
      );
      billRes.rows.forEach((r) => {
        const existing = paidMap[parseInt(r.id)] || 0;
        const byBill = parseFloat(r.paid || 0);
        // Use whichever is higher
        paidMap[parseInt(r.id)] = Math.max(existing, byBill);
      });

      purchases = purchases.filter((p) => {
        const paid = paidMap[p.id] || 0;
        const due = parseFloat(p.net_value || p.total_value || 0);
        return due > 0 && paid < due - 0.01;
      });
    }

    res.json(purchases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/purchases/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT * FROM purchases WHERE id=$1", [
      req.params.id,
    ]);
    if (!p.rows[0]) return res.status(404).json({ error: "Not found" });
    const items = await pool.query(
      "SELECT * FROM purchase_items WHERE purchase_id=$1 ORDER BY sl_no",
      [req.params.id],
    );
    res.json({ purchase: p.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/purchases", async (req, res) => {
  const {
    profile_id,
    date,
    bill_no,
    description,
    taxable_value,
    cgst,
    sgst,
    igst,
    round_off,
    total_value,
    tds,
    net_value,
    linked_voucher_ids,
    linked_chittai_ids,
    linked_purchase_ids,
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO purchases (profile_id, date, bill_no, description, taxable_value, cgst, sgst, igst,
        round_off, total_value, tds, net_value, linked_voucher_id, linked_chittai_id, created_by, photo_url, linked_purchase_ids,
        linked_voucher_ids, linked_chittai_ids, photo_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        profile_id,
        date,
        bill_no,
        description,
        taxable_value,
        cgst,
        sgst,
        igst,
        round_off,
        total_value,
        tds,
        net_value,
        linked_voucher_ids && linked_voucher_ids.length
          ? linked_voucher_ids[0]
          : null,
        linked_chittai_ids && linked_chittai_ids.length
          ? linked_chittai_ids[0]
          : null,
        req.body.created_by || null,
        req.body.photo_url || null,
        linked_purchase_ids && linked_purchase_ids.length
          ? linked_purchase_ids
          : null,
        linked_voucher_ids && linked_voucher_ids.length
          ? linked_voucher_ids
          : null,
        linked_chittai_ids && linked_chittai_ids.length
          ? linked_chittai_ids
          : null,
        req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );
    const purchaseId = result.rows[0].id;
    // Save line items
    if (req.body.items && req.body.items.length) {
      for (const item of req.body.items) {
        await pool.query(
          `INSERT INTO purchase_items (purchase_id, sl_no, description, quantity, rate, tax_percent, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            purchaseId,
            item.sl_no,
            item.description,
            item.quantity,
            item.rate,
            item.tax_percent,
            item.amount,
          ],
        );
      }
    }
    // Link all vouchers back to this purchase
    if (linked_voucher_ids && linked_voucher_ids.length) {
      for (const vid of linked_voucher_ids) {
        await pool.query(
          `UPDATE vouchers SET linked_purchase_id=$1 WHERE id=$2`,
          [purchaseId, vid],
        );
      }
    }
    if (linked_chittai_ids && linked_chittai_ids.length) {
      for (const cid of linked_chittai_ids) {
        await pool.query(
          `UPDATE chittai SET linked_purchase_id=$1 WHERE id=$2`,
          [purchaseId, cid],
        );
      }
    }

    // Deduct the note's net_value from the linked source bill's remaining
    const isNote =
      description === "Credit Note" || description === "Debit Note";
    if (
      isNote &&
      req.body.source_type === "purchase" &&
      linked_purchase_ids &&
      linked_purchase_ids.length
    ) {
      for (const pid of linked_purchase_ids) {
        const cur = await pool.query(
          `SELECT COALESCE(remaining_value, net_value, total_value) AS rem FROM purchases WHERE id=$1`,
          [pid],
        );
        const currentRem = parseFloat(cur.rows[0]?.rem || 0);
        const newRem = currentRem - parseFloat(net_value || 0);
        await pool.query(
          `UPDATE purchases SET remaining_value=$1 WHERE id=$2`,
          [newRem, pid],
        );
      }
    }
    if (
      isNote &&
      req.body.source_type === "labour" &&
      req.body.linked_labour_ids &&
      req.body.linked_labour_ids.length
    ) {
      for (const lid of req.body.linked_labour_ids) {
        const cur = await pool.query(
          `SELECT COALESCE(remaining_value, bill_value_after_deduction, total) AS rem FROM labour WHERE id=$1`,
          [lid],
        );
        const currentRem = parseFloat(cur.rows[0]?.rem || 0);
        const newRem = currentRem - parseFloat(net_value || 0);
        await pool.query(`UPDATE labour SET remaining_value=$1 WHERE id=$2`, [
          newRem,
          lid,
        ]);
      }
    }

    res.json({ status: "SUCCESS", id: purchaseId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/purchase", (req, res) =>
  res.sendFile(path.join(__dirname, "purchase.html")),
);
app.get("/note", (req, res) => res.sendFile(path.join(__dirname, "note.html")));
app.get("/hmex", (req, res) => res.sendFile(path.join(__dirname, "hmex.html")));

app.post("/api/hallmark-expenses", async (req, res) => {
  const {
    profile_id,
    date,
    bill_no,
    voucher_type,
    description,
    taxable_value,
    tax_percent,
    cgst,
    sgst,
    igst,
    round_off,
    total_value,
    tds,
    net_value,
    linked_voucher_id,
    linked_voucher_ids,
    linked_chittai_id,
    linked_chittai_ids,
    items,
    created_by,
    photo_url,
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO hallmark_expenses
        (profile_id, date, bill_no, voucher_type, description,
         taxable_value, tax_percent, cgst, sgst, igst,
         round_off, total_value, tds, net_value,
         linked_voucher_id, linked_voucher_ids,
         linked_chittai_id, linked_chittai_ids,
         photo_url, created_by, photo_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        profile_id,
        date,
        bill_no,
        voucher_type,
        description,
        taxable_value,
        tax_percent || 0,
        cgst,
        sgst,
        igst,
        round_off,
        total_value,
        tds,
        net_value,
        linked_voucher_id || null,
        linked_voucher_ids?.length ? linked_voucher_ids : null,
        linked_chittai_id || null,
        linked_chittai_ids?.length ? linked_chittai_ids : null,
        photo_url || null,
        created_by || null,
        req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );
    const entryId = result.rows[0].id;

    if (items?.length) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO hallmark_expense_items
            (hallmark_expense_id, sl_no, description, quantity, rate, tax_percent, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            entryId,
            item.sl_no,
            item.description,
            item.quantity,
            item.rate,
            item.tax_percent,
            item.amount,
          ],
        );
      }
    }

    // Back-link vouchers and chittai
    if (linked_voucher_ids?.length) {
      for (const vid of linked_voucher_ids) {
        await pool.query(
          `UPDATE vouchers SET linked_purchase_id=$1 WHERE id=$2`,
          [entryId, vid],
        );
      }
    }
    if (linked_chittai_ids?.length) {
      for (const cid of linked_chittai_ids) {
        await pool.query(
          `UPDATE chittai SET linked_purchase_id=$1 WHERE id=$2`,
          [entryId, cid],
        );
      }
    }

    res.json({ status: "SUCCESS", id: entryId });
  } catch (err) {
    console.error("HALLMARK-EXPENSES POST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hallmark-expenses/list", async (req, res) => {
  const { profile_id } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id) {
      params.push(profile_id);
      where = `WHERE he.profile_id=$1`;
    }
    const result = await pool.query(
      `SELECT he.*, u.name AS created_by_name
       FROM hallmark_expenses he
       LEFT JOIN auth_users u ON u.user_id::text = he.created_by
       ${where} ORDER BY he.created_at DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hallmark-expenses/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT * FROM hallmark_expenses WHERE id=$1", [
      req.params.id,
    ]);
    if (!p.rows[0]) return res.status(404).json({ error: "Not found" });
    const items = await pool.query(
      "SELECT * FROM hallmark_expense_items WHERE hallmark_expense_id=$1 ORDER BY sl_no",
      [req.params.id],
    );
    res.json({ entry: p.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/labour", async (req, res) => {
  const {
    profile_id,
    company_name,
    date,
    issue_number,
    labour_item_type,
    items,
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO labour (profile_id, company_name, date, issue_number, labour_item_type, voucher_type, created_by)
       VALUES ($1, $2, $3, $4, $5, 'ISSUE VOUCHER', $6) RETURNING *`,
      [
        profile_id,
        company_name,
        date,
        issue_number,
        labour_item_type,
        req.body.created_by || null,
      ],
    );
    const labourId = result.rows[0].id;
    for (const item of items) {
      await pool.query(
        `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          labourId,
          item.sl_no,
          item.description,
          item.quantity,
          item.rate,
          item.amount,
        ],
      );
    }
    res.json({ status: "SUCCESS", id: labourId });
  } catch (err) {
    console.error("LABOUR POST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/chittai/list/all", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.name AS created_by_name FROM chittai c LEFT JOIN auth_users u ON u.user_id::text = c.created_by ORDER BY c.date DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chittai/list", async (req, res) => {
  const { profile_id, is_paid } = req.query;
  if (!profile_id) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT * FROM chittai WHERE profile_id = $1 AND (is_paid = $2 OR is_paid IS NULL) ORDER BY date DESC`,
      [profile_id, is_paid === "false" ? false : true],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/chittai/:id", async (req, res) => {
  const {
    is_paid,
    profile_id,
    chittai_no,
    date,
    weight,
    rate,
    value,
    others,
    total,
    tds,
    rtgs_amount,
    linked_voucher_id,
  } = req.body;
  try {
    let result;
    if (profile_id !== undefined) {
      result = await pool.query(
        `UPDATE chittai SET profile_id=$1, chittai_no=$2, date=$3, weight=$4, rate=$5, value=$6, others=$7, total=$8, tds=$9, rtgs_amount=$10, photo_url=COALESCE($11, photo_url), photo_urls=COALESCE($12, photo_urls), remarks=COALESCE($13, remarks) WHERE id=$14 RETURNING *`,
        [
          profile_id,
          chittai_no,
          date,
          weight,
          rate,
          value,
          others || 0,
          total,
          tds || 0,
          rtgs_amount,
          req.body.photo_url !== undefined ? req.body.photo_url || null : null,
          req.body.photo_urls?.length ? req.body.photo_urls : null,
          req.body.remarks !== undefined ? req.body.remarks || null : null,
          req.params.id,
        ],
      );
    } else if (linked_voucher_id !== undefined) {
      result = await pool.query(
        `UPDATE chittai SET linked_voucher_id=$1, is_paid=COALESCE($2, is_paid) WHERE id=$3 RETURNING *`,
        [linked_voucher_id, is_paid, req.params.id],
      );
    } else {
      result = await pool.query(
        `UPDATE chittai SET is_paid = $1 WHERE id = $2 RETURNING *`,
        [is_paid, req.params.id],
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chittai/next-no", async (req, res) => {
  const { prefix } = req.query;
  try {
    const result = await pool.query(
      `SELECT chittai_no FROM chittai WHERE chittai_no LIKE $1 ORDER BY chittai_no DESC LIMIT 1`,
      [`${prefix}%`],
    );
    if (!result.rows.length) return res.json({ chittai_no: `${prefix}001` });
    const last = result.rows[0].chittai_no;
    const parts = last.split("-");
    const num = parseInt(parts[parts.length - 1]) + 1;
    res.json({ chittai_no: `${prefix}${String(num).padStart(3, "0")}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chittai", async (req, res) => {
  const {
    profile_id,
    chittai_no,
    date,
    weight,
    rate,
    value,
    others,
    total,
    tds,
    rtgs_amount,
    photo_url,
    remarks,
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO chittai (profile_id, chittai_no, date, weight, rate, value, others, total, tds, rtgs_amount, created_by, photo_url, remarks, photo_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        profile_id,
        chittai_no,
        date,
        weight,
        rate,
        value,
        others || 0,
        total,
        tds || 0,
        rtgs_amount,
        req.body.created_by || null,
        photo_url || null,
        remarks || null,
        req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );
    const chittai_id = result.rows[0].id;
    const { is_paid, pay_date, pay_amount, pay_mop } = req.body;
    if (is_paid && pay_date && pay_amount && pay_mop) {
      await pool.query(
        `INSERT INTO vouchers (profile_id, voucher_type, date, bill_no, entry_type, description, total_value, linked_chittai_id)
         VALUES ($1,'Chittai Payment',$2,$3,'against',$4,$5,$6)`,
        [
          profile_id,
          pay_date,
          chittai_no,
          `Payment against Chittai ${chittai_no} via ${pay_mop}`,
          pay_amount,
          chittai_id,
        ],
      );
      await pool.query(`UPDATE chittai SET is_paid=true WHERE id=$1`, [
        chittai_id,
      ]);
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/tax-formats", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, percent FROM tax_format ORDER BY percent ASC",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tds", async (req, res) => {
  const { section } = req.query;
  try {
    let result;
    if (section) {
      result = await pool.query(
        "SELECT id, pan_4th_letter, section, entity_type, tds_percentage, remarks FROM tds WHERE section = $1 ORDER BY pan_4th_letter",
        [section],
      );
    } else {
      result = await pool.query(
        "SELECT id, pan_4th_letter, section, entity_type, tds_percentage, remarks FROM tds ORDER BY section, pan_4th_letter",
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("TDS LIST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/descriptions/metal", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name, metal_type FROM descriptions ORDER BY name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/descriptions", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name FROM descriptions ORDER BY name",
    );
    res.json(result.rows.map((r) => r.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Update an IV and cascade the issue_number change to all linked RVs
app.put("/api/labour/:id/with-cascade", async (req, res) => {
  const {
    profile_id,
    company_name,
    date,
    issue_number,
    labour_item_type,
    items,
    old_issue_number,
  } = req.body;
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE labour SET profile_id=$1, company_name=$2, date=$3, issue_number=$4, labour_item_type=$5 WHERE id=$6`,
      [profile_id, company_name, date, issue_number, labour_item_type, id],
    );
    if (items && items.length) {
      await client.query(`DELETE FROM labour_items WHERE labour_id=$1`, [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id,
            item.sl_no,
            item.description,
            item.quantity,
            item.rate,
            item.amount,
          ],
        );
      }
    }

    let updated_rv_count = 0;
    if (old_issue_number && issue_number && old_issue_number !== issue_number) {
      const rvs = await client.query(
        `SELECT id, issue_number FROM labour
         WHERE voucher_type = 'Receipt Voucher' AND profile_id = $1 AND issue_number IS NOT NULL`,
        [profile_id],
      );
      for (const rv of rvs.rows) {
        const parts = rv.issue_number.split(",").map((s) => s.trim());
        const idx = parts.indexOf(old_issue_number);
        if (idx !== -1) {
          parts[idx] = issue_number;
          await client.query(`UPDATE labour SET issue_number=$1 WHERE id=$2`, [
            parts.join(","),
            rv.id,
          ]);
          updated_rv_count++;
        }
      }
    }

    await client.query("COMMIT");
    res.json({ status: "SUCCESS", updated_rv_count });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/api/labour/:id", async (req, res) => {
  const {
    profile_id,
    company_name,
    date,
    issue_number,
    labour_item_type,
    items,
    receipt_bill_no,
    taxable_total,
    cgst,
    sgst,
    igst,
    round_off,
    total,
    tds,
    bill_value_after_deduction,
  } = req.body;
  try {
    if (profile_id !== undefined) {
      await pool.query(
        `UPDATE labour SET profile_id=$1, company_name=$2, date=$3, issue_number=$4, labour_item_type=$5 WHERE id=$6`,
        [
          profile_id,
          company_name,
          date,
          issue_number,
          labour_item_type,
          req.params.id,
        ],
      );
    } else {
      await pool.query(
        `UPDATE labour SET date=$1, receipt_bill_no=$2, taxable_total=$3, cgst=$4, sgst=$5, igst=$6, round_off=$7, total=$8, tds=$9, bill_value_after_deduction=$10, photo_url=COALESCE($11, photo_url), photo_urls=COALESCE($12, photo_urls) WHERE id=$13`,
        [
          date,
          receipt_bill_no,
          taxable_total || null,
          cgst || null,
          sgst || null,
          igst || null,
          round_off || null,
          total || null,
          tds || null,
          bill_value_after_deduction || null,
          req.body.photo_url || null,
          req.body.photo_urls?.length ? req.body.photo_urls : null,
          req.params.id,
        ],
      );
    }
    if (items && items.length) {
      await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [
        req.params.id,
      ]);
      for (const item of items) {
        await pool.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            req.params.id,
            item.sl_no,
            item.description,
            item.quantity,
            item.rate,
            item.amount,
          ],
        );
      }
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/can-delete", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.json({ can_delete: false });
  try {
    const result = await pool.query(
      "SELECT can_delete FROM auth_users WHERE user_id=$1",
      [user_id],
    );
    res.json({ can_delete: result.rows[0]?.can_delete || false });
  } catch (err) {
    res.json({ can_delete: false });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  const { user_id, name, email, password } = req.body;
  try {
    const existing = await pool.query(
      "SELECT * FROM auth_users WHERE user_id = $1",
      [user_id],
    );
    if (!existing.rows[0])
      return res.json({ error: "ID not found. Request your ID from admin." });
    if (existing.rows[0].password)
      return res.json({ error: "Account already exists for this ID." });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "UPDATE auth_users SET name=$1, email=$2, password=$3 WHERE user_id=$4",
      [name, email, hash, user_id],
    );
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { user_id, password } = req.body;
  try {
    const result = await pool.query(
      "SELECT * FROM auth_users WHERE user_id = $1",
      [user_id],
    );
    const user = result.rows[0];
    if (!user || !user.password)
      return res.json({ error: "ID not found or account not set up." });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ error: "Incorrect password." });
    res.json({
      status: "SUCCESS",
      user: {
        id: user.user_id,
        name: user.name,
        can_delete: user.can_delete || false,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { user_id, key, new_password } = req.body;
  if (!user_id || !key || !new_password)
    return res.json({ error: "All fields are required." });
  if (new_password.length < 6)
    return res.json({ error: "Password must be at least 6 characters." });
  try {
    const result = await pool.query(
      "SELECT id, reset_key FROM auth_users WHERE user_id=$1",
      [user_id],
    );
    const user = result.rows[0];
    if (!user) return res.json({ error: "User ID not found." });
    if (
      !user.reset_key ||
      user.reset_key.toUpperCase() !== key.trim().toUpperCase()
    )
      return res.json({ error: "Invalid key. Please contact admin." });
    const hash = await bcrypt.hash(new_password, 10);
    const newKey = generateResetKey();
    await pool.query(
      "UPDATE auth_users SET password=$1, reset_key=$2 WHERE id=$3",
      [hash, newKey, user.id],
    );
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: view all users with their reset keys
app.get("/api/auth/admin-keys", async (req, res) => {
  const { requester_id } = req.query;
  if (!requester_id) return res.status(403).json({ error: "Forbidden" });
  try {
    const check = await pool.query(
      "SELECT can_delete FROM auth_users WHERE user_id=$1",
      [requester_id],
    );
    if (!check.rows[0]?.can_delete)
      return res.status(403).json({ error: "Admin access required." });
    const result = await pool.query(
      "SELECT user_id, name, reset_key FROM auth_users WHERE is_active=true ORDER BY name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/login", (req, res) =>
  res.sendFile(path.join(__dirname, "login.html")),
);
app.get("/labclose", (req, res) =>
  res.sendFile(path.join(__dirname, "labclose.html")),
);
app.get("/reports/transaction", (req, res) =>
  res.sendFile(path.join(__dirname, "trnsrpt.html")),
);
app.get("/reports/iv-rv", (req, res) =>
  res.sendFile(path.join(__dirname, "vhrrpt.html")),
);
app.get("/reports/chittai", (req, res) =>
  res.sendFile(path.join(__dirname, "ctirpt.html")),
);
app.get("/reports/purchase", (req, res) =>
  res.sendFile(path.join(__dirname, "prchsrpt.html")),
);
app.get("/reports/tds", (req, res) =>
  res.sendFile(path.join(__dirname, "tds.html")),
);
app.get("/company", (req, res) =>
  res.sendFile(path.join(__dirname, "company.html")),
);
app.get("/dashboard", (req, res) =>
  res.sendFile(path.join(__dirname, "dashboard.html")),
);

// ── LINKED DATA ──
app.get("/api/linked-data/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  try {
    const linked = [];
    if (type === "issue") {
      const rvs = await pool.query(
        `SELECT id, receipt_bill_no, date FROM labour WHERE voucher_type='Receipt Voucher' AND (issue_number=(SELECT issue_number FROM labour WHERE id=$1) OR issue_number LIKE '%' || (SELECT issue_number FROM labour WHERE id=$1) || '%')`,
        [id],
      );
      rvs.rows.forEach((r) =>
        linked.push({
          type: "receipt",
          id: r.id,
          label: `Receipt Voucher: ${r.receipt_bill_no || "ID-" + r.id} (${r.date?.toString().slice(0, 10)})`,
        }),
      );
    }
    if (type === "receipt") {
      const vs = await pool.query(
        `SELECT id, bill_no, total_value FROM vouchers WHERE linked_labour_id=$1`,
        [id],
      );
      vs.rows.forEach((v) =>
        linked.push({
          type: "voucher",
          id: v.id,
          label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}`,
        }),
      );
    }
    if (type === "txn") {
      // no deep links for vouchers
    }
    if (type === "purchase") {
      const vs = await pool.query(
        `SELECT id, bill_no, total_value FROM vouchers WHERE linked_purchase_id=$1`,
        [id],
      );
      vs.rows.forEach((v) =>
        linked.push({
          type: "voucher",
          id: v.id,
          label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}`,
        }),
      );
    }
    if (type === "chittai") {
      const vs = await pool.query(
        `SELECT id, bill_no, total_value FROM vouchers WHERE linked_chittai_id=$1`,
        [id],
      );
      vs.rows.forEach((v) =>
        linked.push({
          type: "voucher",
          id: v.id,
          label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}`,
        }),
      );
      const ps = await pool.query(
        `SELECT id, bill_no FROM purchases WHERE linked_chittai_id=$1`,
        [id],
      );
      ps.rows.forEach((p) =>
        linked.push({
          type: "purchase",
          id: p.id,
          label: `Purchase: ${p.bill_no || "ID-" + p.id}`,
        }),
      );
    }
    res.json(linked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function deleteCloudinaryPhoto(photo_url) {
  if (!photo_url) return;
  try {
    const clean = photo_url.split("?")[0];
    const match = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return;
    const public_id = match[1].replace(/\.[^/.]+$/, "");
    const isPdf = /\.pdf$/i.test(clean);
    await cloudinary.uploader.destroy(public_id, {
      resource_type: isPdf ? "raw" : "image",
      invalidate: true,
    });
  } catch (e) {
    console.error("CLOUDINARY DELETE FAIL:", e.message);
  }
}

async function deleteAllPhotos(row) {
  if (row.photo_url) await deleteCloudinaryPhoto(row.photo_url);
  if (row.photo_urls?.length) {
    for (const u of row.photo_urls) await deleteCloudinaryPhoto(u);
  }
}

app.delete("/api/delete-entry", async (req, res) => {
  const { type, id, linked } = req.body;
  try {
    // Delete linked items first
    if (linked && linked.length) {
      for (const l of linked) {
        if (l.type === "voucher")
          await pool.query(`DELETE FROM vouchers WHERE id=$1`, [l.id]);
        if (l.type === "receipt") {
          const ph = await pool.query(
            `SELECT photo_url, photo_urls FROM labour WHERE id=$1`,
            [l.id],
          );
          if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
          await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [
            l.id,
          ]);
          await pool.query(`DELETE FROM labour WHERE id=$1`, [l.id]);
        }
        if (l.type === "purchase") {
          const ph = await pool.query(
            `SELECT photo_url, photo_urls FROM purchases WHERE id=$1`,
            [l.id],
          );
          if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
          await pool.query(
            `UPDATE vouchers SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`,
            [l.id],
          );
          await pool.query(
            `UPDATE chittai SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`,
            [l.id],
          );
          await pool.query(`DELETE FROM purchases WHERE id=$1`, [l.id]);
        }
      }
    }
    // Delete main entry
    if (type === "issue" || type === "receipt") {
      const ph = await pool.query(
        `SELECT photo_url, photo_urls FROM labour WHERE id=$1`,
        [id],
      );
      if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
      await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [id]);
      await pool.query(`DELETE FROM labour WHERE id=$1`, [id]);
    }
    if (type === "txn")
      await pool.query(`DELETE FROM vouchers WHERE id=$1`, [id]);
    if (type === "purchase") {
      const group = await pool.query(
        `SELECT id, photo_url, photo_urls FROM purchases WHERE bill_no=(SELECT bill_no FROM purchases WHERE id=$1) AND profile_id=(SELECT profile_id FROM purchases WHERE id=$1)`,
        [id],
      );
      for (const row of group.rows) {
        await deleteAllPhotos(row);
        await pool.query(
          `UPDATE vouchers SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`,
          [row.id],
        );
        await pool.query(
          `UPDATE chittai SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`,
          [row.id],
        );
        await pool.query(`DELETE FROM purchase_items WHERE purchase_id=$1`, [
          row.id,
        ]);
        await pool.query(`DELETE FROM purchases WHERE id=$1`, [row.id]);
      }
    }
    if (type === "chittai") {
      const ph = await pool.query(
        `SELECT photo_url, photo_urls FROM chittai WHERE id=$1`,
        [id],
      );
      if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
      await pool.query(
        `UPDATE vouchers SET linked_chittai_id=NULL WHERE linked_chittai_id=$1`,
        [id],
      );
      await pool.query(
        `UPDATE purchases SET linked_chittai_id=NULL WHERE linked_chittai_id=$1`,
        [id],
      );
      await pool.query(`DELETE FROM chittai WHERE id=$1`, [id]);
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/todos", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT t.id, t.title, t.giver, t.receiver,
              COALESCE(u.name, t.receiver) AS receiver_name,
              to_char(t.date,'YYYY-MM-DD') as date, t.time, t.notes, t.status, t.priority, t.photo, t.replies, t.seen_at, t.done_at, t.created_at
       FROM todos t
       LEFT JOIN auth_users u ON u.user_id = t.receiver
       WHERE t.receiver='all' OR t.receiver=$1 OR t.giver=$1 OR t.giver=(SELECT name FROM auth_users WHERE user_id=$1)
       ORDER BY t.created_at DESC`,
      [user_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/todos", async (req, res) => {
  const { title, giver, receiver, date, time, notes, priority, photo } =
    req.body;
  try {
    const result = await pool.query(
      `INSERT INTO todos (title, giver, receiver, date, time, notes, priority, photo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        title,
        giver,
        receiver,
        date,
        time,
        notes || null,
        priority || "medium",
        photo || null,
      ],
    );
    res.json({ status: "SUCCESS", todo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/todos/:id/reply", async (req, res) => {
  const { sender, text, photo } = req.body;
  try {
    const result = await pool.query(`SELECT replies FROM todos WHERE id=$1`, [
      req.params.id,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    const replies = result.rows[0].replies || [];
    replies.push({
      id: Date.now(),
      sender,
      text: text || "",
      photo: photo || null,
      created_at: new Date().toISOString(),
      seen_by: [sender],
    });
    await pool.query(`UPDATE todos SET replies=$1 WHERE id=$2`, [
      JSON.stringify(replies),
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/todos/:id/replies-seen", async (req, res) => {
  const { user } = req.body;
  try {
    const result = await pool.query(`SELECT replies FROM todos WHERE id=$1`, [
      req.params.id,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    const replies = (result.rows[0].replies || []).map((r) => {
      if (!r.seen_by) r.seen_by = [];
      if (!r.seen_by.includes(user)) r.seen_by.push(user);
      return r;
    });
    await pool.query(`UPDATE todos SET replies=$1 WHERE id=$2`, [
      JSON.stringify(replies),
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/todos/:id", async (req, res) => {
  const { status } = req.body;
  try {
    const col =
      status === "seen" ? "seen_at" : status === "done" ? "done_at" : null;
    if (col) {
      await pool.query(`UPDATE todos SET status=$1, ${col}=NOW() WHERE id=$2`, [
        status,
        req.params.id,
      ]);
    } else {
      await pool.query(`UPDATE todos SET status=$1 WHERE id=$2`, [
        status,
        req.params.id,
      ]);
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/todos/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM todos WHERE id=$1`, [req.params.id]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/users-list", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT user_id, name FROM auth_users WHERE is_active=true AND password IS NOT NULL ORDER BY name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PHOTO UPLOAD SESSION ROUTES ──

// PC creates an upload session
app.post("/api/upload-session", (req, res) => {
  const { bill_no, company, folder, bill_date } = req.body;
  const token = crypto.randomBytes(8).toString("hex");
  const finalFolder = ALLOWED_FOLDERS.has(folder) ? folder : "purchase_bills";
  uploadSessions.set(token, {
    bill_no: bill_no || "",
    company: company || "",
    folder: finalFolder,
    bill_date: bill_date || null,
    photo_url: null,
    expires: Date.now() + 30 * 60 * 1000, // 30 min
  });
  res.json({ token });
});

// Phone loads session info
app.get("/api/upload-session/:token/status", (req, res) => {
  const session = uploadSessions.get(req.params.token);
  if (!session) return res.json({ error: "Invalid or expired" });
  res.json({
    bill_no: session.bill_no,
    company: session.company,
    uploaded: !!session.photo_url,
    photo_url: session.photo_url,
  });
});

// Phone uploads the photo
// The uploader reads session.folder dynamically inside makeUploader
function pickUploader(req, res, next) {
  upload.single("photo")(req, res, next);
}

app.post("/api/upload-session/:token/upload", pickUploader, (req, res) => {
  const session = uploadSessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: "Invalid or expired" });
  if (!req.file) return res.status(400).json({ error: "No file" });
  session.photo_url = req.file.path;
  res.json({ status: "SUCCESS", photo_url: session.photo_url });
});

// Phone upload page
app.get("/upload/:token", (req, res) =>
  res.sendFile(path.join(__dirname, "mobile-upload.html")),
);

// Mark accounted
app.patch("/api/purchases/:id/accounted", async (req, res) => {
  try {
    await pool.query(`UPDATE purchases SET is_accounted = $1 WHERE id = $2`, [
      req.body.is_accounted,
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update purchase photo (for retake)
app.patch("/api/purchases/:id/photo", async (req, res) => {
  try {
    await pool.query(`UPDATE purchases SET photo_url = $1 WHERE id = $2`, [
      req.body.photo_url || null,
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Media page
app.get("/media", (req, res) =>
  res.sendFile(path.join(__dirname, "media.html")),
);

// Chittai photo direct upload (PC)
app.post("/api/chittai-upload", uploadChittai.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ status: "SUCCESS", photo_url: req.file.path });
});

// Update chittai photo (for retake)
app.patch("/api/chittai/:id/photo", async (req, res) => {
  try {
    await pool.query(`UPDATE chittai SET photo_url = $1 WHERE id = $2`, [
      req.body.photo_url || null,
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Monthly Schedule Templates ──
app.get("/api/schedule/templates", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM schedule_templates ORDER BY day_of_month ASC",
  );
  res.json(rows);
});

app.post("/api/schedule/templates", async (req, res) => {
  const { title, receiver, priority, day_of_month, deadline_days, notes } =
    req.body;
  const { rows } = await pool.query(
    "INSERT INTO schedule_templates (title, receiver, priority, day_of_month, deadline_days, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [title, receiver, priority, day_of_month, deadline_days, notes],
  );
  res.json(rows[0]);
});

app.delete("/api/schedule/templates/:id", async (req, res) => {
  await pool.query("DELETE FROM schedule_templates WHERE id=$1", [
    req.params.id,
  ]);
  res.json({ status: "SUCCESS" });
});

// ── Monthly Schedule Instances ──
app.get("/api/schedule/instances", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM schedule_instances ORDER BY scheduled_date ASC",
  );
  res.json(rows);
});

app.post("/api/schedule/instances", async (req, res) => {
  const {
    template_id,
    title,
    receiver,
    priority,
    notes,
    scheduled_date,
    deadline_date,
    status,
  } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO schedule_instances (template_id, title, receiver, priority, notes, scheduled_date, deadline_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [
      template_id,
      title,
      receiver,
      priority,
      notes,
      scheduled_date,
      deadline_date,
      status || "pending",
    ],
  );
  res.json(rows[0]);
});

app.patch("/api/schedule/instances/:id", async (req, res) => {
  const { status, done_at } = req.body;
  const { rows } = await pool.query(
    "UPDATE schedule_instances SET status=$1, done_at=$2 WHERE id=$3 RETURNING *",
    [status, done_at || null, req.params.id],
  );
  res.json(rows[0]);
});

app.delete("/api/schedule/instances/:id", async (req, res) => {
  await pool.query("DELETE FROM schedule_instances WHERE id=$1", [
    req.params.id,
  ]);
  res.json({ status: "SUCCESS" });
});

app.patch("/api/labour/:id/accounted", async (req, res) => {
  try {
    await pool.query(`UPDATE labour SET is_accounted = $1 WHERE id = $2`, [
      req.body.is_accounted,
      req.params.id,
    ]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Shared helpers ──
const CLOUDINARY_FOLDERS = [
  "purchase_bills",
  "chittai_bills",
  "labour_receipts",
  "hallmark_bills",
  "expense_bills",
  "credit_notes",
  "debit_notes",
  "refinery_bills",
];

async function fetchAllCloudinaryResources() {
  const auth = Buffer.from(
    `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`,
  ).toString("base64");
  let all = [];
  for (const folder of CLOUDINARY_FOLDERS) {
    for (const resource_type of ["image", "raw"]) {
      let nextCursor = null;
      do {
        const params = new URLSearchParams({
          type: "upload",
          prefix: folder,
          max_results: 500,
          resource_type,
        });
        if (nextCursor) params.append("next_cursor", nextCursor);
        const r = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/${resource_type}?${params}`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        const d = await r.json();
        (d.resources || []).forEach((res) =>
          all.push({
            public_id: res.public_id,
            url: res.secure_url,
            created_at: res.created_at,
            folder,
            bytes: res.bytes,
            format: res.format,
            resource_type,
            is_pdf: resource_type === "raw",
          }),
        );
        nextCursor = d.next_cursor || null;
      } while (nextCursor);
    }
  }
  return all;
}

function extractPublicIdFromUrl(url) {
  if (!url) return null;
  const clean = url.split("?")[0];
  const match = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? match[1].replace(/\.[^/.]+$/, "") : null;
}

async function getLinkedPublicIds() {
  const [pRes, lRes, cRes, hRes, puRes, luRes, cuRes, huRes] =
    await Promise.all([
      pool.query("SELECT photo_url FROM purchases WHERE photo_url IS NOT NULL"),
      pool.query("SELECT photo_url FROM labour WHERE photo_url IS NOT NULL"),
      pool.query("SELECT photo_url FROM chittai WHERE photo_url IS NOT NULL"),
      pool
        .query(
          "SELECT photo_url FROM hallmark_expenses WHERE photo_url IS NOT NULL",
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          "SELECT unnest(photo_urls) AS u FROM purchases WHERE photo_urls IS NOT NULL",
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          "SELECT unnest(photo_urls) AS u FROM labour WHERE photo_urls IS NOT NULL",
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          "SELECT unnest(photo_urls) AS u FROM chittai WHERE photo_urls IS NOT NULL",
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(
          "SELECT unnest(photo_urls) AS u FROM hallmark_expenses WHERE photo_urls IS NOT NULL",
        )
        .catch(() => ({ rows: [] })),
    ]);
  const linked = new Set();
  function addUrl(url) {
    const pid = extractPublicIdFromUrl(url);
    if (pid) {
      linked.add(pid);
      linked.add(pid + ".pdf");
      linked.add(pid + ".jpg");
      linked.add(pid + ".jpeg");
      linked.add(pid + ".png");
      linked.add(pid + ".webp");
    }
  }
  for (const row of [...pRes.rows, ...lRes.rows, ...cRes.rows, ...hRes.rows])
    addUrl(row.photo_url);
  for (const row of [
    ...puRes.rows,
    ...luRes.rows,
    ...cuRes.rows,
    ...huRes.rows,
  ])
    addUrl(row.u);
  return linked;
}

async function findUnlinkedResources() {
  const [all, linked] = await Promise.all([
    fetchAllCloudinaryResources(),
    getLinkedPublicIds(),
  ]);
  return all.filter((r) => {
    const clean = r.public_id.replace(/\.[^/.]+$/, "");
    return !linked.has(r.public_id) && !linked.has(clean);
  });
}

app.get("/api/cloudinary/unlinked", async (req, res) => {
  try {
    const unlinked = await findUnlinkedResources();
    res.json(unlinked);
  } catch (err) {
    console.error("CLOUDINARY UNLINKED ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cloudinary/all-photos", async (req, res) => {
  try {
    const folders = [
      "purchase_bills",
      "chittai_bills",
      "labour_receipts",
      "hallmark_bills",
      "expense_bills",
      "credit_notes",
      "debit_notes",
      "refinery_bills",
    ];
    let allResources = [];

    for (const folder of folders) {
      let nextCursor = null;
      do {
        const params = new URLSearchParams({
          type: "upload",
          prefix: folder,
          max_results: 500,
          resource_type: "image",
        });
        if (nextCursor) params.append("next_cursor", nextCursor);

        const auth = Buffer.from(
          `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`,
        ).toString("base64");

        const response = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image?${params}`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        const data = await response.json();
        allResources = allResources.concat(
          (data.resources || []).map((r) => ({
            public_id: r.public_id,
            url: r.secure_url,
            created_at: r.created_at,
            folder: folder,
            bytes: r.bytes,
            format: r.format,
          })),
        );
        nextCursor = data.next_cursor || null;
      } while (nextCursor);
    }

    // Also fetch raw (PDF) resources
    for (const folder of folders) {
      let nextCursor = null;
      do {
        const params = new URLSearchParams({
          type: "upload",
          prefix: folder,
          max_results: 500,
          resource_type: "raw",
        });
        if (nextCursor) params.append("next_cursor", nextCursor);

        const auth = Buffer.from(
          `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`,
        ).toString("base64");

        const response = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/raw?${params}`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        const data = await response.json();
        allResources = allResources.concat(
          (data.resources || []).map((r) => ({
            public_id: r.public_id,
            url: r.secure_url,
            created_at: r.created_at,
            folder: folder,
            bytes: r.bytes,
            format: r.format,
            is_pdf: true,
          })),
        );
        nextCursor = data.next_cursor || null;
      } while (nextCursor);
    }

    allResources.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    res.json(allResources);
  } catch (err) {
    console.error("CLOUDINARY ALL PHOTOS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/cloudinary/delete-unlinked", async (req, res) => {
  try {
    const { public_ids } = req.body; // array of { public_id, resource_type }
    if (!public_ids || !public_ids.length)
      return res.json({ status: "SUCCESS", deleted: 0, failed: 0 });

    const auth = Buffer.from(
      `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`,
    ).toString("base64");

    const deleted = [];
    const failed = [];

    async function deleteBatch(ids, resource_type) {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const response = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/${resource_type}/upload`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ public_ids: batch }),
          },
        );
        const data = await response.json();
        if (data.deleted)
          Object.keys(data.deleted).forEach((k) => deleted.push(k));
        if (data.failed)
          Object.keys(data.failed).forEach((k) => failed.push(k));
      }
    }

    const imageIds = public_ids
      .filter((r) => r.resource_type !== "raw")
      .map((r) => r.public_id);
    const rawIds = public_ids
      .filter((r) => r.resource_type === "raw")
      .map((r) => r.public_id);
    await deleteBatch(imageIds, "image");
    await deleteBatch(rawIds, "raw");

    res.json({
      status: "SUCCESS",
      deleted: deleted.length,
      failed: failed.length,
      deleted_ids: deleted,
      failed_ids: failed,
    });
  } catch (err) {
    console.error("DELETE UNLINKED ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/cloudinary/move-photo", async (req, res) => {
  const { public_id, target_folder } = req.body;
  if (!public_id || !target_folder) {
    return res
      .status(400)
      .json({ error: "public_id and target_folder required" });
  }
  if (!ALLOWED_FOLDERS.has(target_folder)) {
    return res.status(400).json({ error: "Invalid target folder" });
  }

  try {
    const filename = public_id.split("/").pop();
    const new_public_id = `${target_folder}/${filename}`;

    const isPdf = /\.pdf$/i.test(filename);
    const resource_type = isPdf ? "raw" : "image";

    const result = await cloudinary.uploader.rename(public_id, new_public_id, {
      resource_type,
      invalidate: true,
      overwrite: false,
    });

    // Update DB photo_url to new URL
    const newUrl = result.secure_url;
    const oldUrlPatterns = [
      `%/${public_id}%`,
      `%/${public_id.replace(/\.[^/.]+$/, "")}%`,
    ];

    for (const pattern of oldUrlPatterns) {
      await pool.query(
        `UPDATE purchases SET photo_url=$1 WHERE photo_url LIKE $2`,
        [newUrl, pattern],
      );
      await pool.query(
        `UPDATE labour SET photo_url=$1 WHERE photo_url LIKE $2`,
        [newUrl, pattern],
      );
      await pool.query(
        `UPDATE chittai SET photo_url=$1 WHERE photo_url LIKE $2`,
        [newUrl, pattern],
      );
      await pool
        .query(
          `UPDATE hallmark_expenses SET photo_url=$1 WHERE photo_url LIKE $2`,
          [newUrl, pattern],
        )
        .catch(() => {});
    }

    res.json({ status: "SUCCESS", new_public_id, new_url: newUrl });
  } catch (err) {
    console.error("MOVE PHOTO ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── AI Scan ──────────────────────────────────────────────────────────────────
const AI_SCAN_PROMPTS = {
  purchase: `You are a bill/invoice OCR assistant. Extract fields from this bill image and return ONLY valid JSON (no markdown, no explanation).
Return this structure:
{
  "bill_no": "",
  "date": "YYYY-MM-DD or empty",
  "supplier_name": "",
  "taxable_value": null,
  "cgst": null,
  "sgst": null,
  "igst": null,
  "round_off": null,
  "total_value": null,
  "tds": null,
  "net_value": null,
  "items": [{"description":"","huid":"","pcs":null,"gross_wt":null,"less_wt":null,"net_wt":null,"rate":null,"amount":null}]
}
Use null for missing numbers. Extract all jewellery line items you can see.`,

  labclose: `You are a labour receipt OCR assistant. Extract fields from this receipt image and return ONLY valid JSON (no markdown, no explanation).
Return this structure:
{
  "receipt_bill_no": "",
  "date": "YYYY-MM-DD or empty",
  "party_name": "",
  "taxable_total": null,
  "cgst": null,
  "sgst": null,
  "igst": null,
  "round_off": null,
  "total": null,
  "tds": null,
  "bill_value_after_deduction": null,
  "items": [{"description":"","pcs":null,"gross_wt":null,"less_wt":null,"net_wt":null,"labour_charge":null,"amount":null}]
}
Use null for missing numbers.`,

  chittai: `You are a chittai/advance slip OCR assistant. Extract fields from this slip image and return ONLY valid JSON (no markdown, no explanation).
Return this structure:
{
  "chittai_no": "",
  "date": "YYYY-MM-DD or empty",
  "party_name": "",
  "weight": null,
  "rate": null,
  "value": null,
  "others": null,
  "rnd": null,
  "total": null,
  "tds": null,
  "rtgs_amount": null
}
Use null for missing numbers. "rnd" is round-off/rounding amount if present.`,

  hallmark: `You are a hallmark expense bill OCR assistant. Extract fields from this bill image and return ONLY valid JSON (no markdown, no explanation).
Return this structure:
{
  "bill_no": "",
  "date": "YYYY-MM-DD or empty",
  "party_name": "",
  "taxable_value": null,
  "cgst": null,
  "sgst": null,
  "igst": null,
  "round_off": null,
  "total_value": null,
  "tds": null,
  "net_value": null,
  "items": [{"description":"","pcs":null,"gross_wt":null,"net_wt":null,"rate":null,"amount":null}]
}
Use null for missing numbers.`,

  note: `You are a credit/debit note OCR assistant. Extract fields from this note image and return ONLY valid JSON (no markdown, no explanation).
Return this structure:
{
  "bill_no": "",
  "date": "YYYY-MM-DD or empty",
  "party_name": "",
  "taxable_value": null,
  "cgst": null,
  "sgst": null,
  "igst": null,
  "round_off": null,
  "total_value": null,
  "tds": null,
  "net_value": null,
  "items": [{"description":"","pcs":null,"gross_wt":null,"net_wt":null,"rate":null,"amount":null}]
}
Use null for missing numbers.`,
};

const GEMINI_MODELS = ["gemini-2.0-flash-lite", "gemini-2.0-flash"];

async function geminiScan(prompt, mimeType, b64) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await genAI.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: b64 } },
              ],
            },
          ],
        });
        return response.text || "{}";
      } catch (err) {
        lastErr = err;
        const msg = err.message || "";
        if (msg.includes("429")) {
          const waitMs = 20000 * (attempt + 1);
          console.warn(
            `AI SCAN: 429 on ${model}, waiting ${waitMs / 1000}s...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (msg.includes("404") || msg.includes("not found")) {
          break;
        }
        throw err;
      }
    }
  }
  throw lastErr || new Error("No Gemini model available. Check your API key.");
}

app.post("/api/ai-scan", async (req, res) => {
  try {
    const { image_url, form_type } = req.body;
    if (!image_url)
      return res.status(400).json({ error: "image_url required" });
    const prompt = AI_SCAN_PROMPTS[form_type] || AI_SCAN_PROMPTS.purchase;

    const imgResp = await fetch(image_url);
    if (!imgResp.ok)
      return res.status(400).json({ error: "Could not fetch image" });
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const mimeType = contentType.startsWith("image/png")
      ? "image/png"
      : contentType.startsWith("image/webp")
        ? "image/webp"
        : contentType.startsWith("image/gif")
          ? "image/gif"
          : "image/jpeg";
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const b64 = buf.toString("base64");

    const raw = await geminiScan(prompt, mimeType, b64);
    const cleaned = raw
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/i, "")
      .trim();
    let fields;
    try {
      fields = JSON.parse(cleaned);
    } catch {
      fields = {};
    }
    res.json({ fields });
  } catch (err) {
    console.error("AI SCAN ERROR FULL:", err);
    console.error("AI SCAN ERROR MSG:", err.message);
    const is429 = err.message && err.message.includes("429");
    res.status(is429 ? 429 : 500).json({
      error: is429
        ? "AI quota exceeded. Already retried 3 times. Either wait a few minutes (per-minute limit) or try again tomorrow after 12:30 PM IST (daily limit hit)."
        : err.message,
    });
  }
});

app.get("/api/debug/photo-urls-type", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT table_name, column_name, udt_name, data_type
      FROM information_schema.columns
      WHERE column_name='photo_urls'
      ORDER BY table_name
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
