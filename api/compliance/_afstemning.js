// Deterministisk momsafstemning - ren kode, ingen AI.
// Parser talkolonner fra CSV/Excel-udtraek, genkender momsrelevante konti
// paa kontonavne, og beregner de kontroller der ER matematik:
//   - Forventet salgsmoms (25% af momspligtig omsaetning) vs. bogfoert salgsmoms
//   - EU-/udlandskoeb vs. erhvervelsesmoms (omvendt betalingspligt)
//   - Observerede beloeb paa fradragsbegraensede konti (restauration, repraesentation)
// Resultatet bruges to steder: som verificerede tal til AI-prompten, og som
// automatiske fund der indsaettes direkte i rapporten.

const TOLERANCE_KR = 500;
const TOLERANCE_PCT = 0.02;

function parseBeloeb(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/kr\.?/gi, "").replace(/dkk/gi, "").replace(/\u00a0/g, "").replace(/\s/g, "");
  if (s.startsWith("-")) { neg = !neg ? true : neg; s = s.slice(1); }
  if (!s || /%$/.test(s)) return null;
  // Dansk format: punktum = tusindtal, komma = decimal
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // "1.234" eller "1.234.567" = tusindtalspunktummer; "1234.56" = decimalpunktum
    const dele = s.split(".");
    if (dele.length > 2 || (dele.length === 2 && dele[1].length === 3)) s = dele.join("");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

function findDelimiter(linjer) {
  const kandidater = [";", "\t", ","];
  let bedst = ";", maxScore = -1;
  for (const d of kandidater) {
    const score = linjer.slice(0, 8).reduce((sum, l) => sum + l.split(d).length - 1, 0);
    if (score > maxScore) { maxScore = score; bedst = d; }
  }
  return bedst;
}

const KLASSER = [
  { type: "salgsmoms",        re: /salgsmoms|udg\u00e5ende moms|udg\.? ?moms|moms af salg/ },
  { type: "koebsmoms",        re: /k\u00f8bsmoms|indg\u00e5ende moms|indg\.? ?moms|moms af k\u00f8b(?! .*udland)/ },
  { type: "erhvervelsesmoms", re: /erhvervelsesmoms|importmoms|moms af (vare)?k\u00f8b i udland|moms .*udland|eu-?moms/ },
  { type: "euKoeb",           re: /(vare)?k\u00f8b .*(eu|udland)|^import(?!moms)|udenlandske? (vare)?k\u00f8b|ydelsesk\u00f8b .*udland/ },
  { type: "momsfriOms",       re: /(oms\u00e6tning|salg|eksport).*?(eu|eksport|udland|momsfri|uden moms)|^eksport/ },
  { type: "omsaetning",       re: /^oms\u00e6tning|varesalg|salg af (varer|ydelser)|honorarindt\u00e6gt|konsulentydelser|^salg(?! .*moms)/ },
  { type: "restauration",     re: /restaurant|restauration|caf\u00e9|bev\u00e6rtning/ },
  { type: "repraesentation",  re: /repr\u00e6sentation/ }
];

function klassificer(navn) {
  const n = navn.toLowerCase();
  for (const k of KLASSER) if (k.re.test(n)) return k.type;
  return null;
}

const HEADER_ORD = /konto|navn|tekst|saldo|bel\u00f8b|debet|kredit|prim|ultimo|periode/i;

function parseFil(tekst) {
  const raaLinjer = String(tekst || "").split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim() && !l.startsWith("ARK:") && !l.includes("[AFKORTET]"));
  if (raaLinjer.length < 3) return [];
  const delim = findDelimiter(raaLinjer);
  let idxDebet = -1, idxKredit = -1;
  const raekker = [];

  for (const linje of raaLinjer) {
    const felter = linje.split(delim).map(f => f.trim().replace(/^"|"$/g, ""));
    const lavt = felter.map(f => f.toLowerCase());

    // Headerlinje: husk evt. debet/kredit-kolonner, parse ikke som data
    if (lavt.some(f => HEADER_ORD.test(f)) && !felter.some(f => parseBeloeb(f) !== null && Math.abs(parseBeloeb(f)) > 0)) {
      idxDebet = lavt.findIndex(f => /debet/.test(f));
      idxKredit = lavt.findIndex(f => /kredit/.test(f));
      continue;
    }

    let konto = "";
    let navn = "";
    for (const f of felter) {
      if (!konto && /^\d{3,6}$/.test(f)) { konto = f; continue; }
      if (!navn && /[a-z\u00e6\u00f8\u00e5]{3,}/i.test(f) && !/^\d/.test(f)) navn = f;
    }
    if (!navn) continue;

    let beloeb = null;
    if (idxDebet >= 0 && idxKredit >= 0) {
      const d = parseBeloeb(felter[idxDebet]);
      const k = parseBeloeb(felter[idxKredit]);
      if (d !== null || k !== null) beloeb = (d || 0) - (k || 0);
    }
    if (beloeb === null) {
      for (let i = felter.length - 1; i >= 0; i--) {
        if (felter[i] === konto) continue;
        const v = parseBeloeb(felter[i]);
        if (v !== null) { beloeb = v; break; }
      }
    }
    if (beloeb === null) continue;
    raekker.push({ konto, navn, beloeb, type: klassificer(navn) });
  }
  return raekker;
}

