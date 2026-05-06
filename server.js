require("dotenv").config();
process.env.TZ = "Asia/Kolkata";

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

const { initDB } = require("./db");
const { requireAuth } = require("./middleware/auth");
const { requestLogger } = require("./middleware/logger");
const { sseHandler } = require("./sse");

// Route modules
const authRoutes      = require("./routes/auth");
const profileRoutes   = require("./routes/profiles");
const labourRoutes    = require("./routes/labour");
const purchaseRoutes  = require("./routes/purchases");
const chittaiRoutes   = require("./routes/chittai");
const voucherRoutes   = require("./routes/vouchers");
const hallmarkRoutes  = require("./routes/hallmark");
const todoRoutes      = require("./routes/todos");
const scheduleRoutes  = require("./routes/schedule");
const { router: cloudinaryRouter } = require("./routes/cloudinary");
const aiRoutes        = require("./routes/ai");
const miscRoutes      = require("./routes/misc");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ──
app.use(helmet({
  contentSecurityPolicy: false, // disabled — HTML pages load inline scripts
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ──
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith("http://localhost")) {
      return cb(null, true);
    }
    cb(new Error("CORS not allowed"));
  },
  credentials: true,
}));

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
  message: { error: "AI scan rate limit reached. Wait a minute before scanning again." },
});

app.use("/api/", globalLimiter);
app.use("/api/ai-scan", aiLimiter);
app.use("/api/ai-scan-text", aiLimiter);

// ── Body parsers ──
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

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
    res.status(503).json({ status: "error", db: "disconnected", ts: new Date().toISOString() });
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

// ── Page routes ──
const pages = {
  "/":                    "login.html",
  "/login":               "login.html",
  "/dashboard":           "dashboard.html",
  "/profile":             "profile.html",
  "/labour":              "labour.html",
  "/labclose":            "labclose.html",
  "/transaction":         "newtrns.html",
  "/newtrns":             "newtrns.html",
  "/receipt":             "newtrns.html",
  "/payment":             "newtrns.html",
  "/chittai":             "chittai.html",
  "/purchase":            "purchase.html",
  "/note":                "note.html",
  "/hmex":                "hmex.html",
  "/media":               "media.html",
  "/company":             "company.html",
  "/reports/transaction": "trnsrpt.html",
  "/reports/iv-rv":       "vhrrpt.html",
  "/reports/chittai":     "ctirpt.html",
  "/reports/purchase":    "prchsrpt.html",
  "/reports/hallmark":    "hmrpt.html",
  "/reports/expense":     "exprpt.html",
  "/reports/tds":         "tds.html",
};

for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// Mobile upload page (token-based, no auth)
app.get("/upload/:token", (req, res) => res.sendFile(path.join(__dirname, "mobile-upload.html")));

// ── Start ──
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: `Server running on port ${PORT}` })));
  })
  .catch((err) => {
    console.error("INITDB FAILED:", err);
    process.exit(1);
  });
