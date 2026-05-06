const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const cloudinaryPkg = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { pool } = require("../db");
const { logger } = require("../middleware/logger");

const router = express.Router();

cloudinaryPkg.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_FOLDERS = new Set([
  "purchase_bills", "chittai_bills", "labour_receipts",
  "hallmark_bills", "expense_bills", "credit_notes", "debit_notes", "refinery_bills",
]);
const ALL_FOLDERS = [...ALLOWED_FOLDERS];

async function getSession(token) {
  const result = await pool.query(
    `SELECT * FROM upload_sessions WHERE token=$1 AND expires_at > NOW()`,
    [token],
  );
  return result.rows[0] || null;
}

function makeUploader(defaultFolder) {
  return multer({
    storage: new CloudinaryStorage({
      cloudinary: cloudinaryPkg,
      params: async (req, file) => {
        const isPdf = file.mimetype === "application/pdf";
        let folder = defaultFolder;
        const session = req.params?.token ? await getSession(req.params.token) : null;
        if (session && ALLOWED_FOLDERS.has(session.folder)) folder = session.folder;
        else if (req.body?.folder && ALLOWED_FOLDERS.has(req.body.folder)) folder = req.body.folder;
        else if (req.query?.folder && ALLOWED_FOLDERS.has(req.query.folder)) folder = req.query.folder;
        const bill_date = session?.bill_date || req.body?.bill_date || null;
        logger.info("cloudinary-upload", { folder, token: req.params?.token || null });
        return {
          folder,
          resource_type: isPdf ? "raw" : "image",
          allowed_formats: isPdf ? ["pdf"] : ["jpg", "jpeg", "png", "webp", "heic"],
          ...(bill_date ? { context: `bill_date=${bill_date}` } : {}),
          ...(isPdf ? {} : {
            transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto" }],
          }),
        };
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
  });
}

const upload = makeUploader("purchase_bills");
const uploadChittai = makeUploader("chittai_bills");

// ── Upload sessions (DB-backed) ──

router.post("/upload-session", async (req, res) => {
  const { bill_no, company, folder, bill_date } = req.body;
  const token = crypto.randomBytes(8).toString("hex");
  const finalFolder = ALLOWED_FOLDERS.has(folder) ? folder : "purchase_bills";
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await pool.query(
    `INSERT INTO upload_sessions (token, bill_no, company, folder, bill_date, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [token, bill_no || "", company || "", finalFolder, bill_date || null, expiresAt],
  );
  res.json({ token });
});

router.get("/upload-session/:token/status", async (req, res) => {
  const session = await getSession(req.params.token);
  if (!session) return res.json({ error: "Invalid or expired" });
  res.json({
    bill_no: session.bill_no, company: session.company,
    uploaded: (session.photo_urls || []).length > 0,
    photo_url: session.photo_url,
    photo_urls: session.photo_urls || [],
    count: (session.photo_urls || []).length,
    done: session.done,
  });
});

router.post("/upload-session/:token/upload", upload.single("photo"), async (req, res) => {
  const session = await getSession(req.params.token);
  if (!session) return res.status(404).json({ error: "Invalid or expired" });
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = req.file.path;
  const newUrls = [...(session.photo_urls || []), url];
  await pool.query(
    `UPDATE upload_sessions SET photo_url=COALESCE(photo_url, $1), photo_urls=$2 WHERE token=$3`,
    [url, newUrls, req.params.token],
  );
  res.json({ status: "SUCCESS", photo_url: url, count: newUrls.length });
});

router.post("/upload-session/:token/done", async (req, res) => {
  const session = await getSession(req.params.token);
  if (!session) return res.status(404).json({ error: "Invalid or expired" });
  await pool.query(`UPDATE upload_sessions SET done=true WHERE token=$1`, [req.params.token]);
  res.json({ status: "SUCCESS" });
});

router.post("/chittai-upload", uploadChittai.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ status: "SUCCESS", photo_url: req.file.path });
});

// ── Cloudinary management ──

async function deleteCloudinaryPhoto(photo_url) {
  if (!photo_url) return;
  try {
    const clean = photo_url.split("?")[0];
    const match = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return;
    const public_id = match[1].replace(/\.[^/.]+$/, "");
    const isPdf = /\.pdf$/i.test(clean);
    await cloudinaryPkg.uploader.destroy(public_id, { resource_type: isPdf ? "raw" : "image", invalidate: true });
  } catch (e) {
    logger.error("cloudinary-delete-fail", { message: e.message });
  }
}

async function deleteAllPhotos(row) {
  if (row.photo_url) await deleteCloudinaryPhoto(row.photo_url);
  if (row.photo_urls?.length) {
    for (const u of row.photo_urls) await deleteCloudinaryPhoto(u);
  }
}

function extractPublicIdFromUrl(url) {
  if (!url) return null;
  const clean = url.split("?")[0];
  const match = clean.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? match[1].replace(/\.[^/.]+$/, "") : null;
}

async function fetchAllCloudinaryResources() {
  const auth = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString("base64");
  let all = [];
  for (const folder of ALL_FOLDERS) {
    for (const resource_type of ["image", "raw"]) {
      let nextCursor = null;
      do {
        const params = new URLSearchParams({ type: "upload", prefix: folder, max_results: 500, resource_type });
        if (nextCursor) params.append("next_cursor", nextCursor);
        const r = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/${resource_type}?${params}`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        const d = await r.json();
        (d.resources || []).forEach((res) => all.push({
          public_id: res.public_id, url: res.secure_url, created_at: res.created_at,
          folder, bytes: res.bytes, format: res.format, resource_type, is_pdf: resource_type === "raw",
        }));
        nextCursor = d.next_cursor || null;
      } while (nextCursor);
    }
  }
  return all;
}

async function getLinkedPublicIds() {
  const queries = await Promise.all([
    pool.query("SELECT photo_url FROM purchases WHERE photo_url IS NOT NULL"),
    pool.query("SELECT photo_url FROM labour WHERE photo_url IS NOT NULL"),
    pool.query("SELECT photo_url FROM chittai WHERE photo_url IS NOT NULL"),
    pool.query("SELECT photo_url FROM hallmark_expenses WHERE photo_url IS NOT NULL").catch(() => ({ rows: [] })),
    pool.query("SELECT unnest(photo_urls) AS u FROM purchases WHERE photo_urls IS NOT NULL").catch(() => ({ rows: [] })),
    pool.query("SELECT unnest(photo_urls) AS u FROM labour WHERE photo_urls IS NOT NULL").catch(() => ({ rows: [] })),
    pool.query("SELECT unnest(photo_urls) AS u FROM chittai WHERE photo_urls IS NOT NULL").catch(() => ({ rows: [] })),
    pool.query("SELECT unnest(photo_urls) AS u FROM hallmark_expenses WHERE photo_urls IS NOT NULL").catch(() => ({ rows: [] })),
  ]);
  const linked = new Set();
  function addUrl(url) {
    const pid = extractPublicIdFromUrl(url);
    if (pid) {
      linked.add(pid);
      [".pdf", ".jpg", ".jpeg", ".png", ".webp"].forEach((ext) => linked.add(pid + ext));
    }
  }
  queries.slice(0, 4).forEach((q) => q.rows.forEach((r) => addUrl(r.photo_url)));
  queries.slice(4).forEach((q) => q.rows.forEach((r) => addUrl(r.u)));
  return linked;
}

router.get("/cloudinary/all-photos", async (req, res) => {
  try {
    const auth = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString("base64");
    let allResources = [];
    for (const resource_type of ["image", "raw"]) {
      for (const folder of ALL_FOLDERS) {
        let nextCursor = null;
        do {
          const params = new URLSearchParams({ type: "upload", prefix: folder, max_results: 500, resource_type, context: "true" });
          if (nextCursor) params.append("next_cursor", nextCursor);
          const response = await fetch(
            `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/${resource_type}?${params}`,
            { headers: { Authorization: `Basic ${auth}` } },
          );
          const data = await response.json();
          allResources = allResources.concat((data.resources || []).map((r) => ({
            public_id: r.public_id, url: r.secure_url, created_at: r.created_at,
            bill_date: r.context?.custom?.bill_date || null, folder,
            bytes: r.bytes, format: r.format, ...(resource_type === "raw" ? { is_pdf: true } : {}),
          })));
          nextCursor = data.next_cursor || null;
        } while (nextCursor);
      }
    }
    allResources.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(allResources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/cloudinary/unlinked", async (req, res) => {
  try {
    const [all, linked] = await Promise.all([fetchAllCloudinaryResources(), getLinkedPublicIds()]);
    const unlinked = all.filter((r) => {
      const clean = r.public_id.replace(/\.[^/.]+$/, "");
      return !linked.has(r.public_id) && !linked.has(clean);
    });
    res.json(unlinked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/cloudinary/delete-unlinked", async (req, res) => {
  try {
    const { public_ids } = req.body;
    if (!public_ids?.length) return res.json({ status: "SUCCESS", deleted: 0, failed: 0 });
    const auth = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString("base64");
    const deleted = [], failed = [];
    async function deleteBatch(ids, resource_type) {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const response = await fetch(
          `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/${resource_type}/upload`,
          { method: "DELETE", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify({ public_ids: batch }) },
        );
        const data = await response.json();
        if (data.deleted) Object.keys(data.deleted).forEach((k) => deleted.push(k));
        if (data.failed) Object.keys(data.failed).forEach((k) => failed.push(k));
      }
    }
    await deleteBatch(public_ids.filter((r) => r.resource_type !== "raw").map((r) => r.public_id), "image");
    await deleteBatch(public_ids.filter((r) => r.resource_type === "raw").map((r) => r.public_id), "raw");
    res.json({ status: "SUCCESS", deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/cloudinary/move-photo", async (req, res) => {
  const { public_id, target_folder } = req.body;
  if (!public_id || !target_folder) return res.status(400).json({ error: "public_id and target_folder required" });
  if (!ALLOWED_FOLDERS.has(target_folder)) return res.status(400).json({ error: "Invalid target folder" });
  try {
    const filename = public_id.split("/").pop();
    const new_public_id = `${target_folder}/${filename}`;
    const isPdf = /\.pdf$/i.test(filename);
    const result = await cloudinaryPkg.uploader.rename(public_id, new_public_id, {
      resource_type: isPdf ? "raw" : "image", invalidate: true, overwrite: false,
    });
    const newUrl = result.secure_url;
    for (const pattern of [`%/${public_id}%`, `%/${public_id.replace(/\.[^/.]+$/, "")}%`]) {
      await pool.query(`UPDATE purchases SET photo_url=$1 WHERE photo_url LIKE $2`, [newUrl, pattern]);
      await pool.query(`UPDATE labour SET photo_url=$1 WHERE photo_url LIKE $2`, [newUrl, pattern]);
      await pool.query(`UPDATE chittai SET photo_url=$1 WHERE photo_url LIKE $2`, [newUrl, pattern]);
      await pool.query(`UPDATE hallmark_expenses SET photo_url=$1 WHERE photo_url LIKE $2`, [newUrl, pattern]).catch(() => {});
    }
    res.json({ status: "SUCCESS", new_public_id, new_url: newUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, deleteAllPhotos, deleteCloudinaryPhoto };