function kr(v) {
  return new Intl.NumberFormat("da-DK").format(Math.round(v)) + " kr.";
}

function beregnMomsAfstemning(filer) {
  const raekker = [];
  for (const f of filer || []) {
    if (f && f.tekst) raekker.push(...parseFil(f.tekst));
  }
  if (raekker.length < 5) return null;

  const sum = type => raekker.filter(r => r.type === type).reduce((s, r) => s + r.beloeb, 0);
  const konti = type => [...new Set(raekker.filter(r => r.type === type && r.konto).map(r => r.konto))].join(", ");
  const har = type => raekker.some(r => r.type === type);

  // Mindst salgsmoms- eller koebsmoms-konto skal findes, ellers er materialet
  // naeppe en saldobalance/kontooversigt - lad AI'en arbejde alene.
  if (!har("salgsmoms") && !har("koebsmoms")) return null;

  // Omsaetning og salgsmoms staar typisk i kredit (negativt) - brug absolutvaerdier
  const momspligtigOms = Math.abs(sum("omsaetning"));
  const momsfriOms = Math.abs(sum("momsfriOms"));
  const salgsBogfoert = Math.abs(sum("salgsmoms"));
  const koebsmoms = Math.abs(sum("koebsmoms"));
  const erhvervelses = Math.abs(sum("erhvervelsesmoms"));
  const euKoeb = Math.abs(sum("euKoeb"));
  const restauration = Math.abs(sum("restauration"));
  const repraesentation = Math.abs(sum("repraesentation"));

  const fund = [];
  const noegletal = {
    momspligtigOmsaetning: har("omsaetning") ? Math.round(momspligtigOms) : null,
    momsfriOmsaetning: har("momsfriOms") ? Math.round(momsfriOms) : null,
    salgsmomsBogfoert: har("salgsmoms") ? Math.round(salgsBogfoert) : null,
    salgsmomsForventet: null,
    salgsmomsAfvigelse: null,
    koebsmoms: har("koebsmoms") ? Math.round(koebsmoms) : null,
    erhvervelsesmoms: har("erhvervelsesmoms") ? Math.round(erhvervelses) : null,
    euKoeb: har("euKoeb") ? Math.round(euKoeb) : null
  };

  // ── Kontrol 1: salgsmoms vs. 25% af momspligtig omsaetning ──
  if (har("omsaetning") && har("salgsmoms") && momspligtigOms > 0) {
    const forventet = momspligtigOms * 0.25;
    const afvigelse = salgsBogfoert - forventet;
    noegletal.salgsmomsForventet = Math.round(forventet);
    noegletal.salgsmomsAfvigelse = Math.round(afvigelse);
    const tolerance = Math.max(TOLERANCE_KR, forventet * TOLERANCE_PCT);
    if (Math.abs(afvigelse) > tolerance) {
      if (afvigelse < 0) {
        fund.push({
          kategori: "moms", alvor: "kritisk", grundlag: "observeret",
          titel: "Bogf\u00f8rt salgsmoms er " + kr(Math.abs(afvigelse)) + " lavere end 25% af den momspligtige oms\u00e6tning",
          evidens: "Momspligtig oms\u00e6tning " + kr(momspligtigOms) + " giver forventet salgsmoms " + kr(forventet) + ", men der er kun bogf\u00f8rt " + kr(salgsBogfoert) + ". Beregnet maskinelt ud fra talkolonnerne.",
          konto: konti("salgsmoms"), beloeb: kr(Math.abs(afvigelse)),
          handling: "Afstem momskoderne p\u00e5 oms\u00e6tningskontiene: er momsfrit salg konteret som momspligtigt, mangler der angivet salgsmoms, eller er perioderne forskudt? Difference af denne st\u00f8rrelse giver typisk efterbetaling.",
          lov: "ML \u00a7 4 og \u00a7 27"
        });
      } else {
        fund.push({
          kategori: "moms", alvor: "hoej", grundlag: "observeret",
          titel: "Bogf\u00f8rt salgsmoms er " + kr(afvigelse) + " h\u00f8jere end 25% af den momspligtige oms\u00e6tning",
          evidens: "Momspligtig oms\u00e6tning " + kr(momspligtigOms) + " giver forventet salgsmoms " + kr(forventet) + ", men der er bogf\u00f8rt " + kr(salgsBogfoert) + ". Beregnet maskinelt ud fra talkolonnerne.",
          konto: konti("salgsmoms"), beloeb: kr(afvigelse),
          handling: "Kontroller om momsfri/eksport-oms\u00e6tning er bogf\u00f8rt uden tilh\u00f8rende oms\u00e6tningskonto, om der er efterposteringer, eller om en del af oms\u00e6tningen mangler i materialet.",
          lov: "ML \u00a7 4 og \u00a7 34"
        });
      }
    }
  }

  // ── Kontrol 2: EU-/udlandskoeb uden erhvervelsesmoms ──
  if (euKoeb > 1000 && erhvervelses < euKoeb * 0.05) {
    fund.push({
      kategori: "moms", alvor: "kritisk", grundlag: "observeret",
      titel: "EU-/udlandsk\u00f8b p\u00e5 " + kr(euKoeb) + " uden tilsvarende erhvervelsesmoms",
      evidens: "Der er bogf\u00f8rt k\u00f8b i udlandet for " + kr(euKoeb) + (har("erhvervelsesmoms") ? ", men kun " + kr(erhvervelses) + " i erhvervelses-/importmoms." : ", men ingen erhvervelses-/importmomskonto blev fundet i materialet.") + " Beregnet maskinelt.",
      konto: konti("euKoeb"), beloeb: kr(euKoeb),
      handling: "Beregn og bogf\u00f8r erhvervelsesmoms (omvendt betalingspligt) af EU-k\u00f8bene og angiv bel\u00f8bet i rubrik A. Husk samtidig fradrag som k\u00f8bsmoms i samme omfang som ved danske k\u00f8b.",
      lov: "ML \u00a7 11 og \u00a7 46"
    });
  }

  // ── Kontrol 3: fradragsbegraensede konti med observerede beloeb ──
  if (restauration > 0) {
    fund.push({
      kategori: "samspil", alvor: "mellem", grundlag: "observeret",
      titel: "Restaurationsudgifter p\u00e5 " + kr(restauration) + " \u2014 kun 25% af momsen kan fratr\u00e6kkes",
      evidens: "Konto for restauration/bev\u00e6rtning viser " + kr(restauration) + " i materialet.",
      konto: konti("restauration"), beloeb: kr(restauration),
      handling: "Kontroller at der maksimalt er taget 25% momsfradrag af restaurationsmomsen (strengt erhvervsm\u00e6ssigt form\u00e5l), og at det skattem\u00e6ssige fradrag f\u00f8lger reglerne for repr\u00e6sentation/personale.",
      lov: "ML \u00a7 42, stk. 2; LL \u00a7 8, stk. 4"
    });
  }
  if (repraesentation > 0) {
    fund.push({
      kategori: "samspil", alvor: "mellem", grundlag: "observeret",
      titel: "Repr\u00e6sentation p\u00e5 " + kr(repraesentation) + " \u2014 momsfradrag som udgangspunkt udelukket",
      evidens: "Konto for repr\u00e6sentation viser " + kr(repraesentation) + " i materialet.",
      konto: konti("repraesentation"), beloeb: kr(repraesentation),
      handling: "Kontroller at der ikke er taget momsfradrag p\u00e5 repr\u00e6sentation (undtagen 25% ved restauration), og at der skattem\u00e6ssigt kun er fratrukket 25% af udgiften.",
      lov: "ML \u00a7 42, stk. 1, nr. 5; LL \u00a7 8, stk. 4"
    });
  }

  return {
    noegletal,
    fund,
    parsedeLinjer: raekker.length,
    kontiFundet: KLASSER.map(k => k.type).filter(t => har(t)).map(t => ({ type: t, konti: konti(t) }))
  };
}

