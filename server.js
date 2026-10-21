// K9 פיננסים — server
// Serves the app, protects it with a family password, reads the Google Sheet
// with a service account, and sends receipt photos to Claude for parsing.
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { drive: driveApi } = require("@googleapis/drive");
const { GoogleAuth } = require("google-auth-library");

const PORT = Number(process.env.PORT) || 8080;
const SHEET_FILE_ID = process.env.SHEET_FILE_ID || "1gLA2t9RToM5N-LhdSSqEufR3pGdTN8ouT8Yu_Pa0o3U";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const SESSION_DAYS = 180;
const COOKIE = "k9_session";

if (!APP_PASSWORD) console.warn("WARNING: APP_PASSWORD is not set — the app is open to anyone with the URL.");
if (!process.env.SESSION_SECRET) console.warn("WARNING: SESSION_SECRET is not set — logins reset on every restart.");

// ---------- Google Drive (service account via Application Default Credentials) ----------
// On Cloud Run: the service account attached to the service.
// Locally: GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
const drive = driveApi({ version: "v3", auth: googleAuth });

// ---------- sessions (signed cookie, no database needed) ----------
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + "." + sign(exp);
}
function validToken(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (req, res) => res.send("ok"));

// ---------- login ----------
const loginPage = (error) => `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>K9 פיננסים — כניסה</title>
<link rel="icon" href="/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1F4A37">
<style>
  :root{--bg:#F4F1EA;--card:#fff;--ink:#1d2a24;--accent:#1F4A37;--err:#a3342b}
  @media (prefers-color-scheme: dark){:root{--bg:#121815;--card:#1b2420;--ink:#e6ece8;--accent:#5fa883;--err:#e07a70}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
       font:16px "Assistant",-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
  form{background:var(--card);padding:32px 28px;border-radius:16px;width:100%;max-width:340px;
       box-shadow:0 8px 30px rgba(0,0,0,.08);display:grid;gap:14px;text-align:center}
  img{width:72px;height:72px;margin:0 auto;border-radius:16px}
  h1{margin:0;font-size:24px}
  input{font:inherit;padding:12px;border-radius:10px;border:1px solid #ccc;background:transparent;color:inherit;text-align:center}
  button{font:inherit;font-weight:700;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
  .err{color:var(--err);font-size:14px;min-height:1em;margin:0}
</style></head><body>
<form method="post" action="/login">
  <img src="/icon-192.png" alt="">
  <h1>K9 פיננסים</h1>
  <input type="password" name="password" placeholder="סיסמה" autofocus required autocomplete="current-password">
  <button type="submit">כניסה</button>
  <p class="err">${error ? "סיסמה שגויה, נסו שוב." : ""}</p>
</form></body></html>`;

const PUBLIC_PATHS = new Set(["/login", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]);

app.get("/login", (req, res) => res.type("html").send(loginPage(false)));

let failedLogins = [];
app.post("/login", (req, res) => {
  const now = Date.now();
  failedLogins = failedLogins.filter((t) => now - t < 15 * 60e3);
  if (failedLogins.length >= 20) return res.status(429).type("html").send(loginPage(true));
  if (!APP_PASSWORD || safeEqual(req.body.password || "", APP_PASSWORD)) {
    res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    return res.redirect(303, "/");
  }
  failedLogins.push(now);
  res.status(401).type("html").send(loginPage(true));
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect(303, "/login");
});

// everything below requires a session
app.use((req, res, next) => {
  if (!APP_PASSWORD || PUBLIC_PATHS.has(req.path) || validToken(readCookie(req, COOKIE))) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ code: "session_expired", message: "צריך להתחבר מחדש" });
  res.redirect(302, "/login");
});

// ---------- API ----------
app.get("/api/limits", (req, res) => res.json({ scan: !!ANTHROPIC_API_KEY }));

// The family Google Sheet, exported as .xlsx, returned as base64
app.get("/api/sheet", async (req, res) => {
  try {
    const r = await drive.files.export(
      { fileId: SHEET_FILE_ID, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { responseType: "arraybuffer" }
    );
    res.set("Cache-Control", "no-store");
    res.json({ content: Buffer.from(r.data).toString("base64") });
  } catch (e) {
    const status = (e && (e.code || (e.response && e.response.status))) || 500;
    console.error("sheet export failed:", status, e && e.message);
    if (status === 403 || status === 404) {
      return res.status(502).json({
        code: "no_access",
        message: "לשרת אין גישה לגיליון. שתפו את הגיליון (צפייה) עם כתובת חשבון השירות."
      });
    }
    res.status(502).json({ code: "sheet_error", message: "קריאת הגיליון נכשלה. נסו שוב בעוד רגע." });
  }
});

// Receipt parsing: prompt (+ optional image) -> one JSON object from Claude
app.post("/api/sample", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ code: "sampling_disabled" });
  const prompt = String((req.body && req.body.prompt) || "").slice(0, 20000);
  const image = req.body && req.body.image;
  if (!prompt) return res.status(400).json({ code: "bad_request" });

  const content = [];
  if (image && image.data) {
    const mediaType = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mediaType) ? image.mediaType : "image/jpeg";
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: String(image.data) } });
  }
  content.push({ type: "text", text: prompt });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: "user", content }] })
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("claude error:", r.status, body && body.error);
      const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 400 && image ? "image_rejected" : "server_error";
      return res.status(502).json({ code });
    }
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!text) return res.status(502).json({ code: "empty_completion" });
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return res.status(502).json({ code: "invalid_json" });
    let result;
    try { result = JSON.parse(text.slice(start, end + 1)); } catch (e) { return res.status(502).json({ code: "invalid_json" }); }
    res.json({ result });
  } catch (e) {
    console.error("claude request failed:", e && e.message);
    res.status(502).json({ code: "server_error" });
  }
});

// ---------- static app ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

app.listen(PORT, () => console.log(`K9 פיננסים listening on port ${PORT}`));
