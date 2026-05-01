require("dotenv").config();
const { Pool } = require("pg");

const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: u.hostname,
  port: u.port || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

(async () => {
  // 1. Does hallmark_expenses table exist?
  try {
    const t = await pool.query(
      "SELECT to_regclass('hallmark_expenses') AS exists",
    );
    console.log("hallmark_expenses table exists?", t.rows[0].exists);
  } catch (e) {
    console.log("Check 1 failed:", e.message, e.code);
  }

  // 2. Try counting it
  try {
    const a = await pool.query("SELECT COUNT(*) FROM hallmark_expenses");
    console.log("hallmark_expenses rows:", a.rows[0].count);
  } catch (e) {
    console.log("Check 2 failed:", e.message, e.code);
  }

  // 3. Count hallmark in purchases
  try {
    const b = await pool.query(
      "SELECT COUNT(*) FROM purchases WHERE voucher_type ILIKE '%hallmark%' OR description ILIKE '%hallmark%'",
    );
    console.log("purchases with hallmark:", b.rows[0].count);
  } catch (e) {
    console.log("Check 3 failed:", e.message, e.code);
  }

  // 4. Show recent purchases regardless
  try {
    const c = await pool.query(
      "SELECT id, bill_no, voucher_type, description, date FROM purchases ORDER BY id DESC LIMIT 25",
    );
    console.log("\nLast 25 purchase rows:");
    c.rows.forEach((r) => console.log(" ", r));
  } catch (e) {
    console.log("Check 4 failed:", e.message, e.code);
  }

  process.exit(0);
})();
