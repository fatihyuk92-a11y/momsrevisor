const { callAnthropic, methodGuard, readJson, requireAuth, sanitizeText, sendJson } = require("../_utils");

function buildFallbackAnalysis(company) {
  const branche = String(company.branche || "").toLowerCase();
  const riskHints = [];

  if (/restaurant|cafe|hotel|event|underholdning|repræsentation/.test(branche)) {
    riskHints.push("Restaurations- og repræsentationsudgifter bør kontrolleres særskilt, fordi moms- og skattefradrag ofte ikke følger samme logik.");
  }
  if (/byg|håndværk|entreprenør|installation|anlæg/.test(branche)) {
    riskHints.push("Bygge- og installationsvirksomheder bør kontrolleres for omvendt betalingspligt, underentreprenører og korrekt fakturakrav.");
  }
  if (/handel|webshop|detail|engros/.test(branche)) {
    riskHints.push("Handelsvirksomheder bør kontrolleres for EU-køb, importmoms, lagerafstemning og salg til udlandet.");
  }
  if (/rådgiv|konsulent|it|software/.test(branche)) {
    riskHints.push("Rådgivnings- og IT-virksomheder bør kontrolleres for EU-salg, reverse charge og periodisering af abonnementer.");
  }

  if (!riskHints.length) {
    riskHints.push("Der bør laves en generel kontrol af momskoder, fradragsbegrænsede udgifter, EU-transaktioner og periodisering.");
  }

  return [
    "**1. MOMSSTATUS**",
    `Virksomheden ${company.navn || "Ukendt virksomhed"} (CVR ${company.cvr || "ukendt"}) bør vurderes ud fra branche, aktivitet og omsætning. CVR-opslaget viser branche: ${company.branche || "ukendt"}.`,
    "",
    "**2. SKATTEMÆSSIG STATUS**",
    `Ejerform er registreret som ${company.ejerform || "ukendt"}. Afstem om virksomheden beskattes som selskab eller personlig virksomhed, og kontroller fradrag efter udgiftstype.`,
    "",
    "**3. BRANCHESPECIFIKKE RISICI**",
    ...riskHints.map(item => `- ${item}`),
    "",
    "**4. SAMSPIL MOMS/SKAT**",
    "- Repræsentation, biler, personalegoder, gaver og etableringsomkostninger bør markeres særskilt, fordi momsfradrag og skattefradrag kan være forskellige.",
    "",
    "**5. TOP 5 ANBEFALINGER**",
    "- Afstem salgsmoms og købsmoms mod saldobalance og momsangivelse.",
    "- Kontroller konti for biler, rejser, restaurant, gaver og repræsentation.",
    "- Gennemgå EU-køb og EU-salg for korrekt reverse charge.",
    "- Kontroller store posteringer uden moms eller med usædvanlig momskode.",
    "- Gem dokumentation med bilag, kontonummer, beløb og beslutning.",
    "",
    "Bemærk: Dette er fallback-analyse uden AI, fordi ANTHROPIC_API_KEY ikke er sat."
  ].join("\n");
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const virksomhed = body.virksomhed || body.company || {};

    if (!process.env.ANTHROPIC_API_KEY) {
      return sendJson(res, 200, { ok: true, analyse: buildFallbackAnalysis(virksomhed), fallback: true });
    }

    const ansatteStr = virksomhed.ansatte !== undefined ? String(virksomhed.ansatte) : "ukendt";
    const prompt = "Du er en erfaren dansk moms- og skatterådgiver. Analysér følgende virksomhed og giv en konkret compliance-vurdering for BÅDE moms og skat.\n\n"
      + "VIRKSOMHEDSDATA FRA CVR:\n"
      + "- Navn: " + sanitizeText(virksomhed.navn, 200) + "\n"
      + "- CVR: " + sanitizeText(virksomhed.cvr, 20) + "\n"
      + "- Status: " + sanitizeText(virksomhed.status, 80) + "\n"
      + "- Branche: " + sanitizeText(virksomhed.branche, 200) + " (kode: " + sanitizeText(virksomhed.brancheKode, 80) + ")\n"
      + "- Adresse: " + sanitizeText(virksomhed.adresse, 200) + "\n"
      + "- Antal ansatte: " + sanitizeText(ansatteStr, 80) + "\n"
      + "- Stiftet: " + sanitizeText(virksomhed.stiftet, 80) + "\n"
      + "- Ejerform: " + sanitizeText(virksomhed.ejerform, 120) + "\n\n"
      + "Giv en struktureret compliance-analyse med disse 6 afsnit:\n\n"
      + "1. MOMSSTATUS - Er virksomheden momspligtig, momsfritaget eller blandet? Sandsynlig momsperiode? Lønsumsafgiftspligt? (ML § 13, LSAL)\n\n"
      + "2. SKATTEMÆSSIG STATUS - Selskab eller personlig virksomhed? Relevant beskatningsform (SEL, PSL, VSL)? Skattepligtig indkomst og relevante fradrag?\n\n"
      + "3. BRANCHESPECIFIKKE RISICI (moms) - Typiske momsfejl i denne branche? Fradragsbegrænsninger, reverse charge, fast ejendom osv.\n\n"
      + "4. BRANCHESPECIFIKKE RISICI (skat) - Typiske skattemæssige fejl? Afskrivninger, personalegoder (LL § 16), repræsentation (LL § 8), transfer pricing osv.\n\n"
      + "5. SAMSPIL MOMS/SKAT - Hvor er der asymmetri? Hvad giver fradrag i moms men ikke skat eller omvendt?\n\n"
      + "6. TOP 5 ANBEFALINGER - De vigtigste konkrete handlinger med lovhenvisninger (ML §, LL §, SEL §).\n\n"
      + "Vær konkret, men gør tydeligt hvad der er en risikovurdering og ikke et verificeret fund.";

    const analyse = await callAnthropic({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1200
    });

    return sendJson(res, 200, { ok: true, analyse });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "AI-analysen fejlede." });
  }
};
