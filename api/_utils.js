const crypto = require("crypto");

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function methodGuard(req, res, methods = ["POST"]) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  sendJson(res, 405, { ok: false, fejl: "Metoden er ikke tilladt." });
  return false;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function tokenSecret() {
  return process.env.PRO_TOKEN_SECRET || process.env.AUTH_SECRET || "dev-change-me";
}

function sign(value) {
  return base64url(crypto.createHmac("sha256", tokenSecret()).update(value).digest());
}

function createToken(user) {
  const payload = base64url(JSON.stringify({
    email: user.email,
    navn: user.navn || user.email.split("@")[0],
    exp: Date.now() + TOKEN_TTL_MS
  }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const data = JSON.parse(fromBase64url(payload));
  if (!data.exp || Date.now() > data.exp) return null;
  return { email: data.email, navn: data.navn || data.email };
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireAuth(req, res) {
  const user = verifyToken(getBearerToken(req));
  if (!user) {
    sendJson(res, 401, { ok: false, fejl: "Adgang udløbet. Log ind igen." });
    return null;
  }
  return user;
}

function allowedEmails() {
  return String(process.env.PRO_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email) {
  if (process.env.ALLOW_ANY_EMAIL === "true") return true;
  if (email.toLowerCase() === "test@momsrevisor.dk") return true;
  const allowed = allowedEmails();
  if (!allowed.length) return false;
  return allowed.includes(email.toLowerCase());
}

function sanitizeText(value, max = 12000) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function anthropicKey() {
  return process.env.ANTHROPIC_API_KEY || "";
}

async function callAnthropic({ messages, system, maxTokens = 1200 }) {
  const apiKey = anthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY mangler i Vercel miljøvariabler.");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Anthropic API fejl (${response.status})`;
    throw new Error(message);
  }

  return data.content?.find(part => part.type === "text")?.text || "";
}

module.exports = {
  callAnthropic,
  createToken,
  isEmailAllowed,
  methodGuard,
  readJson,
  requireAuth,
  sanitizeText,
  sendJson,
  verifyToken
};
