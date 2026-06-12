const { clientIp, createToken, enforceRateLimit, isEmailAllowed, methodGuard, readJson, sendJson } = require("./_utils");

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;

  try {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { ok: false, fejl: "Indtast en gyldig email-adresse." });
    }

    if (!isEmailAllowed(email)) {
      return sendJson(res, 403, {
        ok: false,
        fejl: "Emailen har ikke PRO-adgang. Kontakt os, hvis du mener det er en fejl."
      });
    }

    const navn = email.split("@")[0];
    return sendJson(res, 200, {
      ok: true,
      token: createToken({ email, navn }),
      email,
      navn
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "Login fejlede." });
  }
};
