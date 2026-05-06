const express = require("express");
const { pool } = require("../db");
const { deleteAllPhotos } = require("./cloudinary");

const router = express.Router();

// ── Reference data ──

router.get("/descriptions/metal", async (req, res) => {
  try {
    const result = await pool.query("SELECT name, metal_type FROM descriptions ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/descriptions", async (req, res) => {
  try {
    const result = await pool.query("SELECT name FROM descriptions ORDER BY name");
    res.json(result.rows.map((r) => r.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tax-formats", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, percent FROM tax_format ORDER BY percent ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tds", async (req, res) => {
  const { section } = req.query;
  try {
    const result = section
      ? await pool.query(
          "SELECT id, pan_4th_letter, section, entity_type, tds_percentage, remarks FROM tds WHERE section = $1 ORDER BY pan_4th_letter",
          [section],
        )
      : await pool.query(
          "SELECT id, pan_4th_letter, section, entity_type, tds_percentage, remarks FROM tds ORDER BY section, pan_4th_letter",
        );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tds-required/:profile_id", async (req, res) => {
  try {
    const { profile_id } = req.params;
    const now = new Date();
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = `${fyYear}-04-01`;
    const fyEnd = `${fyYear + 1}-03-31`;
    const result = await pool.query(
      `SELECT tds FROM purchases WHERE profile_id=$1 AND tds IS NOT NULL AND tds>0 AND date BETWEEN $2 AND $3
       UNION ALL
       SELECT tds FROM labour WHERE profile_id=$1 AND voucher_type='Receipt Voucher' AND tds IS NOT NULL AND tds>0 AND date BETWEEN $2 AND $3
       LIMIT 1`,
      [profile_id, fyStart, fyEnd],
    );
    res.json({ required: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Linked data ──

router.get("/linked-data/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  try {
    const linked = [];
    if (type === "issue") {
      const rvs = await pool.query(
        `SELECT id, receipt_bill_no, date FROM labour WHERE voucher_type='Receipt Voucher' AND (issue_number=(SELECT issue_number FROM labour WHERE id=$1) OR issue_number LIKE '%' || (SELECT issue_number FROM labour WHERE id=$1) || '%')`,
        [id],
      );
      rvs.rows.forEach((r) => linked.push({
        type: "receipt", id: r.id,
        label: `Receipt Voucher: ${r.receipt_bill_no || "ID-" + r.id} (${r.date?.toString().slice(0, 10)})`,
      }));
    }
    if (type === "receipt") {
      const vs = await pool.query(`SELECT id, bill_no, total_value FROM vouchers WHERE linked_labour_id=$1`, [id]);
      vs.rows.forEach((v) => linked.push({ type: "voucher", id: v.id, label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}` }));
    }
    if (type === "purchase") {
      const vs = await pool.query(`SELECT id, bill_no, total_value FROM vouchers WHERE linked_purchase_id=$1`, [id]);
      vs.rows.forEach((v) => linked.push({ type: "voucher", id: v.id, label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}` }));
    }
    if (type === "hallmark") {
      const vs = await pool.query(`SELECT id, bill_no, total_value FROM vouchers WHERE linked_purchase_id=$1`, [id]);
      vs.rows.forEach((v) => linked.push({ type: "voucher", id: v.id, label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}` }));
    }
    if (type === "chittai") {
      const vs = await pool.query(`SELECT id, bill_no, total_value FROM vouchers WHERE linked_chittai_id=$1`, [id]);
      vs.rows.forEach((v) => linked.push({ type: "voucher", id: v.id, label: `Payment Voucher: ${v.bill_no || "ID-" + v.id} ₹${v.total_value}` }));
      const ps = await pool.query(`SELECT id, bill_no FROM purchases WHERE linked_chittai_id=$1`, [id]);
      ps.rows.forEach((p) => linked.push({ type: "purchase", id: p.id, label: `Purchase: ${p.bill_no || "ID-" + p.id}` }));
    }
    res.json(linked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete entry ──

router.delete("/delete-entry", async (req, res) => {
  const { type, id, linked } = req.body;
  try {
    if (linked?.length) {
      for (const l of linked) {
        if (l.type === "voucher") await pool.query(`DELETE FROM vouchers WHERE id=$1`, [l.id]);
        if (l.type === "receipt") {
          const ph = await pool.query(`SELECT photo_url, photo_urls FROM labour WHERE id=$1`, [l.id]);
          if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
          await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [l.id]);
          await pool.query(`DELETE FROM labour WHERE id=$1`, [l.id]);
        }
        if (l.type === "purchase") {
          const ph = await pool.query(`SELECT photo_url, photo_urls FROM purchases WHERE id=$1`, [l.id]);
          if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
          await pool.query(`UPDATE vouchers SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`, [l.id]);
          await pool.query(`UPDATE chittai SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`, [l.id]);
          await pool.query(`DELETE FROM purchases WHERE id=$1`, [l.id]);
        }
      }
    }

    if (type === "issue" || type === "receipt") {
      const ph = await pool.query(`SELECT photo_url, photo_urls FROM labour WHERE id=$1`, [id]);
      if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
      await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [id]);
      await pool.query(`DELETE FROM labour WHERE id=$1`, [id]);
    }
    if (type === "txn") await pool.query(`DELETE FROM vouchers WHERE id=$1`, [id]);
    if (type === "purchase") {
      const group = await pool.query(
        `SELECT id, photo_url, photo_urls FROM purchases WHERE bill_no=(SELECT bill_no FROM purchases WHERE id=$1) AND profile_id=(SELECT profile_id FROM purchases WHERE id=$1)`,
        [id],
      );
      for (const row of group.rows) {
        await deleteAllPhotos(row);
        await pool.query(`UPDATE vouchers SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`, [row.id]);
        await pool.query(`UPDATE chittai SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`, [row.id]);
        await pool.query(`DELETE FROM purchase_items WHERE purchase_id=$1`, [row.id]);
        await pool.query(`DELETE FROM purchases WHERE id=$1`, [row.id]);
      }
    }
    if (type === "chittai") {
      const ph = await pool.query(`SELECT photo_url, photo_urls FROM chittai WHERE id=$1`, [id]);
      if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
      await pool.query(`UPDATE vouchers SET linked_chittai_id=NULL WHERE linked_chittai_id=$1`, [id]);
      await pool.query(`UPDATE purchases SET linked_chittai_id=NULL WHERE linked_chittai_id=$1`, [id]);
      await pool.query(`DELETE FROM chittai WHERE id=$1`, [id]);
    }
    if (type === "hallmark") {
      const ph = await pool.query(`SELECT photo_url, photo_urls FROM hallmark_expenses WHERE id=$1`, [id]);
      if (ph.rows[0]) await deleteAllPhotos(ph.rows[0]);
      await pool.query(`UPDATE vouchers SET linked_purchase_id=NULL WHERE linked_purchase_id=$1`, [id]);
      await pool.query(`DELETE FROM hallmark_expense_items WHERE hallmark_expense_id=$1`, [id]);
      await pool.query(`DELETE FROM hallmark_expenses WHERE id=$1`, [id]);
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug ──

router.get("/debug/photo-urls-type", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT table_name, column_name, udt_name, data_type
      FROM information_schema.columns
      WHERE column_name='photo_urls'
      ORDER BY table_name
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
