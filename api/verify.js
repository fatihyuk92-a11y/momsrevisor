const { methodGuard, readJson, sendJson, verifyToken } = require("./_utils");

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;

  try {
    const body = await readJson(req);
    const user = verifyToken(String(body.token || ""));
    if (!user) return sendJson(res, 200, { gyldig: false, årsag: "Token er ugyldig eller udløbet." });

    return sendJson(res, 200, {
      gyldig: true,
      ok: true,
      email: user.email,
      navn: user.navn
    });
  } catch (error) {
    return sendJson(res, 200, { gyldig: false, årsag: error.message || "Kunne ikke verificere adgang." });
  }
};