function afstemningTilPromptBlok(a) {
  if (!a) return "";
  const n = a.noegletal;
  const kv = (label, v) => v == null ? null : label + ": " + kr(v);
  const linjer = [
    kv("Momspligtig oms\u00e6tning", n.momspligtigOmsaetning),
    kv("Momsfri oms\u00e6tning", n.momsfriOmsaetning),
    kv("Bogf\u00f8rt salgsmoms", n.salgsmomsBogfoert),
    kv("Forventet salgsmoms (25%)", n.salgsmomsForventet),
    kv("Afvigelse salgsmoms", n.salgsmomsAfvigelse),
    kv("K\u00f8bsmoms", n.koebsmoms),
    kv("EU-/udlandsk\u00f8b", n.euKoeb),
    kv("Erhvervelsesmoms", n.erhvervelsesmoms)
  ].filter(Boolean);

  return "DETERMINISTISK MOMSAFSTEMNING (beregnet maskinelt af systemet ud fra talkolonnerne i materialet, " + a.parsedeLinjer + " r\u00e6kker parset):\n"
    + linjer.map(l => "- " + l).join("\n")
    + (a.fund.length ? "\n\nAutomatiske fund (inds\u00e6ttes selvst\u00e6ndigt i rapporten \u2014 GENTAG DEM IKKE som nye fund, men du m\u00e5 henvise til dem og uddybe \u00e5rsager):\n" + a.fund.map(f => "- " + f.titel).join("\n") : "")
    + "\n\nBrug disse verificerede tal n\u00e5r du omtaler salgsmoms, k\u00f8bsmoms, oms\u00e6tning og EU-k\u00f8b \u2014 lav ALDRIG egne sammenl\u00e6gninger af r\u00e6kkerne.";
}

module.exports = { beregnMomsAfstemning, afstemningTilPromptBlok, parseBeloeb, parseFil };
