const { callAnthropic, enforceRateLimit, methodGuard, normalizeRapport, parseJsonLoose, readJson, requireAuth, sanitizeText, sendJson } = require("../_utils");
const KNOWLEDGE = require("../_knowledge");
const { beregnMomsAfstemning, afstemningTilPromptBlok } = require("./_afstemning");

// Klienten sender RAA data - serveren ejer hele prompten:
// { filer: [{ navn, type, tekst? , pdfBase64? }], virksomhed?: {...} }
// Det forhindrer prompt-manipulation og sikrer ens analysekvalitet.

const MAX_PDF_BASE64 = 3_000_000;   // ~2,2 MB binaert pr. PDF
const MAX_TOTAL_CHARS = 3_600_000;  // samlet payload-vaern (Vercel-graense ~4,5 MB)

const OPGAVE = `OPGAVE
Du er compliance-motoren i MomsRevisor. Analyser det vedlagte regnskabsmateriale for en dansk virksomhed og find konkrete moms- og skattefejl samt risici. Brug vidensbasen ovenfor som retskilde og henvis praecist (ML \u00a7, MB \u00a7, LL \u00a7, SEL \u00a7, AL \u00a7).

REGLER FOR FUND
- Citer KUN kontonumre, beloeb, datoer og bilagsnumre der staar direkte i materialet. Kan du ikke se dem, lad feltet vaere tom streng "".
- Saet "grundlag" til "observeret" KUN naar fejlen kan ses direkte i materialet. Brancherisici og formodninger er "risikovurdering".
- Opfind ALDRIG tal, konti eller transaktioner. Faa sikre fund er bedre end mange usikre.
- Er materialet ulaeseligt eller uden relevant indhold: returner tom "fund"-liste og forklar hvorfor i "forbehold".
- Marker afkortet materiale i "datagrundlag" hvis du kan se [AFKORTET]-markoerer.

SVARFORMAT
Svar med PRAECIS et gyldigt JSON-objekt. Ingen markdown, ingen \`\`\`-hegn, ingen tekst foer eller efter.
{
 "resume": "2-3 saetninger: hvad materialet er, og hovedkonklusionen",
 "datagrundlag": "Hvilke filer/ark/perioder kunne laeses, og hvad de indeholder",
 "fund": [{"kategori":"moms"|"skat"|"samspil","alvor":"kritisk"|"hoej"|"mellem"|"lav","grundlag":"observeret"|"risikovurdering","titel":"kort overskrift","evidens":"hvad i materialet viser det - citer konto/tekst/beloeb naar synligt","konto":"","beloeb":"","handling":"konkret naeste skridt","lov":"fx ML \u00a7 42, stk. 1"}],
 "anbefalinger": [{"prioritet":1,"tekst":"vigtigste handling foerst","lov":""}],
 "forbehold": "Hvad analysen ikke daekker, og hvad der mangler for fuld vurdering"
}
- Maks 12 fund, sorteret efter alvor. 3-6 anbefalinger.
- "kritisk" = sandsynlig efterbetaling eller boede. "hoej" = skal undersoeges nu. Brug "lav" sparsomt.`;

function collectText(filer) {
  return filer.map(f => f.tekst || "").join("\n\n").slice(0, 24000);
}

