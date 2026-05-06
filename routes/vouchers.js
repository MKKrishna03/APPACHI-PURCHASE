const express = require("express");
const { pool } = require("../db");

const router = express.Router();

function num(v) {
  return v === "" || v == null ? null : v;
}

router.get("/voucher-types", async (req, res) => {
  try {
    const result = await pool.query("SELECT name FROM voucher_types ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/voucher-type", async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query("INSERT INTO voucher_types (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
    res.json({ status: "SUCCESS" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/seed-voucher-types", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO voucher_types (name) VALUES ('Create Issue Voucher'), ('Close Issue Voucher') ON CONFLICT DO NOTHING",
    );
    res.json({ status: "SUCCESS", message: "Voucher types seeded" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/labour-item-types", async (req, res) => {
  try {
    const result = await pool.query("SELECT name FROM labour_item_types ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/vouchers/list", async (req, res) => {
  const { profile_id, voucher_type, unlinked_only } = req.query;
  try {
    const params = [];
    let where = "";
    if (profile_id && profile_id !== "undefined" && profile_id !== "null") {
      params.push(profile_id);
      where += `${where ? " AND" : " WHERE"} v.profile_id = $${params.length}`;
    }
    if (voucher_type) {
      params.push(`%${voucher_type}%`);
      where += `${where ? " AND" : " WHERE"} v.voucher_type ILIKE $${params.length}`;
    }
    if (unlinked_only === "true") {
      where += `${where ? " AND" : " WHERE"} linked_labour_id IS NULL AND linked_chittai_id IS NULL AND linked_purchase_id IS NULL AND v.voucher_type NOT IN ('Payment Voucher', 'Receipt Voucher', 'Chittai Payment')`;
    }
    const result = await pool.query(
      `SELECT v.id, v.profile_id, v.voucher_type, v.date, v.bill_no, v.total_value, v.entry_type,
              v.description, v.linked_labour_id, v.linked_chittai_id, v.linked_purchase_id,
              v.created_at, v.created_by, u.name AS created_by_name
       FROM vouchers v LEFT JOIN auth_users u ON u.user_id::text = v.created_by
       ${where} ORDER BY v.created_at DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/vouchers", async (req, res) => {
  const {
    profile_id, voucher_type, date, bill_no, entry_type, description,
    qty, rate, va, taxable_value, tax_percent, igst, cgst, sgst, tax_amount, total_value,
  } = req.body;
  try {
    let linked_labour_id = null;
    if (entry_type === "against" && bill_no && voucher_type?.toLowerCase().includes("labour")) {
      const labourMatch = await pool.query(
        `SELECT id FROM labour WHERE receipt_bill_no = $1 AND profile_id = $2 AND voucher_type = 'Receipt Voucher' LIMIT 1`,
        [bill_no, profile_id],
      );
      if (labourMatch.rows[0]) linked_labour_id = labourMatch.rows[0].id;
    }
    let linked_chittai_id = null;
    if (entry_type === "against" && bill_no) {
      const chittaiMatch = await pool.query(
        `SELECT id FROM chittai WHERE chittai_no = $1 AND profile_id = $2 LIMIT 1`,
        [bill_no, profile_id],
      );
      if (chittaiMatch.rows[0]) {
        linked_chittai_id = chittaiMatch.rows[0].id;
        await pool.query(`UPDATE chittai SET is_paid=true WHERE id=$1`, [linked_chittai_id]);
      }
    }
    let voucher_no = null;
    if (voucher_type === "Payment Voucher") {
      const seq = await pool.query(`SELECT nextval('payment_voucher_seq') AS val`);
      voucher_no = "P-" + String(seq.rows[0].val).padStart(2, "0");
    } else if (voucher_type === "Receipt Voucher") {
      const seq = await pool.query(`SELECT nextval('receipt_voucher_seq') AS val`);
      voucher_no = "R-" + String(seq.rows[0].val).padStart(2, "0");
    }
    const result = await pool.query(
      `INSERT INTO vouchers
        (profile_id,voucher_type,date,bill_no,entry_type,description,qty,rate,va,taxable_value,
         tax_percent,igst,cgst,sgst,tax_amount,total_value,linked_labour_id,linked_chittai_id,created_by,voucher_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        profile_id, voucher_type, date, bill_no, entry_type, description,
        num(qty), num(rate), num(va), num(taxable_value), num(tax_percent),
        num(igst), num(cgst), num(sgst), num(tax_amount), num(total_value),
        linked_labour_id, linked_chittai_id, req.body.created_by || null, voucher_no,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/vouchers/:id", async (req, res) => {
  const { date, total_value, description, linked_chittai_id, profile_id, voucher_type, bill_no, entry_type } = req.body;
  try {
    let result;
    if (linked_chittai_id !== undefined && Object.keys(req.body).length === 1) {
      result = await pool.query(`UPDATE vouchers SET linked_chittai_id=$1 WHERE id=$2 RETURNING *`, [linked_chittai_id, req.params.id]);
    } else {
      let linked_chittai_id_val = null;
      if (entry_type === "against" && bill_no && profile_id) {
        const chittaiMatch = await pool.query(`SELECT id FROM chittai WHERE chittai_no = $1 AND profile_id = $2 LIMIT 1`, [bill_no, profile_id]);
        if (chittaiMatch.rows[0]) {
          linked_chittai_id_val = chittaiMatch.rows[0].id;
          await pool.query(`UPDATE chittai SET is_paid=true WHERE id=$1`, [linked_chittai_id_val]);
        }
      }
      result = await pool.query(
        `UPDATE vouchers SET profile_id=$1, voucher_type=$2, date=$3, bill_no=$4, entry_type=$5, description=$6, total_value=$7, linked_chittai_id=COALESCE($8, linked_chittai_id) WHERE id=$9 RETURNING *`,
        [profile_id, voucher_type, date, bill_no, entry_type, description, total_value, linked_chittai_id_val, req.params.id],
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
