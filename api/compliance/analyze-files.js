const { callAnthropic, methodGuard, readJson, requireAuth, sanitizeText, sendJson } = require("../_utils");

function collectText(content) {
  return (Array.isArray(content) ? content : [])
    .filter(part => part && part.type === "text")
    .map(part => part.text || "")
    .join("\n\n")
    .slice(0, 24000);
}

function ruleBasedFallback(content) {
  const text = collectText(content);
  const lower = text.toLowerCase();
  const findings = [];

  function add(level, title, evidence, action) {
    findings.push({ level, title, evidence, action });
  }

  if (/repræsentation|restaurant|restauration|frokost|middag|cafe|gave/.test(lower)) {
    add(
      "Høj",
      "Repræsentation eller gaver kræver særskilt kontrol",
      "Materialet indeholder ord som restaurant, cafe, frokost, gave eller repræsentation.",
      "Kontroller momsfradrag, skattefradrag og dokumentation for formål/deltagere."
    );
  }

  if (/personbil|varebil|leasing|brændstof|benz|diesel|parkering|brobizz/.test(lower)) {
    add(
      "Høj",
      "Biler og transport kan have begrænset momsfradrag",
      "Materialet indeholder bil-, leasing-, brændstof- eller parkeringsposter.",
      "Split personbil/varebil, privat/erhverv og kontroller moms- og skattemæssig behandling."
    );
  }

  if (/eu-køb|eu køb|reverse charge|omvendt betalingspligt|udland|importmoms|import moms/.test(lower)) {
    add(
      "Høj",
      "EU/import og reverse charge bør afstemmes",
      "Materialet indikerer EU, udland, import eller omvendt betalingspligt.",
      "Afstem erhvervelsesmoms, salgsmoms/købsmoms og rubrikker på momsangivelsen."
    );
  }

  if (/uden moms|moms 0|0 ?% moms|momskode.?0/.test(lower)) {
    add(
      "Mellem",
      "Poster uden moms bør forklares",
      "Materialet indeholder poster uden moms eller momskode 0.",
      "Kontroller om posteringen er momsfri, ikke-fradragsberettiget, reverse charge eller fejlkonteret."
    );
  }

  if (/kreditnota|kreditering|refund|tilbageført/.test(lower)) {
    add(
      "Mellem",
      "Kreditnotaer bør matches mod oprindelig faktura",
      "Materialet indeholder kreditnota eller tilbageførsel.",
      "Kontroller periode, momskorrektion og match til oprindeligt bilag."
    );
  }

  if (!findings.length) {
    add(
      "Lav",
      "Ingen tydelige højrisikoord fundet i tekstudtræk",
      "Fallback-motoren fandt ikke de mest almindelige momsrisikosignaler.",
      "Kør AI-analyse med ANTHROPIC_API_KEY og sammenhold med saldobalance/momsangivelse."
    );
  }

  return [
    "**KRITISKE MOMSFEJL**",
    ...findings.filter(f => f.level === "Høj").map(f => `- ${f.title}: ${f.evidence} Handling: ${f.action}`),
    findings.some(f => f.level === "Høj") ? "" : "- Ingen kritiske fallback-fund.",
    "",
    "**KRITISKE SKATTEFEJL**",
    "- Kontroller skattefradrag for repræsentation, biler, personalegoder, gaver og afskrivninger manuelt.",
    "",
    "**ASYMMETRI MOMS/SKAT**",
    "- Poster kan være delvist fradragsberettigede skattemæssigt, men ikke momsmæssigt, eller omvendt. Marker især biler, restaurant, gaver og personaleudgifter.",
    "",
    "**ANBEFALINGER**",
    ...findings.map(f => `- [${f.level}] ${f.action}`),
    "",
    "**LOVHENVISNINGER**",
    "- Brug som minimum ML fakturakrav/fradragsregler, ML § 13 ved momsfritagelser, LL § 8 ved repræsentation, LL § 16 ved personalegoder og AL ved afskrivninger.",
    "",
    "Bemærk: Dette er fallback-analyse uden AI, fordi ANTHROPIC_API_KEY ikke er sat."
  ].join("\n");
}

function sanitizeContent(content) {
  return (Array.isArray(content) ? content : []).slice(0, 8).map(part => {
    if (part?.type === "document" && part.source?.type === "base64") {
      return {
        type: "document",
        title: sanitizeText(part.title || "regnskabsmateriale.pdf", 120),
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: String(part.source.data || "").replace(/[^A-Za-z0-9+/=]/g, "").slice(0, 5_500_000)
        }
      };
    }

    return {
      type: "text",
      text: sanitizeText(part?.text || "", 18000)
    };
  }).filter(part => part.type === "document" || part.text);
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const safeContent = sanitizeContent(body.content);
    if (!safeContent.length) {
      return sendJson(res, 400, { ok: false, fejl: "Der mangler regnskabsmateriale." });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return sendJson(res, 200, { ok: true, analyse: ruleBasedFallback(safeContent), fallback: true });
    }

    const prompt = {
      type: "text",
      text: "Du er en erfaren dansk moms- og skatterådgiver. Analyser ovenstående regnskabsmateriale og identificer konkrete fejl og risici inden for BÅDE moms og skat.\n\n"
        + "Strukturér analysen præcist:\n\n"
        + "KRITISKE MOMSFEJL - Fejl der giver efterbetaling/bøde. Angiv konto, postering, beløb og kilde hvis synligt.\n\n"
        + "KRITISKE SKATTEFEJL - Fejl i skattemæssige fradrag, afskrivninger, personalegoder mv.\n\n"
        + "ASYMMETRI MOMS/SKAT - Poster der behandles forskelligt moms- og skattemæssigt, fx repræsentation, biler, personalegoder og etableringsomkostninger.\n\n"
        + "ANBEFALINGER - Konkrete handlinger prioriteret efter risiko.\n\n"
        + "LOVHENVISNINGER - Relevante ML §, MB §, LL §, SEL §, AL § for fundne fejl.\n\n"
        + "Vær præcis. Opfind ikke konti eller beløb. Hvis materialet ikke viser beløb, så skriv at beløbet ikke fremgår."
    };

    const analyse = await callAnthropic({
      messages: [{ role: "user", content: [...safeContent, prompt] }],
      maxTokens: 1500
    });

    return sendJson(res, 200, { ok: true, analyse });
  } catch (error) {
    return sendJson(res, 500, { ok: false, fejl: error.message || "Filanalysen fejlede." });
  }
};
