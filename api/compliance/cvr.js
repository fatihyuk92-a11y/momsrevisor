const { methodGuard, readJson, requireAuth, sendJson } = require("../_utils");

function normalizeCVR(value) {
  const cvr = String(value || "").replace(/\D/g, "");
  return /^\d{8}$/.test(cvr) ? cvr : "";
}

function mapCVRApi(data, cvr) {
  return {
    navn: data.name || data.navn || "Ukendt virksomhed",
    cvr,
    status: data.status || "Ukendt",
    branche: data.industrydesc || data.branche || "Ukendt",
    brancheKode: data.industrycode || data.brancheKode || "",
    adresse: [data.address, data.zipcode, data.city].filter(Boolean).join(", ") || data.adresse || "",
    ansatte: data.employees || data.ansatte || "Ukendt",
    stiftet: data.startdate || data.stiftet || "Ukendt",
    ejerform: data.companydesc || data.ejerform || "Ukendt"
  };
}

async function fetchCVRData(cvr) {
  const endpoint = process.env.CVR_API_ENDPOINT || "https://cvrapi.dk/api";
  const url = `${endpoint}?search=${encodeURIComponent(cvr)}&country=dk`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "momsrevisor-compliance/1.0"
    }
  });

  if (!response.ok) throw new Error(`CVR-opslag fejlede (${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(data.message || data.error);
  return mapCVRApi(data, cvr);
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const cvr = normalizeCVR(body.cvr);
    if (!cvr) return sendJson(res, 400, { ok: false, fejl: "CVR-nummer skal være præcis 8 cifre." });

    try {
      const virksomhed = await fetchCVRData(cvr);
      return sendJson(res, 200, { ok: true, kilde: "cvrapi", virksomhed });
    } catch (lookupError) {
      if (process.env.ALLOW_CVR_FALLBACK !== "true") throw lookupError;
      return sendJson(res, 200, {
        ok: true,
        kilde: "fallback",
        advarsel: lookupError.message,
        virksomhed: {
          navn: "Ukendt virksomhed",
          cvr,
          status: "Ukendt",
          branche: "Ukendt",
          brancheKode: "",
          adresse: "",
          ansatte: "Ukendt",
          stiftet: "Ukendt",
          ejerform: "Ukendt"
        }
      });
    }
  } catch (error) {
    return sendJson(res, 502, { ok: false, fejl: error.message || "Kunne ikke hente CVR-data." });
  }
};
