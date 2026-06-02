const express = require("express");
const { pool } = require("../db");
const { deleteCloudinaryPhoto } = require("./cloudinary");

const router = express.Router();

pool.query(`
  CREATE TABLE IF NOT EXISTS photo_bill_entries (
    id         SERIAL PRIMARY KEY,
    profile_id INTEGER,
    bill_no    VARCHAR(100),
    date       DATE,
    remarks    TEXT,
    photo_url  TEXT,
    photo_urls TEXT[],
    created_by TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).catch(e => console.error("photo_bill_entries table init error:", e.message));

router.get("/photo-bill-entries", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pbe.*, COALESCE(pr.alias, pr.company_name) AS company_name
       FROM photo_bill_entries pbe
       LEFT JOIN profiles pr ON pr.id = pbe.profile_id
       ORDER BY COALESCE(pbe.date, pbe.created_at::date) DESC, pbe.created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/photo-bill-entries", async (req, res) => {
  const { profile_id, bill_no, date, remarks, photo_url, photo_urls, created_by } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO photo_bill_entries (profile_id, bill_no, date, remarks, photo_url, photo_urls, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        profile_id || null, bill_no || "", date || null, remarks || "",
        photo_url || null, photo_urls?.length ? photo_urls : null, created_by || null,
      ],
    );
    res.json({ status: "SUCCESS", id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/photo-bill-entries/:id", async (req, res) => {
  try {
    const row = await pool.query(`SELECT photo_url, photo_urls FROM photo_bill_entries WHERE id=$1`, [req.params.id]);
    const r = row.rows[0];
    if (r) {
      const urls = [...(r.photo_urls || []), r.photo_url].filter(Boolean);
      for (const u of urls) await deleteCloudinaryPhoto(u);
    }
    await pool.query(`DELETE FROM photo_bill_entries WHERE id=$1`, [req.params.id]);
    res.json({ status: "SUCCESS" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
