# RUNBOOK.md — Operations

Fill this in as you build, not at the end. It is a Phase 5 deliverable and the difference
between a handover and an abandonment. Every procedure here must have been performed once,
not just written down.

---

## 1. System map

| Component | Where | Owner account | Purpose |
|---|---|---|---|
| n8n | Railway | client | Orchestration |
| Database | Supabase (Sydney) | client | Source of truth |
| AI | Anthropic Console | client | Claude API |
| Embeddings | Voyage AI | client | Vector memory |
| Search | Serper | client | Website discovery |
| Email verification | MillionVerifier | client | Address validation |
| Interface | Notion | client | Human UI |
| CRM | GoHighLevel | client | Destination |
| Export | Google Sheets ("Finance leads") | client | Mirror |
| Social | Meta / LinkedIn apps | client | Insights |

---

## 2. Daily checks (2 minutes)

1. Notion dashboard: any records stuck in `review` more than 24h?
2. Cost rollup: today's spend inside the daily cap? Month inside $50?
3. Alerts inbox (Ross@enchargecapital.com): anything overnight?

---

## 3. Common situations

### A workflow failed
1. Open `workflow_runs`, filter `status = failed`, find the run.
2. The `error` column tells you which step and why.
3. Transient (timeout, 429, 5xx)? Re-run — every workflow is idempotent, a re-run cannot
   create duplicates.
4. Persistent? Check the external service's status page before assuming it's our code.

### A batch stopped partway
The cost cap probably tripped. Check `api_usage` against the daily cap. To resume: raise the
cap in the environment variables or wait for the daily reset, then re-run. Re-running skips
already-processed records via `content_hash` and idempotency keys.

### Records piling up in the review queue
The system doing its job. Common causes in order: thin websites with no team page, ambiguous
industry or partner-type classification, catch-all email domains. Consistently high volume
means the confidence thresholds need tuning — a rubric change, not a code change.

### A contact looks wrong
Open the record, follow `source_url`, view the original page. Every field is traceable. If
the source genuinely does not contain that data, it is a fabrication: capture the record, add
it to the golden set as a regression case, and investigate the prompt.

### A consumer lead got researched
It shouldn't be possible — `src/lib/routing/leadType.ts` guards it. If it happens, that is a
routing bug, not a data issue. Write the failing test first.

### CRM push failed
`crm_sync_log` filtered to `status = failed` shows request and response. Fix the cause, then
`npm run replay-crm -- --org-id=<id>` to re-push. Never hand-edit GoHighLevel to "fix" it —
that creates divergence from the source of truth.

### Social metrics stopped updating
Almost always an expired token. Check `social_accounts.token_expires_at`. Refresh in section 5.

### Supabase project shows as paused
Free-tier projects auto-pause after roughly a week of inactivity. Restore from the Supabase
dashboard; no data is lost. If this becomes a recurring nuisance in production, the fix is a
paid tier, which is a client cost decision.

---

## 4. Key rotation

Per key: generate new → update in Railway / Supabase Vault → redeploy or restart n8n → verify
with a health-check run → revoke the old key. Rotate all keys at handover, and any time
someone with access leaves.

Order matters for n8n credentials: update the credential in the n8n UI first, run one test
execution, *then* revoke the old key. Revoking first means a broken pipeline and a panicked
debug session.

The GoHighLevel Private Integration token is revoked and regenerated from
Settings → Private Integrations in the GHL account.

---

## 5. Social token refresh

Automated, with an alert 7 days before expiry. Manual procedure:
Meta → Business Settings → System User → generate token with the insights permissions →
update the credential in n8n → run W6 manually → confirm rows land in `social_metrics`.
LinkedIn → developer portal → refresh the app token → same verification.

---

## 6. Backup and restore

- Daily automatic backups, 7-day retention.
- Restore: dashboard → Backups → restore to a **new** project first, verify the data, then cut
  over. Never restore over a live project as a first move.
- The n8n encryption key must be backed up separately. Without it, every stored credential is
  unrecoverable and must be re-entered by hand.
- Workflows are in git (`n8n/workflows/`) and can be re-imported.

---

## 7. Rebuilding a downstream system

The database is the source of truth, so GoHighLevel, Google Sheets and Notion are all
rebuildable:

```bash
npm run replay-crm      # rebuild GoHighLevel + Sheets from the database
npm run replay-notion   # rebuild Notion databases from the database
```

Both idempotent and safe against a partially-populated target.

---

## 8. Adding a new lead type

1. Add the value to the `lead_type` check constraint via a migration.
2. Decide: researched or tracking-only. Update `src/lib/routing/leadType.ts` and its tests.
3. If researched, either map it to an existing rubric or seed a new one in `rubric_versions`.
4. Add the option in Notion and the matching GoHighLevel custom field value.
5. Run the golden set to confirm nothing shifted.

---

## 9. Changing a ranking rubric

Rubrics live in `rubric_versions` as JSON, keyed by `rubric_key` (`business_finance` or
`referral_partner`). Insert a new version and mark it active; the old one deactivates. Every
historical score keeps its rubric version, so past decisions stay explainable. Run the golden
set after any change — tiers should not move more than one band unless that was the intent.

---

## 10. Adding a new data source

1. Write an adapter in `src/lib/discovery/` implementing the source interface.
2. Contract tests with recorded fixtures.
3. Register it in the source registry.
4. Run the golden set to confirm ranking has not shifted.

The adapter pattern keeps this contained. It is still a scope change and should be priced.

---

## 11. Escalation

| Symptom | First check |
|---|---|
| Nothing is running | Railway service status, n8n container up |
| Everything is failing | Database status, API key validity, spend cap |
| One workflow failing | `workflow_runs.error` |
| Bad data | `source_url` on the record, then the prompt |
| Unexpected cost | `api_usage` grouped by provider and day |
| CRM out of sync | `crm_sync_log`, then `replay-crm` |
