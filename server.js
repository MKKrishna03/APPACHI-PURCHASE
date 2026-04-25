const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const net = require("net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (options, ...args) {
  if (options && typeof options === "object") options.family = 4;
  return originalConnect.call(this, options, ...args);
};
require("dotenv").config();
process.env.TZ = "Asia/Kolkata";
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const bcrypt = require("bcrypt");
const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  allowExitOnIdle: false,
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
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
  await pool.query(
    `ALTER TABLE chittai ADD COLUMN IF NOT EXISTS created_by TEXT`,
  );
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
  console.log("DB ready");
}

initDB().catch((err) => {
  console.error("INITDB FAILED:", err.message);
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
      "SELECT id, alias, company_name AS company, state_code, ledger_types FROM profiles ORDER BY company_name",
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
              l.voucher_type, l.receipt_bill_no,
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
app.get("/api/labour/:id", async (req, res) => {
  if (req.params.id === "list")
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
      `SELECT * FROM labour ORDER BY created_at DESC`,
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
        `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
      `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
      `SELECT id, profile_id, voucher_type, date, bill_no, total_value, entry_type, description, linked_labour_id, linked_chittai_id, linked_purchase_id, created_at
       FROM vouchers
       ${where}
       ORDER BY created_at DESC`,
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
      `SELECT * FROM purchases ${where} ORDER BY created_at DESC`,
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
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO purchases (profile_id, date, bill_no, description, taxable_value, cgst, sgst, igst,
        round_off, total_value, tds, net_value, linked_voucher_id, linked_chittai_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
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
      ],
    );
    const purchaseId = result.rows[0].id;
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
    res.json({ status: "SUCCESS", id: purchaseId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/purchase", (req, res) =>
  res.sendFile(path.join(__dirname, "purchase.html")),
);
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
    const result = await pool.query(`SELECT * FROM chittai ORDER BY date DESC`);
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
        `UPDATE chittai SET profile_id=$1, chittai_no=$2, date=$3, weight=$4, rate=$5, value=$6, others=$7, total=$8, tds=$9, rtgs_amount=$10 WHERE id=$11 RETURNING *`,
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
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO chittai (profile_id, chittai_no, date, weight, rate, value, others, total, tds, rtgs_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
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
        `UPDATE labour SET date=$1, receipt_bill_no=$2, taxable_total=$3, cgst=$4, sgst=$5, igst=$6, round_off=$7, total=$8, tds=$9, bill_value_after_deduction=$10 WHERE id=$11`,
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
      user: { id: user.user_id, name: user.name },
    });
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

app.delete("/api/delete-entry", async (req, res) => {
  const { type, id, linked } = req.body;
  try {
    // Delete linked items first
    if (linked && linked.length) {
      for (const l of linked) {
        if (l.type === "voucher")
          await pool.query(`DELETE FROM vouchers WHERE id=$1`, [l.id]);
        if (l.type === "receipt") {
          await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [
            l.id,
          ]);
          await pool.query(`DELETE FROM labour WHERE id=$1`, [l.id]);
        }
        if (l.type === "purchase") {
          await pool.query(`DELETE FROM purchases WHERE id=$1`, [l.id]);
        }
      }
    }
    // Delete main entry
    if (type === "issue" || type === "receipt") {
      await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [id]);
      await pool.query(`DELETE FROM labour WHERE id=$1`, [id]);
    }
    if (type === "txn")
      await pool.query(`DELETE FROM vouchers WHERE id=$1`, [id]);
    if (type === "chittai") {
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

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
