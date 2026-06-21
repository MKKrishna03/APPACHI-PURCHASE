require("dotenv").config();
process.env.TZ = "Asia/Kolkata";

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const { initDB, companyStore, oldPool, newPool } = require("./db");
const { requireAuth } = require("./middleware/auth");
const { requestLogger } = require("./middleware/logger");
const { sseHandler } = require("./sse");

// Route modules
const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profiles");
const labourRoutes = require("./routes/labour");
const purchaseRoutes = require("./routes/purchases");
const chittaiRoutes = require("./routes/chittai");
const voucherRoutes = require("./routes/vouchers");
const hallmarkRoutes = require("./routes/hallmark");
const todoRoutes = require("./routes/todos");
const scheduleRoutes = require("./routes/schedule");
const { router: cloudinaryRouter } = require("./routes/cloudinary");
const aiRoutes = require("./routes/ai");
const miscRoutes = require("./routes/misc");
const cancelledBillsRoutes = require("./routes/cancelledBills");
const photoBillEntriesRoutes = require("./routes/photoBillEntries");
const { router: activityLogRouter } = require("./routes/activityLog");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// ── Security headers ──
app.use(
  helmet({
    contentSecurityPolicy: false, // disabled — HTML pages load inline scripts
    crossOriginEmbedderPolicy: false,
  }),
);

// ── CORS ──
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000"];

app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.startsWith("http://localhost")
      ) {
        return cb(null, true);
      }
      cb(new Error("CORS not allowed"));
    },
    credentials: true,
  }),
);

// ── Rate limiting ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "AI scan rate limit reached. Wait a minute before scanning again.",
  },
});

app.use("/api/", globalLimiter);
app.use("/api/ai-scan", aiLimiter);
app.use("/api/ai-scan-text", aiLimiter);

// ── Body parsers ──
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Company context middleware ──
// Reads X-Company-ID header (sent by company-context.js on every /api fetch)
// and binds the correct DB pool for the duration of the request via AsyncLocalStorage.
// companyId 1 = APPACHI JEWELLERY (old DB), 2 = APPACHI JEWELLERY PVT LTD (new DB)
app.use("/api/", (req, res, next) => {
  // Default to company 1 (old DB) when header is absent so existing data
  // is visible even before company-context.js has run on the client.
  const cid = req.headers["x-company-id"] === "2" ? 2 : 1;
  companyStore.run(cid, () => next());
});

// ── Request logging ──
app.use(requestLogger);

// ── Static files ──
app.use(express.static(path.join(__dirname)));

// ── Health check (no auth required) ──
app.get("/health", async (req, res) => {
  const { pool } = require("./db");
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch {
    res.status(503).json({
      status: "error",
      db: "disconnected",
      ts: new Date().toISOString(),
    });
  }
});

// ── Auth middleware on all /api/ routes ──
app.use("/api/", requireAuth);

// ── Server-Sent Events ──
app.get("/api/events", sseHandler);

// ── API routes ──
app.use("/api", authRoutes);
app.use("/api", profileRoutes);
app.use("/api", labourRoutes);
app.use("/api", purchaseRoutes);
app.use("/api", chittaiRoutes);
app.use("/api", voucherRoutes);
app.use("/api", hallmarkRoutes);
app.use("/api", todoRoutes);
app.use("/api", scheduleRoutes);
app.use("/api", cloudinaryRouter);
app.use("/api", aiRoutes);
app.use("/api", miscRoutes);
app.use("/api", cancelledBillsRoutes);
app.use("/api", photoBillEntriesRoutes);
app.use("/api", activityLogRouter);

// ── Companies endpoint ──
app.get("/api/companies", (req, res) => {
  res.json([
    { id: 1, name: "APPACHI JEWELLERY", sub: "Sole Proprietorship (Old)", color: "#92400e", dot: "#f59e0b" },
    { id: 2, name: "AJ PRIVATE LIMITED", fullName: "APPACHI JEWELLERY PVT LTD", sub: "Private Limited (Active)", color: "#065f46", dot: "#10b981" },
  ]);
});

