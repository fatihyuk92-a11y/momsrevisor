const { callAnthropic, methodGuard, readJson, requireAuth, sanitizeText, sendJson } = require("./_utils");

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  if (!requireAuth(req, res)) return;

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

    const reply = await callAnthropic({
      system: sanitizeText(body.system, 12000),
      messages: safeMessages,
      maxTokens: 1000
    });

    return sendJson(res, 200, { ok: true, reply });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "AI-rådgiveren svarede ikke." });
  }
};
