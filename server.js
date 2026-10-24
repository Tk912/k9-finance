// K9 פיננסים — server
// Serves the app, protects it with Google sign-in (allow-listed emails only),
// reads the Google Sheet with a service account, and sends receipt photos to Claude for parsing.
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { drive: driveApi } = require("@googleapis/drive");
const { GoogleAuth, OAuth2Client } = require("google-auth-library");

const PORT = Number(process.env.PORT) || 8080;
const SHEET_FILE_ID = process.env.SHEET_FILE_ID || "1gLA2t9RToM5N-LhdSSqEufR3pGdTN8ouT8Yu_Pa0o3U";
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const SESSION_DAYS = 180;
const COOKIE = "k9_session";
const AUTH_READY = !!GOOGLE_CLIENT_ID && ALLOWED_EMAILS.size > 0;

// Fail closed: without a client ID and an allow-list nobody can get in.
if (!AUTH_READY) console.warn("WARNING: GOOGLE_CLIENT_ID or ALLOWED_EMAILS is not set — nobody can sign in.");
if (!process.env.SESSION_SECRET) console.warn("WARNING: SESSION_SECRET is not set — logins reset on every restart.");

// ---------- Google Drive (service account via Application Default Credentials) ----------
// On Cloud Run: the service account attached to the service.
// Locally: GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
const drive = driveApi({ version: "v3", auth: googleAuth });
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---------- sessions (signed cookie holding the signed-in email, no database needed) ----------
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeToken(email) {
  const payload = String(Date.now() + SESSION_DAYS * 864e5) + "." + Buffer.from(email).toString("base64url");
  return payload + "." + sign(payload);
}
// Returns the session's email, or "" if the cookie is missing, forged, expired,
// or the email was removed from ALLOWED_EMAILS since sign-in.
function sessionEmail(token) {
  if (!token) return "";
  const parts = String(token).split(".");
  if (parts.length !== 3) return "";
  const [exp, emailB64, sig] = parts;
  const expected = sign(exp + "." + emailB64);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return "";
  if (!(Number(exp) > Date.now())) return "";
  const email = Buffer.from(emailB64, "base64url").toString("utf8").toLowerCase();
  return ALLOWED_EMAILS.has(email) ? email : "";
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (req, res) => res.send("ok"));

// ---------- login (Google Identity Services) ----------
const LOGIN_ERRORS = {
  denied: (email) => `החשבון ${escapeHtml(email)} לא מורשה להיכנס.`,
  failed: () => "ההתחברות נכשלה, נסו שוב.",
  config: () => "ההתחברות עם Google עדיין לא הוגדרה בשרת.",
  busy: () => "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות."
};

const loginPage = (req, errorKey, email) => {
  const loginUri = `${req.protocol}://${req.get("host")}/login/google`;
  const error = errorKey ? LOGIN_ERRORS[errorKey](email || "") : "";
  const button = AUTH_READY
    ? `<script src="https://accounts.google.com/gsi/client" async></script>
  <div id="g_id_onload" data-client_id="${escapeHtml(GOOGLE_CLIENT_ID)}" data-ux_mode="redirect"
       data-login_uri="${escapeHtml(loginUri)}" data-auto_prompt="false"></div>
  <div class="g_id_signin" data-type="standard" data-size="large" data-theme="filled_blue"
       data-text="signin_with" data-shape="pill" data-locale="he" data-logo_alignment="left"></div>`
    : "";
  return `<!DOCTYPE html>
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
  main{background:var(--card);padding:32px 28px;border-radius:16px;width:100%;max-width:340px;
       box-shadow:0 8px 30px rgba(0,0,0,.08);display:grid;gap:16px;text-align:center;justify-items:center}
  img{width:72px;height:72px;border-radius:16px}
  h1{margin:0;font-size:24px}
  .err{color:var(--err);font-size:14px;min-height:1em;margin:0}
</style></head><body>
<main>
  <img src="/icon-192.png" alt="">
  <h1>K9 פיננסים</h1>
  ${button}
  <p class="err">${error}</p>
</main></body></html>`;
};

const PUBLIC_PATHS = new Set(["/login", "/login/google", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]);

app.get("/login", (req, res) => res.type("html").send(loginPage(req, AUTH_READY ? "" : "config")));

let failedLogins = [];
// Google posts the signed ID token here (form field "credential").
app.post("/login/google", async (req, res) => {
  const now = Date.now();
  failedLogins = failedLogins.filter((t) => now - t < 15 * 60e3);
  if (!AUTH_READY) return res.status(503).type("html").send(loginPage(req, "config"));
  if (failedLogins.length >= 30) return res.status(429).type("html").send(loginPage(req, "busy"));

  // Double-submit CSRF check from Google Identity Services (when the cookie is present).
  const csrfCookie = readCookie(req, "g_csrf_token");
  const csrfBody = req.body && req.body.g_csrf_token;
  if (csrfCookie && csrfCookie !== csrfBody) {
    failedLogins.push(now);
    return res.status(400).type("html").send(loginPage(req, "failed"));
  }

  let payload;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: String((req.body && req.body.credential) || ""), audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    console.warn("google sign-in: invalid token:", e && e.message);
    failedLogins.push(now);
    return res.status(401).type("html").send(loginPage(req, "failed"));
  }

  const email = String((payload && payload.email) || "").toLowerCase();
  if (!email || payload.email_verified !== true || !ALLOWED_EMAILS.has(email)) {
    console.warn("google sign-in: denied", email || "(no email)");
    failedLogins.push(now);
    return res.status(403).type("html").send(loginPage(req, "denied", email || "?"));
  }

  console.log("google sign-in:", email);
  res.setHeader("Set-Cookie", `${COOKIE}=${makeToken(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  res.redirect(303, "/");
});

// The old password form is gone; anything posting to /login goes back to the sign-in page.
app.post("/login", (req, res) => res.redirect(303, "/login"));

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect(303, "/login");
});

// everything below requires a session
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || sessionEmail(readCookie(req, COOKIE))) return next();
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
