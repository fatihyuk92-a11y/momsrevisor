const { callAnthropic, enforceRateLimit, methodGuard, readJson, requireAuth, sanitizeText, sendJson } = require("./_utils");
const KNOWLEDGE = require("./_knowledge");

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  const user = requireAuth(req, res);
  if (!user) return;

  // 30 beskeder pr. time pr. bruger - juster efter behov.
  if (!(await enforceRateLimit(req, res, { name: "chat", key: user.email, max: 30, windowSeconds: 3600 }))) return;

  try {
    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const safeMessages = messages.slice(-12).map(message => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: sanitizeText(message.content, 2500)
    })).filter(message => message.content);

    if (!safeMessages.length) {
      return sendJson(res, 400, { ok: false, fejl: "Tom besked." });
    }

    // SIKKERHED: body.system ignoreres bevidst. System prompten ligger paa
    // serveren (api/_knowledge.js), saa klienter ikke kan bruge endpointet
    // som generel Claude-proxy med egen system prompt.
    const reply = await callAnthropic({
      system: [{ type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } }],
      messages: safeMessages,
      maxTokens: 1500
    });

    return sendJson(res, 200, { ok: true, reply });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "AI-raadgiveren svarede ikke." });
  }
};
