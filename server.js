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

initDB().catch(console.error);

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
      "SELECT alias, company_name AS company FROM profiles ORDER BY company_name",
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
        company_name=$1, address=$2, city=$3, pincode=$4, state=$5,
        state_code=$6, gst_number=$7, pan_number=$8, contact1=$9,
        contact2=$10, email=$11, ac_holder=$12, bank_name=$13,
        account_number=$14, ifsc_code=$15, branch=$16, updated_at=NOW()
      WHERE alias=$17`,
      [
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

// ── PAGES ──
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "entry.html")));
app.get("/profile", (req, res) =>
  res.sendFile(path.join(__dirname, "profile.html")),
);

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
