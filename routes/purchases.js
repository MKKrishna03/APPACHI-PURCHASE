const express = require("express");
const { pool } = require("../db");

const router = express.Router();

router.get("/purchases/list", async (req, res) => {
  const { profile_id, unlinked_only } = req.query;
  try {
    let where = "";
    const params = [];
    if (profile_id) {
      params.push(profile_id);
      where = `WHERE p.profile_id = $1`;
    }
    const result = await pool.query(
      `SELECT p.*, u.name AS created_by_name FROM purchases p LEFT JOIN auth_users u ON u.user_id::text = p.created_by ${where} ORDER BY p.created_at DESC`,
      params,
    );
    let purchases = result.rows;

    if (unlinked_only === "true") {
      const vRes = await pool.query(
        `SELECT linked_purchase_id, SUM(total_value::numeric) as paid FROM vouchers WHERE linked_purchase_id IS NOT NULL GROUP BY linked_purchase_id`,
      );
      const paidMap = {};
      vRes.rows.forEach((r) => { paidMap[parseInt(r.linked_purchase_id)] = parseFloat(r.paid || 0); });
      const billRes = await pool.query(
        `SELECT p.id, COALESCE(SUM(v.total_value::numeric), 0) as paid
         FROM purchases p LEFT JOIN vouchers v ON v.bill_no = p.bill_no AND v.profile_id = p.profile_id
           AND v.entry_type = 'against' AND v.voucher_type IN ('Payment Voucher','Receipt Voucher','Chittai Payment')
         GROUP BY p.id`,
      );
      billRes.rows.forEach((r) => {
        paidMap[parseInt(r.id)] = Math.max(paidMap[parseInt(r.id)] || 0, parseFloat(r.paid || 0));
      });
      purchases = purchases.filter((p) => {
        const paid = paidMap[p.id] || 0;
        const due = parseFloat(p.net_value || p.total_value || 0);
        return due > 0 && paid < due - 0.01;
      });
    }
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/purchases/no-photo", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.profile_id, p.bill_no, p.date, p.net_value, p.total_value,
              COALESCE(pr.alias, pr.company_name) AS company_name, 'purchase' AS source
       FROM purchases p LEFT JOIN profiles pr ON pr.id = p.profile_id
       WHERE (p.photo_url IS NULL OR p.photo_url = '') AND (p.voucher_type IS NULL OR p.voucher_type != 'Hallmark Voucher')
       UNION ALL
       SELECT l.id, l.profile_id, l.receipt_bill_no AS bill_no, l.date,
              l.bill_value_after_deduction AS net_value, l.total AS total_value,
              COALESCE(pr2.alias, pr2.company_name, l.company_name) AS company_name, 'receipt_voucher' AS source
       FROM labour l LEFT JOIN profiles pr2 ON pr2.id = l.profile_id
       WHERE l.voucher_type = 'Receipt Voucher' AND (l.photo_url IS NULL OR l.photo_url = '')
       UNION ALL
       SELECT he.id, he.profile_id, he.bill_no, he.date, he.net_value, he.total_value,
              COALESCE(pr3.alias, pr3.company_name) AS company_name,
              CASE WHEN he.voucher_type = 'Hallmark' THEN 'hallmark' ELSE 'expenses' END AS source
       FROM hallmark_expenses he LEFT JOIN profiles pr3 ON pr3.id = he.profile_id
       WHERE he.voucher_type IN ('Hallmark', 'Expenses') AND (he.photo_url IS NULL OR he.photo_url = '')
       ORDER BY date DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/purchases/:id", async (req, res) => {
  if (isNaN(req.params.id)) return res.status(404).json({ error: "Not found" });
  try {
    const p = await pool.query("SELECT * FROM purchases WHERE id=$1", [req.params.id]);
    if (!p.rows[0]) return res.status(404).json({ error: "Not found" });
    const items = await pool.query("SELECT * FROM purchase_items WHERE purchase_id=$1 ORDER BY sl_no", [req.params.id]);
    res.json({ purchase: p.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/purchases", async (req, res) => {
  const {
    profile_id, date, bill_no, description, taxable_value, cgst, sgst, igst,
    round_off, total_value, tds, net_value, linked_voucher_ids, linked_chittai_ids, linked_purchase_ids,
  } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO purchases (profile_id, date, bill_no, description, taxable_value, cgst, sgst, igst,
        round_off, total_value, tds, net_value, linked_voucher_id, linked_chittai_id, created_by, photo_url,
        linked_purchase_ids, linked_voucher_ids, linked_chittai_ids, photo_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        profile_id, date, bill_no, description, taxable_value, cgst, sgst, igst, round_off, total_value,
        tds, net_value,
        linked_voucher_ids?.length ? linked_voucher_ids[0] : null,
        linked_chittai_ids?.length ? linked_chittai_ids[0] : null,
        req.body.created_by || null, req.body.photo_url || null,
        linked_purchase_ids?.length ? linked_purchase_ids : null,
        linked_voucher_ids?.length ? linked_voucher_ids : null,
        linked_chittai_ids?.length ? linked_chittai_ids : null,
        req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );
    const purchaseId = result.rows[0].id;
    if (req.body.items?.length) {
      for (const item of req.body.items) {
        await pool.query(
          `INSERT INTO purchase_items (purchase_id, sl_no, description, quantity, rate, tax_percent, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [purchaseId, item.sl_no, item.description, item.quantity, item.rate, item.tax_percent, item.amount],
        );
      }
    }
    if (linked_voucher_ids?.length) {
      for (const vid of linked_voucher_ids) await pool.query(`UPDATE vouchers SET linked_purchase_id=$1 WHERE id=$2`, [purchaseId, vid]);
    }
    if (linked_chittai_ids?.length) {
      for (const cid of linked_chittai_ids) await pool.query(`UPDATE chittai SET linked_purchase_id=$1 WHERE id=$2`, [purchaseId, cid]);
    }
    const isNote = description === "Credit Note" || description === "Debit Note";
    if (isNote && req.body.source_type === "purchase" && linked_purchase_ids?.length) {
      for (const pid of linked_purchase_ids) {
        const cur = await pool.query(`SELECT COALESCE(remaining_value, net_value, total_value) AS rem FROM purchases WHERE id=$1`, [pid]);
        await pool.query(`UPDATE purchases SET remaining_value=$1 WHERE id=$2`, [parseFloat(cur.rows[0]?.rem || 0) - parseFloat(net_value || 0), pid]);
      }
    }
    if (isNote && req.body.source_type === "labour" && req.body.linked_labour_ids?.length) {
      for (const lid of req.body.linked_labour_ids) {
        const cur = await pool.query(`SELECT COALESCE(remaining_value, bill_value_after_deduction, total) AS rem FROM labour WHERE id=$1`, [lid]);
        await pool.query(`UPDATE labour SET remaining_value=$1 WHERE id=$2`, [parseFloat(cur.rows[0]?.rem || 0) - parseFloat(net_value || 0), lid]);
      }
    }
    if (isNote && (req.body.source_type === "hallmark" || req.body.source_type === "expense") && req.body.linked_hallmark_expense_ids?.length) {
      for (const hid of req.body.linked_hallmark_expense_ids) {
        const cur = await pool.query(`SELECT COALESCE(remaining_value, net_value) AS rem FROM hallmark_expenses WHERE id=$1`, [hid]);
        await pool.query(`UPDATE hallmark_expenses SET remaining_value=$1 WHERE id=$2`, [parseFloat(cur.rows[0]?.rem || 0) - parseFloat(net_value || 0), hid]);
      }
    }
    res.json({ status: "SUCCESS", id: purchaseId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/purchases/:id", async (req, res) => {
  const id = req.params.id;
  const {
    date, bill_no, description, taxable_value, cgst, sgst, igst,
    round_off, total_value, tds, net_value, items, photo_url, photo_urls,
  } = req.body;
  try {
    await pool.query(
      `UPDATE purchases SET date=$1, bill_no=$2, description=$3, taxable_value=$4, cgst=$5, sgst=$6, igst=$7,
        round_off=$8, total_value=$9, tds=$10, net_value=$11, photo_url=$12, photo_urls=$13 WHERE id=$14`,
      [date, bill_no, description || "", taxable_value, cgst, sgst, igst, round_off, total_value, tds, net_value,
        photo_url || null, photo_urls?.length ? photo_urls : null, id],
    );
    await pool.query(`DELETE FROM purchase_items WHERE purchase_id=$1`, [id]);
    if (items?.length) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO purchase_items (purchase_id, sl_no, description, quantity, rate, tax_percent, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, item.sl_no, item.description, item.quantity, item.rate, item.tax_percent, item.amount],
        );
      }
    }
    res.json({ status: "SUCCESS", id: parseInt(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/purchases/:id/accounted", async (req, res) => {
  try {
    await pool.query(`UPDATE purchases SET is_accounted = $1 WHERE id = $2`, [req.body.is_accounted, req.params.id]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/purchases/:id/photo", async (req, res) => {
  try {
    await pool.query(`UPDATE purchases SET photo_url = $1 WHERE id = $2`, [req.body.photo_url || null, req.params.id]);
    res.json({ status: "SUCCESS" });
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

module.exports = router;
