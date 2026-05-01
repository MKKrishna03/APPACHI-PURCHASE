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
  try {
    await pool.query(
      `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS voucher_type TEXT`,
    );
    console.log("✓ voucher_type column added to purchases");

    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='purchases' ORDER BY column_name`,
    );
    console.log("\npurchases columns:");
    cols.rows.forEach((r) => console.log(" ", r.column_name));

    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
})();
