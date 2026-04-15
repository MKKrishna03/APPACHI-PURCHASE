const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const net = require("net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (options, ...args) {
  if (options && typeof options === "object") options.family = 4;
  return originalConnect.call(this, options, ...args);
};
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  user: "neondb_owner",
  password: "npg_3XISZ5xTstNo",
  host: "35.173.20.131",
  port: 5432,
  database: "neondb",
  ssl: { rejectUnauthorized: false },
  family: 4,
  options: "endpoint=ep-little-sound-anrilgsw",
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

async function initDB() {
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
      "SELECT id, alias, company_name AS company, state_code FROM profiles ORDER BY company_name",
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/profiles/list", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, company_name AS name, state_code FROM profiles ORDER BY company_name",
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
         contact1,contact2,email,ac_holder,bank_name,account_number,ifsc_code,branch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        account_number=$15, ifsc_code=$16, branch=$17, updated_at=NOW()
      WHERE alias=$18`,
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
        alias,
      ],
    );
    res.json({ status: "SUCCESS" });
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
      where += `${where ? " AND" : " WHERE"} l.voucher_type = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT l.id, l.profile_id, l.company_name, l.date, l.issue_number, l.bill_no,
              l.voucher_type,
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
  const { labour_id, closing_date, closing_type, partial_qty, items } =
    req.body;

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
      `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, bill_no)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        labour.profile_id,
        labour.company_name,
        closing_date,
        labour.issue_number,
        "Receipt Voucher",
        req.body.bill_no || null,
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

    res.json({ status: "SUCCESS", id: close_labour_id });
  } catch (err) {
    console.error("CLOSE ISSUE VOUCHER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/labclose", (req, res) =>
  res.sendFile(path.join(__dirname, "labclose.html")),
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
    const result = await pool.query(
      `INSERT INTO vouchers
        (profile_id,voucher_type,date,bill_no,entry_type,description,
         qty,rate,va,taxable_value,tax_percent,igst,cgst,sgst,tax_amount,total_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
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
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("VOUCHER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/vouchers/list", async (req, res) => {
  const { profile_id, voucher_type } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id) {
      params.push(profile_id);
      where += `${where ? " AND" : " WHERE"} profile_id = $${params.length}`;
    }
    if (voucher_type) {
      params.push(`%${voucher_type}%`);
      where += `${where ? " AND" : " WHERE"} voucher_type ILIKE $${
        params.length
      }`;
    }
    const result = await pool.query(
      `SELECT id, profile_id, voucher_type, date, bill_no, total_value
       FROM vouchers
       ${where}
       ORDER BY created_at DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    console.error("VOUCHER LIST ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PAGES ──
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "dashboard.html")),
);
app.get("/profile", (req, res) =>
  res.sendFile(path.join(__dirname, "profile.html")),
);
app.get("/labour", (req, res) =>
  res.sendFile(path.join(__dirname, "labour.html")),
);
app.get("/transaction", (req, res) =>
  res.sendFile(path.join(__dirname, "transaction.html")),
);
app.get("/receipt", (req, res) =>
  res.sendFile(path.join(__dirname, "transaction.html")),
);
app.get("/payment", (req, res) =>
  res.sendFile(path.join(__dirname, "transaction.html")),
);

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
process.on("uncaughtException", (err) =>
  console.error("UNCAUGHT:", err.message, err.stack),
);
