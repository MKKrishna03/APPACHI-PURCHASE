require("dotenv").config();
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: u.hostname,
  port: u.port || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

function extractPublicId(url) {
  if (!url) return null;
  const clean = url.split("?")[0];
  const m = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  if (!m) return null;
  return m[1].replace(/\.[^/.]+$/, "");
}

async function main() {
  console.log("STEP 1: connecting to DB...");
  await pool.query("SELECT 1");
  console.log("  DB connected ✓");

  console.log("\nSTEP 2: checking purchases columns...");
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='purchases' ORDER BY column_name`,
  );
  const colSet = new Set(cols.rows.map((r) => r.column_name));
  console.log("  Has voucher_type?", colSet.has("voucher_type"));
  console.log("  Has photo_url?", colSet.has("photo_url"));
  console.log("  Has bill_no?", colSet.has("bill_no"));
  console.log("  Has profile_id?", colSet.has("profile_id"));

  console.log("\nSTEP 3: finding misplaced hallmark photos...");
  const result = await pool.query(`
    SELECT p1.id, p1.bill_no, p1.profile_id, p1.voucher_type, p1.photo_url
    FROM purchases p1
    WHERE p1.photo_url IS NOT NULL
      AND p1.bill_no IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM purchases p2
        WHERE p2.bill_no = p1.bill_no
          AND p2.profile_id = p1.profile_id
          AND p2.id <> p1.id
          AND (p2.voucher_type IS NULL OR p2.voucher_type NOT ILIKE '%hallmark%')
      )
      AND p1.photo_url ILIKE '%hallmark_bills%'
  `);
  console.log(`  Found ${result.rows.length} candidate(s)`);
  result.rows.forEach((r) => {
    console.log(
      `    id=${r.id} bill_no=${r.bill_no} vt=${r.voucher_type} url=${r.photo_url}`,
    );
  });

  if (result.rows.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  console.log("\nSTEP 4: moving photos...");
  let moved = 0,
    failed = 0;
  for (const row of result.rows) {
    const oldPid = extractPublicId(row.photo_url);
    if (!oldPid) {
      console.log(`  skip id=${row.id} (couldn't extract public_id)`);
      continue;
    }
    const filename = oldPid.split("/").pop();
    const newPid = `purchase_bills/${filename}`;
    const isPdf = /\.pdf$/i.test(row.photo_url);
    console.log(`  Moving ${oldPid} → ${newPid}`);
    try {
      const r = await cloudinary.uploader.rename(oldPid, newPid, {
        resource_type: isPdf ? "raw" : "image",
        overwrite: false,
        invalidate: true,
      });
      await pool.query(
        `UPDATE purchases SET photo_url=$1 WHERE bill_no=$2 AND profile_id=$3`,
        [r.secure_url, row.bill_no, row.profile_id],
      );
      moved++;
    } catch (e) {
      console.error(`    FAIL: ${e.message || JSON.stringify(e)}`);
      failed++;
    }
  }
  console.log(`\nDone. moved=${moved}, failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFATAL ERROR DETAILS:");
    console.error("  message:", e.message);
    console.error("  code:", e.code);
    console.error("  stack:", e.stack);
    process.exit(1);
  });
