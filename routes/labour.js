const express = require("express");
const { pool } = require("../db");

const router = express.Router();

router.get("/labour/list", async (req, res) => {
  const { profile_id, voucher_type } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id) {
      params.push(profile_id);
      where += `${where ? " AND" : " WHERE"} l.profile_id = $${params.length}`;
    }
    if (voucher_type) {
      params.push(voucher_type);
      where += `${where ? " AND" : " WHERE"} l.voucher_type ILIKE $${params.length}`;
    }
    const result = await pool.query(
      `SELECT l.id, l.profile_id, l.company_name, l.date, l.issue_number, l.receipt_bill_no,
              l.voucher_type, l.bill_value_after_deduction, l.total, l.remaining_value,
              COALESCE(SUM(li.amount::numeric), 0) AS total_value
       FROM labour l
       LEFT JOIN labour_items li ON li.labour_id = l.id
       ${where}
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/labour/rv-references", async (req, res) => {
  const { issue_number, profile_id } = req.query;
  if (!issue_number || !profile_id) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT id, receipt_bill_no, issue_number, date FROM labour
       WHERE voucher_type = 'Receipt Voucher' AND profile_id = $1 AND issue_number IS NOT NULL
         AND (issue_number = $2 OR issue_number LIKE $3 OR issue_number LIKE $4 OR issue_number LIKE $5)`,
      [profile_id, issue_number, `${issue_number},%`, `%,${issue_number}`, `%,${issue_number},%`],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/labour/unlinked-receipts", async (req, res) => {
  const { profile_id } = req.query;
  if (!profile_id) return res.status(400).json({ error: "profile_id required" });
  try {
    const linkedIds = await pool.query(`SELECT linked_labour_id FROM vouchers WHERE linked_labour_id IS NOT NULL`);
    const linkedSet = linkedIds.rows.map((r) => r.linked_labour_id);
    const result = await pool.query(
      `SELECT id, issue_number, receipt_bill_no, date FROM labour WHERE voucher_type = 'Receipt Voucher' AND profile_id = $1`,
      [profile_id],
    );
    res.json(result.rows.filter((r) => !linkedSet.includes(r.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/labour/:id", async (req, res) => {
  if (isNaN(req.params.id)) return res.status(404).json({ error: "Not found" });
  try {
    const labourResult = await pool.query("SELECT * FROM labour WHERE id = $1", [req.params.id]);
    if (!labourResult.rows[0]) return res.status(404).json({ error: "Labour not found" });
    const itemsResult = await pool.query(
      "SELECT * FROM labour_items WHERE labour_id = $1 ORDER BY sl_no",
      [req.params.id],
    );
    res.json({ labour: labourResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/labour", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.name AS created_by_name,
              CASE WHEN l.voucher_type = 'Receipt Voucher'
                   THEN (SELECT iv.labour_item_type FROM labour iv
                         WHERE UPPER(iv.voucher_type) = 'ISSUE VOUCHER'
                           AND (l.issue_number = iv.issue_number OR l.issue_number LIKE '%' || iv.issue_number || '%')
                         LIMIT 1)
                   ELSE l.labour_item_type
              END AS effective_item_type
       FROM labour l
       LEFT JOIN auth_users u ON u.user_id::text = l.created_by
       ORDER BY l.created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/labour", async (req, res) => {
  const { profile_id, company_name, date, issue_number, labour_item_type, items } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO labour (profile_id, company_name, date, issue_number, labour_item_type, voucher_type, created_by)
       VALUES ($1, $2, $3, $4, $5, 'ISSUE VOUCHER', $6) RETURNING *`,
      [profile_id, company_name, date, issue_number, labour_item_type, req.body.created_by || null],
    );
    const labourId = result.rows[0].id;
    for (const item of items) {
      await pool.query(
        `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
        [labourId, item.sl_no, item.description, item.quantity, item.rate, item.amount],
      );
    }
    res.json({ status: "SUCCESS", id: labourId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/labour/:id/with-cascade", async (req, res) => {
  const { profile_id, company_name, date, issue_number, labour_item_type, items, old_issue_number } = req.body;
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE labour SET profile_id=$1, company_name=$2, date=$3, issue_number=$4, labour_item_type=$5 WHERE id=$6`,
      [profile_id, company_name, date, issue_number, labour_item_type, id],
    );
    if (items?.length) {
      await client.query(`DELETE FROM labour_items WHERE labour_id=$1`, [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, item.sl_no, item.description, item.quantity, item.rate, item.amount],
        );
      }
    }
    let updated_rv_count = 0;
    if (old_issue_number && issue_number && old_issue_number !== issue_number) {
      const rvs = await client.query(
        `SELECT id, issue_number FROM labour WHERE voucher_type = 'Receipt Voucher' AND profile_id = $1 AND issue_number IS NOT NULL`,
        [profile_id],
      );
      for (const rv of rvs.rows) {
        const parts = rv.issue_number.split(",").map((s) => s.trim());
        const idx = parts.indexOf(old_issue_number);
        if (idx !== -1) {
          parts[idx] = issue_number;
          await client.query(`UPDATE labour SET issue_number=$1 WHERE id=$2`, [parts.join(","), rv.id]);
          updated_rv_count++;
        }
      }
    }
    await client.query("COMMIT");
    res.json({ status: "SUCCESS", updated_rv_count });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.put("/labour/:id", async (req, res) => {
  const {
    profile_id, company_name, date, issue_number, labour_item_type, items,
    receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction,
  } = req.body;
  try {
    if (profile_id !== undefined) {
      await pool.query(
        `UPDATE labour SET profile_id=$1, company_name=$2, date=$3, issue_number=$4, labour_item_type=$5 WHERE id=$6`,
        [profile_id, company_name, date, issue_number, labour_item_type, req.params.id],
      );
    } else {
      await pool.query(
        `UPDATE labour SET date=$1, receipt_bill_no=$2, taxable_total=$3, cgst=$4, sgst=$5, igst=$6, round_off=$7, total=$8, tds=$9, bill_value_after_deduction=$10, photo_url=COALESCE($11, photo_url), photo_urls=COALESCE($12, photo_urls) WHERE id=$13`,
        [
          date, receipt_bill_no, taxable_total || null, cgst || null, sgst || null,
          igst || null, round_off || null, total || null, tds || null,
          bill_value_after_deduction || null, req.body.photo_url || null,
          req.body.photo_urls?.length ? req.body.photo_urls : null, req.params.id,
        ],
      );
    }
    if (items?.length) {
      await pool.query(`DELETE FROM labour_items WHERE labour_id=$1`, [req.params.id]);
      for (const item of items) {
        await pool.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, item.sl_no, item.description, item.quantity, item.rate, item.amount],
        );
      }
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/labour/:id/accounted", async (req, res) => {
  try {
    await pool.query(`UPDATE labour SET is_accounted = $1 WHERE id = $2`, [req.body.is_accounted, req.params.id]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/close-issue-voucher", async (req, res) => {
  const {
    labour_id, labour_ids, closing_date, closing_type, partial_qty, items,
    payment_voucher_id, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction,
  } = req.body;

  if (labour_ids?.length) {
    try {
      const firstRes = await pool.query("SELECT * FROM labour WHERE id = $1", [labour_ids[0]]);
      if (!firstRes.rows[0]) return res.status(404).json({ error: "Labour bill not found" });
      const labour = firstRes.rows[0];
      await pool.query("INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING", ["Receipt Voucher"]);
      const issueNumbers = await Promise.all(
        labour_ids.map(async (id) => {
          const r = await pool.query("SELECT issue_number FROM labour WHERE id = $1", [id]);
          return r.rows[0] ? r.rows[0].issue_number : id;
        }),
      );
      const result = await pool.query(
        `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by, photo_url, photo_urls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          labour.profile_id, labour.company_name, closing_date, issueNumbers.join(","),
          "Receipt Voucher", req.body.bill_no || null, taxable_total || null, cgst || null,
          sgst || null, igst || null, round_off || null, total || null, tds || null,
          bill_value_after_deduction || null, req.body.created_by || null,
          req.body.photo_url || null, req.body.photo_urls?.length ? req.body.photo_urls : null,
        ],
      );
      const close_labour_id = result.rows[0].id;
      if (items?.length) {
        for (const item of items) {
          await pool.query(
            `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
            [close_labour_id, item.sl_no, item.description, item.quantity, item.rate, item.amount],
          );
        }
      }
      if (payment_voucher_id) {
        await pool.query(`UPDATE vouchers SET linked_labour_id = $1 WHERE id = $2`, [close_labour_id, payment_voucher_id]);
      }
      return res.json({ status: "SUCCESS", id: close_labour_id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const labourResult = await pool.query("SELECT * FROM labour WHERE id = $1", [labour_id]);
    if (!labourResult.rows[0]) return res.status(404).json({ error: "Labour bill not found" });
    const labour = labourResult.rows[0];
    await pool.query("INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING", ["Receipt Voucher"]);
    const result = await pool.query(
      `INSERT INTO labour (profile_id, company_name, date, issue_number, voucher_type, receipt_bill_no, taxable_total, cgst, sgst, igst, round_off, total, tds, bill_value_after_deduction, created_by, photo_url, photo_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        labour.profile_id, labour.company_name, closing_date, labour.issue_number,
        "Receipt Voucher", req.body.bill_no || null, taxable_total || null, cgst || null,
        sgst || null, igst || null, round_off || null, total || null, tds || null,
        bill_value_after_deduction || null, req.body.created_by || null,
        req.body.photo_url || null, req.body.photo_urls?.length ? req.body.photo_urls : null,
      ],
    );
    const close_labour_id = result.rows[0].id;
    if (items?.length) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO labour_items (labour_id, sl_no, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            close_labour_id, item.sl_no, item.description,
            partial_qty && closing_type === "partial" ? partial_qty : item.quantity,
            item.rate, item.amount,
          ],
        );
      }
    }
    if (payment_voucher_id) {
      await pool.query(`UPDATE vouchers SET linked_labour_id = $1 WHERE id = $2`, [close_labour_id, payment_voucher_id]);
    }
    res.json({ status: "SUCCESS", id: close_labour_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