function ruleBasedFallback(filer) {
  const lower = collectText(filer).toLowerCase();
  const findings = [];
  const add = (level, title, evidence, action) => findings.push({ level, title, evidence, action });

  if (/repr\u00e6sentation|restaurant|restauration|frokost|middag|cafe|gave/.test(lower)) {
    add("H\u00f8j", "Repr\u00e6sentation eller gaver kr\u00e6ver s\u00e6rskilt kontrol",
      "Materialet indeholder ord som restaurant, cafe, frokost, gave eller repr\u00e6sentation.",
      "Kontroller momsfradrag, skattefradrag og dokumentation for form\u00e5l/deltagere.");
  }
  if (/personbil|varebil|leasing|br\u00e6ndstof|benz|diesel|parkering|brobizz/.test(lower)) {
    add("H\u00f8j", "Biler og transport kan have begr\u00e6nset momsfradrag",
      "Materialet indeholder bil-, leasing-, br\u00e6ndstof- eller parkeringsposter.",
      "Split personbil/varebil, privat/erhverv og kontroller moms- og skattem\u00e6ssig behandling.");
  }
  if (/eu-k\u00f8b|eu k\u00f8b|reverse charge|omvendt betalingspligt|udland|importmoms|import moms/.test(lower)) {
    add("H\u00f8j", "EU/import og reverse charge b\u00f8r afstemmes",
      "Materialet indikerer EU, udland, import eller omvendt betalingspligt.",
      "Afstem erhvervelsesmoms, salgsmoms/k\u00f8bsmoms og rubrikker p\u00e5 momsangivelsen.");
  }
  if (/uden moms|moms 0|0 ?% moms|momskode.?0/.test(lower)) {
    add("Mellem", "Poster uden moms b\u00f8r forklares",
      "Materialet indeholder poster uden moms eller momskode 0.",
      "Kontroller om posteringen er momsfri, ikke-fradragsberettiget, reverse charge eller fejlkonteret.");
  }
  if (/kreditnota|kreditering|refund|tilbagef\u00f8rt/.test(lower)) {
    add("Mellem", "Kreditnotaer b\u00f8r matches mod oprindelig faktura",
      "Materialet indeholder kreditnota eller tilbagef\u00f8rsel.",
      "Kontroller periode, momskorrektion og match til oprindeligt bilag.");
  }
  if (!findings.length) {
    add("Lav", "Ingen tydelige h\u00f8jrisikoord fundet i tekstudtr\u00e6k",
      "Fallback-motoren fandt ikke de mest almindelige momsrisikosignaler.",
      "K\u00f8r AI-analyse med ANTHROPIC_API_KEY og sammenhold med saldobalance/momsangivelse.");
  }

  return [
    "**KRITISKE MOMSFEJL**",
    ...findings.filter(f => f.level === "H\u00f8j").map(f => `- ${f.title}: ${f.evidence} Handling: ${f.action}`),
    findings.some(f => f.level === "H\u00f8j") ? "" : "- Ingen kritiske fallback-fund.",
    "",
    "**ANBEFALINGER**",
    ...findings.map(f => `- [${f.level}] ${f.action}`),
    "",
    "Bem\u00e6rk: Dette er fallback-analyse uden AI, fordi ANTHROPIC_API_KEY ikke er sat."
  ].join("\n");
}

function sanitizeFiler(rawFiler) {
  return (Array.isArray(rawFiler) ? rawFiler : []).slice(0, 8).map(f => {
    const navn = sanitizeText(f?.navn || "fil", 120);
    if (f?.pdfBase64) {
      return {
        navn,
        pdfBase64: String(f.pdfBase64).replace(/[^A-Za-z0-9+/=]/g, "").slice(0, MAX_PDF_BASE64)
      };
    }
    return { navn, tekst: sanitizeText(f?.tekst || "", 18000) };
  }).filter(f => f.pdfBase64 || f.tekst);
}

