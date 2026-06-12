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

// SIKKERHED: Fejler haardt hvis PRO_TOKEN_SECRET mangler.
// Ingen fallback-secret - en kendt default ville lade alle forfalske tokens.
function tokenSecret() {
  const secret = process.env.PRO_TOKEN_SECRET || process.env.AUTH_SECRET || "";
  if (!secret || secret === "dev-change-me" || secret.length < 16) {
    throw new Error("PRO_TOKEN_SECRET mangler eller er for kort (min. 16 tegn). Saet den i Vercel miljoevariabler.");
  }
  return secret;
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
  try {
    const user = verifyToken(getBearerToken(req));
    if (!user) {
      sendJson(res, 401, { ok: false, fejl: "Adgang udloebet. Log ind igen." });
      return null;
    }
    return user;
  } catch (error) {
    // Rammes hvis PRO_TOKEN_SECRET mangler - konfigurationsfejl, ikke brugerfejl.
    sendJson(res, 500, { ok: false, fejl: error.message });
    return null;
  }
}

function allowedEmails() {
  return String(process.env.PRO_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

// SIKKERHED: test@momsrevisor.dk-bagdoeren er fjernet.
// Brug ALLOW_ANY_EMAIL=true midlertidigt under test - aldrig i produktion.
function isEmailAllowed(email) {
  if (process.env.ALLOW_ANY_EMAIL === "true") return true;
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

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "ukendt";
}

// ── SERVER-SIDE RATE LIMITING ────────────────────────────────────────────────
// Bruger Upstash Redis (REST) hvis UPSTASH_REDIS_REST_URL/TOKEN er sat -
// det taeller korrekt paa tvaers af alle serverless-instanser.
// Uden Redis falder vi tilbage paa en in-memory taeller pr. instans.
// Det stopper loekke-misbrug fra samme varme instans, men er IKKE en
// fuld garanti - saet Upstash op foer rigtige kunder.

const _memoryHits = new Map();

async function rateLimitHit(key, max, windowSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    try {
      const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
      const redisKey = `rl:${key}:${windowId}`;
      const response = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([
          ["INCR", redisKey],
          ["EXPIRE", redisKey, String(windowSeconds + 5)]
        ])
      });
      const data = await response.json().catch(() => null);
      const count = Array.isArray(data) ? Number(data[0]?.result) : NaN;
      if (Number.isFinite(count)) return count <= max;
      // Redis svarede uventet - fail-open, men log det.
      console.error("rateLimitHit: uventet Upstash-svar", data);
      return true;
    } catch (error) {
      console.error("rateLimitHit: Upstash-fejl", error.message);
      return true;
    }
  }

  // In-memory fallback (pr. serverless-instans)
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = _memoryHits.get(key);
  if (!entry || now - entry.start > windowMs) {
    _memoryHits.set(key, { start: now, count: 1 });
    if (_memoryHits.size > 5000) _memoryHits.clear(); // simpel oprydning
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

// Returnerer true hvis kaldet maa fortsaette; sender selv 429 hvis ikke.
async function enforceRateLimit(req, res, { name, key, max, windowSeconds }) {
  const allowed = await rateLimitHit(`${name}:${key}`, max, windowSeconds);
  if (!allowed) {
    sendJson(res, 429, {
      ok: false,
      fejl: "For mange forespoergsler. Vent et oejeblik og proev igen."
    });
    return false;
  }
  return true;
}


// Robust parsing af JSON fra modelsvar: fjerner evt. ```-hegn og tekst udenom.
function parseJsonLoose(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// Normaliserer en compliance-rapport fra modellen til et fast skema,
// saa frontend kan rendere deterministisk.
function normalizeRapport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, max = 600) => String(v ?? "").trim().slice(0, max);
  const alvorMap = { "kritisk": "kritisk", "h\u00f8j": "hoej", "hoej": "hoej", "h\u00f6j": "hoej", "mellem": "mellem", "medium": "mellem", "lav": "lav" };
  const katMap = { "moms": "moms", "skat": "skat", "samspil": "samspil", "asymmetri": "samspil", "moms/skat": "samspil" };
  const alvorRang = { kritisk: 0, hoej: 1, mellem: 2, lav: 3 };

  const fund = (Array.isArray(raw.fund) ? raw.fund : []).slice(0, 20).map(f => ({
    kategori: katMap[str(f?.kategori, 30).toLowerCase()] || "moms",
    alvor: alvorMap[str(f?.alvor, 20).toLowerCase()] || "mellem",
    grundlag: str(f?.grundlag, 30).toLowerCase() === "observeret" ? "observeret" : "risikovurdering",
    titel: str(f?.titel, 160),
    evidens: str(f?.evidens, 700),
    konto: str(f?.konto, 80),
    beloeb: str(f?.beloeb, 80),
    handling: str(f?.handling, 500),
    lov: str(f?.lov, 160)
  })).filter(f => f.titel)
    .sort((a, b) => alvorRang[a.alvor] - alvorRang[b.alvor]);

  const anbefalinger = (Array.isArray(raw.anbefalinger) ? raw.anbefalinger : []).slice(0, 10).map((a, i) => ({
    prioritet: Number.isFinite(Number(a?.prioritet)) ? Number(a.prioritet) : i + 1,
    tekst: str(a?.tekst, 500),
    lov: str(a?.lov, 160)
  })).filter(a => a.tekst).sort((a, b) => a.prioritet - b.prioritet);

  return {
    resume: str(raw.resume, 800),
    momsprofil: str(raw.momsprofil, 1200),
    skatteprofil: str(raw.skatteprofil, 1200),
    datagrundlag: str(raw.datagrundlag, 800),
    fund,
    anbefalinger,
    forbehold: str(raw.forbehold, 800)
  };
}

function anthropicKey() {
  return process.env.ANTHROPIC_API_KEY || "";
}

// system kan vaere en streng eller et array af content-blokke.
// Blokke med cache_control prompt-caches af Anthropic (fuld pris foerste kald,
// ~10% input-pris i efterfoelgende kald inden for cache-vinduet).
// Laeg den cachede vidensbase FOERST, saa chat og compliance deler samme cache-prefix.
async function callAnthropic({ messages, system, maxTokens = 1200, cacheSystem = false }) {
  const apiKey = anthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY mangler i Vercel miljoevariabler.");

  const systemPayload = system
    ? (Array.isArray(system)
        ? system
        : (cacheSystem
            ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
            : system))
    : undefined;

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
      ...(systemPayload ? { system: systemPayload } : {}),
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
  normalizeRapport,
  parseJsonLoose,
  clientIp,
  createToken,
  enforceRateLimit,
  isEmailAllowed,
  methodGuard,
  readJson,
  requireAuth,
  sanitizeText,
  sendJson,
  verifyToken
};
