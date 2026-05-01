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

async function getColumns(tableName) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
    [tableName],
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function getNewFolder(record, sourceTable) {
  if (sourceTable === "labour") return "labour_receipts";
  if (sourceTable === "chittai") return "chittai_bills";
  if (sourceTable === "hallmark_expenses") {
    const vt = (record.voucher_type || "").toLowerCase();
    if (vt.includes("expense")) return "expense_bills";
    return "hallmark_bills";
  }

  // purchases table
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

async function moveOne(oldPublicId, newFolder, isPdf) {
  const filename = oldPublicId.split("/").pop();
  const newPublicId = `${newFolder}/${filename}`;
  if (oldPublicId === newPublicId) return null;

  try {
    const result = await cloudinary.uploader.rename(oldPublicId, newPublicId, {
      resource_type: isPdf ? "raw" : "image",
      overwrite: false,
      invalidate: true,
    });
    return result.secure_url;
  } catch (e) {
    console.error(`  FAIL ${oldPublicId} → ${newPublicId}: ${e.message}`);
    return null;
  }
}

async function migrateTable(tableName) {
  console.log(`\n=== Migrating ${tableName} ===`);

  const cols = await getColumns(tableName);
  if (!cols.has("photo_url")) {
    console.log(`  ${tableName}: no photo_url column, skipping`);
    return;
  }

  const selectCols = ["id", "photo_url"];
  if (cols.has("voucher_type")) selectCols.push("voucher_type");
  if (cols.has("description")) selectCols.push("description");
  if (cols.has("bill_no")) selectCols.push("bill_no");

  const result = await pool.query(
    `SELECT ${selectCols.join(", ")} FROM ${tableName} WHERE photo_url IS NOT NULL`,
  );

  console.log(`  Found ${result.rows.length} rows with photos`);

  let moved = 0,
    skipped = 0,
    failed = 0;

  for (const row of result.rows) {
    const oldPid = extractPublicId(row.photo_url);
    if (!oldPid) {
      skipped++;
      continue;
    }

    const newFolder = getNewFolder(row, tableName);
    const currentFolder = oldPid.split("/").slice(0, -1).join("/");

    if (currentFolder === newFolder) {
      skipped++;
      continue;
    }

    const isPdf = /\.pdf$/i.test(row.photo_url);
    console.log(`  Moving ${oldPid} → ${newFolder}/`);
    const newUrl = await moveOne(oldPid, newFolder, isPdf);

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
    `  ${tableName}: moved=${moved}, skipped=${skipped}, failed=${failed}`,
  );
}

(async () => {
  try {
    await migrateTable("purchases");
    await migrateTable("labour");
    await migrateTable("chittai");
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
