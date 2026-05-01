require("dotenv").config();
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const dbUrl = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  host: dbUrl.hostname,
  port: dbUrl.port || 5432,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

function extractPublicId(url) {
  if (!url) return null;
  const clean = url.split("?")[0];
  const match = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  if (!match) return null;
  return match[1].replace(/\.[^/.]+$/, "");
}

async function getNewFolder(record, sourceTable) {
  if (sourceTable === "labour") return "labour_receipts";
  if (sourceTable === "chittai") return "chittai_bills";

  // For purchases / hallmark_expenses
  const vt = (record.voucher_type || "").toLowerCase();
  const desc = (record.description || "").toLowerCase();
  const bill = (record.bill_no || "").toLowerCase();
  const hay = `${vt} ${desc} ${bill}`;

  if (hay.includes("credit note")) return "credit_notes";
  if (hay.includes("debit note")) return "debit_notes";
  if (hay.includes("hallmark")) return "hallmark_bills";
  if (hay.includes("expense")) return "expense_bills";
  if (hay.includes("refinery") || hay.includes("refine"))
    return "refinery_bills";
  return "purchase_bills";
}

async function moveOne(oldPublicId, newFolder, isPdf, photoUrl) {
  const filename = oldPublicId.split("/").pop();
  const newPublicId = `${newFolder}/${filename}`;

  if (oldPublicId === newPublicId) return null; // already in right place

  try {
    const result = await cloudinary.uploader.rename(oldPublicId, newPublicId, {
      resource_type: isPdf ? "raw" : "image",
      overwrite: false,
      invalidate: true,
    });
    return result.secure_url;
  } catch (e) {
    console.error(`  FAIL move ${oldPublicId} → ${newPublicId}:`, e.message);
    return null;
  }
}

async function migrateTable(tableName) {
  console.log(`\n=== Migrating ${tableName} ===`);
  const result = await pool.query(
    `SELECT id, photo_url, voucher_type, description, bill_no FROM ${tableName} WHERE photo_url IS NOT NULL`,
  );

  let moved = 0,
    skipped = 0,
    failed = 0;

  for (const row of result.rows) {
    const oldPid = extractPublicId(row.photo_url);
    if (!oldPid) {
      skipped++;
      continue;
    }

    const newFolder = await getNewFolder(row, tableName);
    const currentFolder = oldPid.split("/").slice(0, -1).join("/");

    if (currentFolder === newFolder) {
      skipped++;
      continue;
    }

    const isPdf = /\.pdf$/i.test(row.photo_url);
    console.log(`  Moving ${oldPid} → ${newFolder}/`);
    const newUrl = await moveOne(oldPid, newFolder, isPdf, row.photo_url);

    if (newUrl) {
      await pool.query(`UPDATE ${tableName} SET photo_url=$1 WHERE id=$2`, [
        newUrl,
        row.id,
      ]);
      moved++;
    } else {
      failed++;
    }
  }

  console.log(
    `${tableName}: moved=${moved}, skipped=${skipped}, failed=${failed}`,
  );
}

(async () => {
  try {
    await migrateTable("purchases");
    await migrateTable("labour");
    await migrateTable("chittai");
    // hallmark_expenses table if it exists
    try {
      await migrateTable("hallmark_expenses");
    } catch (e) {
      console.log("hallmark_expenses table not present, skipping");
    }
    console.log("\n✓ Migration complete");
    process.exit(0);
  } catch (e) {
    console.error("FATAL:", e);
    process.exit(1);
  }
})();