// ── One-time admin endpoint: copy reference data from old DB to new DB ──
app.post("/api/admin/copy-reference-data", async (req, res) => {
  if (newPool === oldPool) return res.status(400).json({ error: "NEW_DATABASE_URL not configured" });
  try {
    const tables = [
      { name: "profiles", seq: "profiles_id_seq" },
      { name: "auth_users", seq: "auth_users_id_seq" },
      { name: "descriptions", seq: "descriptions_id_seq" },
      { name: "labour_item_types", seq: "labour_item_types_id_seq" },
      { name: "tds", seq: "tds_id_seq" },
      { name: "tax_format", seq: "tax_format_id_seq" },
      { name: "voucher_types", seq: "voucher_types_id_seq" },
    ];
    const report = [];
    for (const { name, seq } of tables) {
      const { rows } = await oldPool.query(`SELECT * FROM ${name} ORDER BY id`);
      if (!rows.length) { report.push({ table: name, copied: 0 }); continue; }
      await newPool.query(`DELETE FROM ${name}`);
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((_, i) => `$${i + 1}`);
        await newPool.query(
          `INSERT INTO ${name} (${cols.join(",")}) VALUES (${vals.join(",")}) ON CONFLICT DO NOTHING`,
          Object.values(row),
        );
      }
      const maxId = Math.max(...rows.map((r) => r.id || 0));
      if (maxId > 0) await newPool.query(`SELECT setval('${seq}', $1)`, [maxId]);
      report.push({ table: name, copied: rows.length });
    }
    res.json({ status: "SUCCESS", report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Page routes ──
const pages = {
  "/": "login.html",
  "/login": "login.html",
  "/dashboard": "dashboard.html",
  "/profile": "profile.html",
  "/labour": "labour.html",
  "/labclose": "labclose.html",
  "/transaction": "newtrns.html",
  "/newtrns": "newtrns.html",
  "/receipt": "newtrns.html",
  "/payment": "newtrns.html",
  "/chittai": "chittai.html",
  "/purchase": "purchase.html",
  "/note": "note.html",
  "/hmex": "hmex.html",
  "/media": "media.html",
  "/company": "company.html",
  "/reports/transaction": "trnsrpt.html",
  "/reports/iv-rv": "vhrrpt.html",
  "/reports/chittai": "ctirpt.html",
  "/reports/purchase": "prchsrpt.html",
  "/reports/hallmark": "hmrpt.html",
  "/reports/expense": "exprpt.html",
  "/reports/tds": "tds.html",
  "/reports/cd-note": "cdrpt.html",
  "/reports/cancelled": "cancelrpt.html",
  "/photo-entry": "photobill.html",
  "/mc": "mc.html",
};

// Inject company-context.js into every HTML page so the company switcher
// and fetch interceptor (X-Company-ID header) are available without
// touching the 20+ individual HTML files.
const CO_SCRIPT = '<script src="/company-context.js"></script>';
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => {
    try {
      let html = fs.readFileSync(path.join(__dirname, file), "utf8");
      html = html.replace("</head>", CO_SCRIPT + "\n</head>");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch {
      res.sendFile(path.join(__dirname, file));
    }
  });
}

// Mobile upload page (token-based, no auth)
app.get("/upload/:token", (req, res) =>
  res.sendFile(path.join(__dirname, "mobile-upload.html")),
);

// ── Global error handler ──
// Express 5 async routes propagate thrown errors here automatically.
// Routes with try/catch also call next(err) on failure.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Internal server error";
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
    }),
  );
  if (!res.headersSent) res.status(status).json({ error: message });
});

// ── Process-level crash guards ──
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "Unhandled promise rejection", reason: String(reason) }),
  );
});

process.on("uncaughtException", (err) => {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "Uncaught exception", error: err.message, stack: err.stack }),
  );
  process.exit(1);
});

// ── Sync profiles from oldPool → newPool on startup ──
async function syncProfilesToNewDb() {
  if (newPool === oldPool) return;
  try {
    const { rows } = await oldPool.query(`SELECT * FROM profiles ORDER BY id`);
    if (!rows.length) return;
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((_, i) => `$${i + 1}`);
      const updateCols = cols.filter((c) => c !== "id");
      await newPool.query(
        `INSERT INTO profiles (${cols.join(",")}) VALUES (${vals.join(",")})
         ON CONFLICT (id) DO UPDATE SET ${updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(",")}`,
        Object.values(row),
      );
    }
    const maxId = Math.max(...rows.map((r) => r.id || 0));
    if (maxId > 0) await newPool.query(`SELECT setval('profiles_id_seq', GREATEST(currval('profiles_id_seq'), $1))`, [maxId]);
    console.log(`[DB] Synced ${rows.length} profiles to new DB`);
  } catch (err) {
    console.error("[DB] Profile sync on startup failed:", err.message);
  }
}

// ── Start ──
initDB()
  .then(() => syncProfilesToNewDb())
  .then(() => {
    app.listen(PORT, () =>
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: `Server running on port ${PORT}`,
        }),
      ),
    );
  })
  .catch((err) => {
    console.error("INITDB FAILED:", err);
    process.exit(1);
  });
