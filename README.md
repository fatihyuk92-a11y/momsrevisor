# MomsRevisor Vercel-kladden

Dette er en lokal Codex-kladde baseret på dine to GitHub-filer:

- `index.html`
- `vercel.json`

## Hvad er ændret i kladden

- PRO-login har nu serverless endpoints:
  - `/api/login`
  - `/api/verify`
- AI-kald er flyttet væk fra browseren og ind i Vercel API-routes:
  - `/api/chat`
  - `/api/compliance/cvr`
  - `/api/compliance/analyze-company`
  - `/api/compliance/analyze-files`
- Compliance-siden kalder nu dine egne API-endpoints med bearer-token.
- Excel-filer parses i browseren med SheetJS, så `.xlsx` ikke længere læses som rå tekst.
- Maksimal uploadstørrelse er sat til 4 MB for at passe bedre til serverless request limits.
- CSP er strammet, så frontend ikke længere behøver direkte adgang til Anthropic.

## Vercel miljøvariabler

Sæt disse i Vercel før produktion:

```txt
ANTHROPIC_API_KEY=din_anthropic_nøgle
PRO_TOKEN_SECRET=en_lang_tilfældig_secret
PRO_EMAILS=kunde1@firma.dk,kunde2@firma.dk
```

Til test kan du midlertidigt sætte:

```txt
ALLOW_ANY_EMAIL=true
ALLOW_CVR_FALLBACK=true
```

Slå dem fra igen før rigtig lancering.

## Vigtigt

Email-login er en enkel adgangsport. Til betaling og rigtig PRO-adgang bør næste version bruge Stripe/Supabase/Auth0 eller magic-link login, så man ikke kan logge ind ved blot at kende en godkendt email.
