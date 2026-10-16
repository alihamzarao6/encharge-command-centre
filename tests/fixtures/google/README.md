# Google fixtures (Milestone 5 part 3a)

Answers from Google's OAuth token endpoint, its revocation endpoint and the Drive v3 API, used
by `tests/unit/drive/*`. No test calls Google (CLAUDE.md rule 23).

**Provenance, stated plainly.** The files marked `documented` are Google's published response
shapes (developers.google.com: OAuth 2.0 for web server apps, Drive v3 `files.get` /
`files.export` / `about.get`, the Drive error reference), written by hand on 16 Oct 2026
because the OAuth client did not exist yet. The files marked `recorded` were captured from
the live client (Part D). Where they disagreed, the recorded shape wins and the code was made to
match.

Every token in these files is the placeholder `TEST_ACCESS_TOKEN` / `TEST_REFRESH_TOKEN`;
tests that need a token-SHAPED value (to prove redaction) build it at runtime, so no file in
the repository holds anything a secret scanner would match.

| File | What it is | Source |
|---|---|---|
| `token-exchange.json` | `POST /token`, `grant_type=authorization_code`, 200 | documented |
| `token-exchange-no-refresh.json` | the same with no `refresh_token` | documented |
| `token-refresh.json` | `POST /token`, `grant_type=refresh_token`, 200 | documented |
| `error-invalid-grant.json` | 400: a revoked or lapsed grant, or a used code | documented |
| `error-invalid-client.json` | 401: our client id or secret is wrong | documented |
| `revoke-invalid-token.json` | `POST /revoke` for a token already gone, 400 | documented |
| `about.json` | `GET /drive/v3/about?fields=user(emailAddress,permissionId)` | documented |
| `file-google-doc.json` | `files.get` of a Google Doc (no `size`) | documented |
| `file-pdf.json` | `files.get` of a PDF | documented |
| `file-shortcut.json` | `files.get` of a shortcut | documented |
| `file-trashed.json` | `files.get` of a file in the bin | documented |
| `drive-401.json` | invalid credentials | documented |
| `drive-403-rate.json` | `userRateLimitExceeded` | documented |
| `drive-403-not-authorized.json` | `appNotAuthorizedToFile` (not opened through the app) | documented |
| `drive-403-export-size.json` | `exportSizeLimitExceeded` | documented |
| `drive-403-domain.json` | `domainPolicy` | documented |
| `drive-404.json` | `notFound` | documented |
