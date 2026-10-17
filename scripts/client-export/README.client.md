# Fundd Command Centre

The Fundd (formerly Encharge Capital) command centre: an assistant that writes in the
business's own voice, remembers what it is told across devices, reads files, web pages and
Google Drive documents, and sits on a dashboard over the GoHighLevel pipeline.

## Stack

| Layer          | Technology                                                       |
| -------------- | ---------------------------------------------------------------- |
| Web app        | React 19 + Vite, deployed on Vercel                              |
| Backend        | Supabase — Postgres 17 (pgvector), Edge Functions (Deno), Storage |
| Language model | Anthropic API                                                    |
| Embeddings     | Voyage AI (`voyage-3`)                                           |
| CRM            | GoHighLevel (Private Integration token)                          |
| Documents      | Google Drive (OAuth, per user)                                   |
| Language       | TypeScript (strict), Node 24                                     |
| Tests          | Vitest, Playwright                                               |

## Repository layout

```
src/lib/         business logic — pure, unit-tested modules
src/functions/   Edge Function entry points (bundled into supabase/functions/)
web/             the dashboard (React)
supabase/        migrations, seed and local configuration
scripts/         command-line tools (build, staff admin, sync, diagnostics)
tests/           unit, integration, security and browser suites
```

## Getting started

Requirements: Node 24 (`.nvmrc`), npm, and the Supabase CLI. Docker is only needed for the
local Supabase stack used by the integration suites.

```bash
npm install
cp .env.example .env        # then fill in the values
npm run web:dev             # dashboard on http://localhost:5173
```

## Commands

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run typecheck`        | TypeScript, server and web                                        |
| `npm run lint`             | ESLint and Prettier                                               |
| `npm run test:unit`        | Unit suite with the coverage gate (80% lines / 75% branches)      |
| `npm run test:int`         | Integration suite (needs `supabase start`)                        |
| `npm run test:e2e`         | Browser suite at 375 / 768 / 1280 px                              |
| `npm run test:regress`     | Everything above except the browser suite                         |
| `npm run web:build`        | Production build of the dashboard to `web/dist`                   |
| `npm run web:check`        | Fails if the built bundle contains a server secret                |
| `npm run functions:bundle` | Bundles each Edge Function into `supabase/functions/<name>/`      |
| `npm run staff -- help`    | Staff accounts: add, deactivate, reset password, bootstrap        |
| `npm run crm -- read`      | Read-only check of the live GoHighLevel pipeline                  |
| `npm run crm -- sync`      | Full GoHighLevel → database sync                                  |

## Deployment

**Database.** Migrations live in `supabase/migrations/` and are the only way the schema
changes. Apply them before deploying any code that depends on them:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

**Edge Functions.** Bundle, then deploy each function that changed. JWT verification is done
inside the functions, so it is off at the gateway (as in `supabase/config.toml`):

```bash
npm run functions:bundle
supabase functions deploy <chat|memory|admin|crm|files|connector|drive|settings> --no-verify-jwt
```

Server-side secrets (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GHL_PRIVATE_INTEGRATION_TOKEN`,
the Google OAuth client, `CHAT_ALLOWED_ORIGIN`, …) are set with `supabase secrets set` and
never in the web app.

**Web app.** Vercel builds with the settings in `vercel.json`
(`npm run web:build && npm run web:check`, output `web/dist`). Set two environment variables
in the Vercel project:

- `VITE_SUPABASE_URL` — the Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — the project's public anon key

## Security

- Row-level security is enabled on every table, deny by default.
- The `service_role` key exists only in the Edge Function environment.
- Content read from files and web pages is treated as untrusted data and can never trigger an
  action.
- `.env` is never committed; CI runs gitleaks over the full history on every push.
