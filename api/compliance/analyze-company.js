const { callAnthropic, enforceRateLimit, methodGuard, normalizeRapport, parseJsonLoose, readJson, requireAuth, sanitizeText, sendJson } = require("../_utils");
const KNOWLEDGE = require("../_knowledge");

const OPGAVE = `OPGAVE
Du er compliance-motoren i MomsRevisor. Lav en branchebaseret moms- og skatterisikovurdering af virksomheden ud fra CVR-data ovenfor. Brug vidensbasen som retskilde og henvis praecist (ML \u00a7, LSAL, LL \u00a7, SEL \u00a7, PSL/VSL, AL \u00a7).

REGLER
- Du har KUN CVR-stamdata - ingen bogfoering. Alle fund skal derfor have "grundlag":"risikovurdering", og "konto" og "beloeb" skal vaere tomme strenge.
- Vaer konkret for netop denne branche og ejerform - ikke generiske raad.
- Skriv "momsprofil" som en kort vurdering: momspligtig/fritaget/blandet, sandsynlig momsperiode, evt. loensumsafgift.
- Skriv "skatteprofil" tilsvarende: selskab vs. personlig virksomhed, beskatningsform, typiske fradragsforhold.

SVARFORMAT
Svar med PRAECIS et gyldigt JSON-objekt. Ingen markdown, ingen \`\`\`-hegn, ingen tekst foer eller efter.
{
 "resume": "2-3 saetninger med hovedkonklusionen for denne virksomhed",
 "momsprofil": "kort vurdering jf. ovenfor",
 "skatteprofil": "kort vurdering jf. ovenfor",
 "fund": [{"kategori":"moms"|"skat"|"samspil","alvor":"kritisk"|"hoej"|"mellem"|"lav","grundlag":"risikovurdering","titel":"kort overskrift","evidens":"hvorfor denne branche/ejerform giver risikoen","konto":"","beloeb":"","handling":"konkret naeste skridt","lov":"fx ML \u00a7 42"}],
 "anbefalinger": [{"prioritet":1,"tekst":"vigtigste handling foerst","lov":""}],
 "forbehold": "Hvad vurderingen ikke daekker uden regnskabsmateriale"
}
- 5-10 fund sorteret efter alvor, 3-5 anbefalinger. Brug "kritisk" kun ved markante branchefaelder.`;

function buildFallbackAnalysis(company) {
  const branche = String(company.branche || "").toLowerCase();
  const riskHints = [];

  if (/restaurant|cafe|hotel|event|underholdning|repr\u00e6sentation/.test(branche)) {
    riskHints.push("Restaurations- og repr\u00e6sentationsudgifter b\u00f8r kontrolleres s\u00e6rskilt, fordi moms- og skattefradrag ofte ikke f\u00f8lger samme logik.");
  }
  if (/byg|h\u00e5ndv\u00e6rk|entrepren\u00f8r|installation|anl\u00e6g/.test(branche)) {
    riskHints.push("Bygge- og installationsvirksomheder b\u00f8r kontrolleres for omvendt betalingspligt, underentrepren\u00f8rer og korrekt fakturakrav.");
  }
  if (/handel|webshop|detail|engros/.test(branche)) {
    riskHints.push("Handelsvirksomheder b\u00f8r kontrolleres for EU-k\u00f8b, importmoms, lagerafstemning og salg til udlandet.");
  }
  if (/r\u00e5dgiv|konsulent|it|software/.test(branche)) {
    riskHints.push("R\u00e5dgivnings- og IT-virksomheder b\u00f8r kontrolleres for EU-salg, reverse charge og periodisering af abonnementer.");
  }
  if (!riskHints.length) {
    riskHints.push("Der b\u00f8r laves en generel kontrol af momskoder, fradragsbegr\u00e6nsede udgifter, EU-transaktioner og periodisering.");
  }

  return [
    "**1. MOMSSTATUS**",
    `Virksomheden ${company.navn || "Ukendt virksomhed"} (CVR ${company.cvr || "ukendt"}) b\u00f8r vurderes ud fra branche, aktivitet og oms\u00e6tning. CVR-opslaget viser branche: ${company.branche || "ukendt"}.`,
    "",
    "**2. SKATTEM\u00c6SSIG STATUS**",
    `Ejerform er registreret som ${company.ejerform || "ukendt"}. Afstem om virksomheden beskattes som selskab eller personlig virksomhed, og kontroller fradrag efter udgiftstype.`,
    "",
    "**3. BRANCHESPECIFIKKE RISICI**",
    ...riskHints.map(item => `- ${item}`),
    "",
    "**4. TOP ANBEFALINGER**",
    "- Afstem salgsmoms og k\u00f8bsmoms mod saldobalance og momsangivelse.",
    "- Kontroller konti for biler, rejser, restaurant, gaver og repr\u00e6sentation.",
    "- Gennemg\u00e5 EU-k\u00f8b og EU-salg for korrekt reverse charge.",
    "",
    "Bem\u00e6rk: Dette er fallback-analyse uden AI, fordi ANTHROPIC_API_KEY ikke er sat."
  ].join("\n");
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  const user = requireAuth(req, res);
  if (!user) return;

  // 10 virksomhedsanalyser pr. time pr. bruger.
  if (!(await enforceRateLimit(req, res, { name: "analyze-company", key: user.email, max: 10, windowSeconds: 3600 }))) return;

  try {
    const body = await readJson(req);
    const virksomhed = body.virksomhed || body.company || {};

    if (!process.env.ANTHROPIC_API_KEY) {
      return sendJson(res, 200, { ok: true, format: "tekst", analyse: buildFallbackAnalysis(virksomhed), fallback: true });
    }

    const ansatteStr = virksomhed.ansatte !== undefined ? String(virksomhed.ansatte) : "ukendt";
    const data = "VIRKSOMHEDSDATA FRA CVR:\n"
      + "- Navn: " + sanitizeText(virksomhed.navn, 200) + "\n"
      + "- CVR: " + sanitizeText(virksomhed.cvr, 20) + "\n"
      + "- Status: " + sanitizeText(virksomhed.status, 80) + "\n"
      + "- Branche: " + sanitizeText(virksomhed.branche, 200) + " (kode: " + sanitizeText(virksomhed.brancheKode, 80) + ")\n"
      + "- Adresse: " + sanitizeText(virksomhed.adresse, 200) + "\n"
      + "- Antal ansatte: " + sanitizeText(ansatteStr, 80) + "\n"
      + "- Stiftet: " + sanitizeText(virksomhed.stiftet, 80) + "\n"
      + "- Ejerform: " + sanitizeText(virksomhed.ejerform, 120);

    const svar = await callAnthropic({
      system: [
        { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
        { type: "text", text: "Du laver branchebaserede compliance-vurderinger og svarer udelukkende med gyldig JSON efter brugerens skema." }
      ],
      messages: [{ role: "user", content: data + "\n\n" + OPGAVE }],
      maxTokens: 3000
    });

    const rapport = normalizeRapport(parseJsonLoose(svar));
    if (rapport) {
      return sendJson(res, 200, { ok: true, format: "struktureret", rapport });
    }
    return sendJson(res, 200, { ok: true, format: "tekst", analyse: svar || "Analyse ikke tilg\u00e6ngelig." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "AI-analysen fejlede." });
  }
};
