# MomsRevisor – Vercel

Single-page site (index.html) + serverless API-routes på Vercel.

## API-endpoints

- `/api/login` – udsteder PRO-token (HMAC-signeret, 14 dage)
- `/api/verify` – verificerer token
- `/api/chat` – AI-rådgiver. System prompt ligger på serveren i `api/_knowledge.js`
  og sendes med prompt caching. Klientens `system`-felt ignoreres.
- `/api/compliance/cvr` – CVR-opslag via cvrapi.dk
- `/api/compliance/analyze-company` – AI-analyse af CVR-data
- `/api/compliance/analyze-files` – AI-analyse af uploadet regnskabsmateriale

## Påkrævede miljøvariabler (Vercel)

```txt
ANTHROPIC_API_KEY=din_anthropic_nøgle
PRO_TOKEN_SECRET=lang_tilfældig_streng_min_16_tegn   # API'et fejler hårdt uden den
PRO_EMAILS=kunde1@firma.dk,kunde2@firma.dk
```

Generér en secret med fx: `openssl rand -base64 32`

## Stærkt anbefalede miljøvariabler

```txt
UPSTASH_REDIS_REST_URL=...     # server-side rate limiting på tværs af instanser
UPSTASH_REDIS_REST_TOKEN=...
CVR_USER_AGENT=accai ApS - MomsRevisor - kontakt@accai.dk   # cvrapi.dk kræver kontaktinfo
```

Uden Upstash bruges en in-memory tæller pr. serverless-instans. Den stopper
simple loops, men er ikke vandtæt – sæt Upstash op før betalende kunder
(gratis tier rækker langt: console.upstash.com → Redis → REST API).

## Rate limits (pr. bruger/time, kan justeres i koden)

- Chat: 30 · CVR-opslag: 20 · Virksomhedsanalyse: 10 · Filanalyse: 6
- Login: 10 forsøg pr. kvarter pr. IP

## Kun til test – aldrig i produktion

```txt
ALLOW_ANY_EMAIL=true
ALLOW_CVR_FALLBACK=true
```

Den tidligere hardcodede test-email (`test@momsrevisor.dk`) er FJERNET.

## Sikkerhedsændringer i denne version

- Vidensbase flyttet server-side (`api/_knowledge.js`) – klienten kan ikke
  længere sende egen system prompt og misbruge endpointet som Claude-proxy.
- `PRO_TOKEN_SECRET` er obligatorisk; ingen fallback-secret.
- Server-side rate limiting på alle endpoints.
- `maxDuration: 60` på alle functions (kræver Vercel Pro eller fluid compute) –
  uden den timer filanalyser ud efter 10 sek.
- `max_tokens` hævet: analyser 3000–3500, chat 1500.
- PDF-grænse pr. dokument sænket til ~3 MB base64, så samlet request holder
  sig under Vercels ~4,5 MB grænse.


## Compliance-motoren (v2)

- Begge analyse-endpoints bruger nu vidensbasen (`api/_knowledge.js`) som cached
  retskilde — samme cache-prefix som chatten, så de deler prompt-cache.
- Serveren ejer hele prompten. Frontend sender kun rådata:
  `POST /api/compliance/analyze-files` → `{ filer: [{navn, tekst? | pdfBase64?}], virksomhed? }`
- Output er struktureret JSON (`format: "struktureret"`, `rapport`) med fund
  (kategori/alvor/grundlag/konto/beløb/lov/handling) og anbefalinger.
  Falder modellen ud af skemaet, returneres `format: "tekst"` i stedet for fejl.
- Anti-hallucination: konto/beløb må kun citeres når de står i materialet, og
  hvert fund er markeret "observeret" eller "risikovurdering".
- Grænser: max 2 MB pr. PDF (klient + server), samlet payload-værn på begge sider.

Valgfrit kvalitetsløft: sæt `ANTHROPIC_MODEL=claude-sonnet-4-6` (nyere model,
samme API). Standard er fortsat claude-sonnet-4-20250514.


## Deterministisk momsafstemning (v3)

`api/compliance/_afstemning.js` kører FØR AI'en på alle CSV/Excel-uploads:

- Parser talkolonner (dansk talformat, saldo- eller debet/kredit-opstilling)
  og genkender momskonti på kontonavne (salgsmoms, købsmoms, erhvervelses-/
  importmoms, EU-køb, omsætning, momsfri omsætning, restauration, repræsentation).
- Beregner forventet salgsmoms (25 % af momspligtig omsætning) og afstemmer
  mod bogført. Afvigelse > maks(500 kr., 2 %) → automatisk fund (kritisk/høj).
- Kontrollerer EU-/udlandskøb mod erhvervelsesmoms (omvendt betalingspligt).
- Flager observerede beløb på fradragsbegrænsede konti med lovhenvisning.

Resultatet bruges tre steder: nøgletalskort i rapporten ("Momsafstemning —
beregnet maskinelt"), automatiske fund øverst i fund-listen, og som verificerede
tal i AI-prompten, så modellen ALDRIG selv lægger rækker sammen. AI-dubletter
af de deterministiske kontroller filtreres fra. Uden ANTHROPIC_API_KEY leverer
modulet en struktureret rapport alene.

Begrænsninger (ærlig varedeklaration): kræver genkendelige danske kontonavne
(standardeksport fra e-conomic/Dinero/Billy virker); scannede PDF'er analyseres
kun af AI'en; købsmoms kan ikke BEVISES korrekt ud fra en saldobalance alene
(kræver momskoder/bilag) — den vises som nøgletal og kontrolleres på bilagsniveau
af AI'en; og motoren afstemmer bogføringens interne konsistens, ikke om
momsangivelsen til Skat matcher (upload angivelsen, så sammenholder AI'en).

## Næste fase (før rigtig lancering)

- Stripe Checkout + webhook → kundeliste i KV/Supabase i stedet for PRO_EMAILS
- Magic-link login (fx Resend), så kendskab til en email ikke er nok
- Databehandleraftale med Anthropic + privatlivspolitik + upload-disclaimer (GDPR)
- Prebuild med Vite i stedet for babel-standalone i browseren
- Verificér virksomhedsdata i schema.org (adresse/telefon i index.html)