function buildVirksomhedLinje(v) {
  if (!v || typeof v !== "object") return "Virksomhed: ukendt (intet CVR-opslag).";
  return "Virksomhed: " + sanitizeText(v.navn, 200)
    + " | CVR: " + sanitizeText(v.cvr, 20)
    + " | Branche: " + sanitizeText(v.branche, 200)
    + " | Ejerform: " + sanitizeText(v.ejerform, 120)
    + " | Status: " + sanitizeText(v.status, 80);
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  const user = requireAuth(req, res);
  if (!user) return;

  // 6 filanalyser pr. time pr. bruger - det er de dyreste kald.
  if (!(await enforceRateLimit(req, res, { name: "analyze-files", key: user.email, max: 6, windowSeconds: 3600 }))) return;

  try {
    const body = await readJson(req);
    const filer = sanitizeFiler(body.filer);
    if (!filer.length) {
      return sendJson(res, 400, { ok: false, fejl: "Der mangler regnskabsmateriale." });
    }

    const totalChars = filer.reduce((sum, f) => sum + (f.pdfBase64?.length || 0) + (f.tekst?.length || 0), 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      return sendJson(res, 413, { ok: false, fejl: "Materialet fylder for meget i et enkelt kald. Analyser f\u00e6rre filer ad gangen, eller del store PDF'er op." });
    }

    // Deterministisk afstemning af talkolonner (CSV/Excel) - koerer ALTID,
    // ogsaa uden AI-noegle, og fodrer AI'en med verificerede tal.
    const afstemning = beregnMomsAfstemning(filer);

    if (!process.env.ANTHROPIC_API_KEY) {
      if (afstemning) {
        return sendJson(res, 200, {
          ok: true, format: "struktureret", fallback: true,
          rapport: {
            resume: "Maskinel momsafstemning af " + afstemning.parsedeLinjer + " parsede raekker. AI-analysen er ikke aktiv (ANTHROPIC_API_KEY mangler), saa kun de deterministiske kontroller vises.",
            datagrundlag: "Talkolonner fra det uploadede materiale, automatisk fortolket ud fra kontonavne.",
            momsprofil: "", skatteprofil: "",
            fund: afstemning.fund,
            anbefalinger: afstemning.fund.slice(0, 5).map((f, i) => ({ prioritet: i + 1, tekst: f.handling, lov: f.lov })),
            forbehold: "Uden AI daekkes kun de beregnelige kontroller (salgsmoms-afstemning, EU-koeb, fradragsbegraensede konti).",
            noegletal: afstemning.noegletal
          }
        });
      }
      return sendJson(res, 200, { ok: true, format: "tekst", analyse: ruleBasedFallback(filer), fallback: true });
    }

    const content = [];
    for (const f of filer) {
      if (f.pdfBase64) {
        content.push({
          type: "document",
          title: f.navn,
          source: { type: "base64", media_type: "application/pdf", data: f.pdfBase64 }
        });
      } else {
        content.push({ type: "text", text: "FILINDHOLD (" + f.navn + "):\n" + f.tekst });
      }
    }
    const afstemningsBlok = afstemning ? afstemningTilPromptBlok(afstemning) + "\n\n" : "";
    content.push({ type: "text", text: buildVirksomhedLinje(body.virksomhed) + "\n\n" + afstemningsBlok + OPGAVE });

    const svar = await callAnthropic({
      system: [
        { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
        { type: "text", text: "Du analyserer regnskabsmateriale og svarer udelukkende med gyldig JSON efter brugerens skema." }
      ],
      messages: [{ role: "user", content }],
      maxTokens: 3500
    });

    const rapport = normalizeRapport(parseJsonLoose(svar));
    if (rapport) {
      if (afstemning) {
        // Deterministiske fund foerst (de er verificerede), AI-fund efter.
        // Drop AI-dubletter af salgsmoms-afstemningen og EU-kontrollen.
        const detTitler = afstemning.fund.map(f => f.titel.toLowerCase());
        const erDublet = f => {
          const t = (f.titel + " " + f.evidens).toLowerCase();
          return (detTitler.some(d => d.includes("salgsmoms")) && /salgsmoms/.test(t) && /(afvig|lavere|h\u00f8jere|forventet|25\s?%)/.test(t))
            || (detTitler.some(d => d.includes("erhvervelsesmoms")) && /erhvervelsesmoms|omvendt betalingspligt/.test(t) && /eu|udland/.test(t));
        };
        rapport.fund = [...afstemning.fund, ...rapport.fund.filter(f => !erDublet(f))].slice(0, 20);
        rapport.noegletal = afstemning.noegletal;
      }
      return sendJson(res, 200, { ok: true, format: "struktureret", rapport });
    }
    // Modellen fulgte ikke skemaet - vis raa tekst frem for at fejle.
    return sendJson(res, 200, { ok: true, format: "tekst", analyse: svar || "Analyse ikke tilg\u00e6ngelig." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "Filanalysen fejlede." });
  }
};
