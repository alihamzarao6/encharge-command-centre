/**
 * Google Drive runner (Milestone 5 part 3a). Everything here goes through the app's own code —
 * the Google client (src/lib/drive/google.ts), the plan for a file (formats.ts) and part 1's
 * readers (web/src/lib/files) — so what it shows is what the app would do.
 *
 *   npm run drive -- url [--onepick] [--port N] [--mode form_post|query]
 *                         Print the consent address Google would be sent to. Nothing is
 *                         started and nothing is exchanged. Needs GOOGLE_DRIVE_CLIENT_ID.
 *   npm run drive -- probe [--port N] [--plain] [--mode form_post|query] [--keep] [--full]
 *                         LIVE, on THIS machine. Starts a listener on 127.0.0.1:<port>/callback,
 *                         prints a consent address that opens Google's OnePick picker
 *                         (`--plain`: the plain consent screen, no picker), and waits for Google
 *                         to come back. Then it reports what came back — which parameters, the
 *                         picked file ids, the scope; never the code. With
 *                         GOOGLE_DRIVE_CLIENT_SECRET set it also exchanges the code (PKCE), says
 *                         whether lasting access was granted (never the token), names the
 *                         account's domain, reads every picked file through the app's own plan
 *                         and readers, prints what came out, and REVOKES the grant at the end
 *                         (`--keep` leaves it). Nothing is stored anywhere.
 *
 * The listener's address must be registered on the OAuth client as an authorised redirect URI
 * (`http://localhost:<port>/callback`); Google allows localhost for a web client. The port
 * defaults to 8765.
 *
 * This prints the text of the files picked. That is its purpose, and it prints only to the
 * terminal of the person who picked them; do not run it on a client's files on a machine whose
 * terminal is recorded.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { pkceChallenge, randomToken } from '../src/lib/drive/crypto.js';
import { planFor, readerFileName, typeGroup } from '../src/lib/drive/formats.js';
import {
  checkGrantedScope,
  createGoogleClient,
  grantedScopes,
  type GoogleConfig,
} from '../src/lib/drive/google.js';
import { createHttpClient } from '../src/lib/http.js';
import { logger } from '../src/lib/logger.js';
import { extractFile } from '../web/src/lib/files/extract.js';
import type { ExtractEngines } from '../web/src/lib/files/types.js';

interface Flags {
  readonly positional: readonly string[];
  readonly port: number;
  readonly mode: 'form_post' | 'query';
  readonly onepick: boolean;
  readonly plain: boolean;
  readonly keep: boolean;
  readonly full: boolean;
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`drive: ${message}\n`);
  process.exit(1);
}

function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  let port = 8765;
  let mode: Flags['mode'] = 'form_post';
  let onepick = false;
  let plain = false;
  let keep = false;
  let full = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--port' || arg === '--mode') {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      if (arg === '--port') {
        port = Number(value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port is 1024 to 65535');
      } else {
        if (value !== 'form_post' && value !== 'query') fail('--mode is form_post or query');
        mode = value;
      }
    } else if (arg === '--onepick') onepick = true;
    else if (arg === '--plain') plain = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--full') full = true;
    else positional.push(arg);
  }
  return { positional, port, mode, onepick, plain, keep, full };
}

/** The app's readers under Node, as `npm run files -- extract` runs them. */
function nodeEngines(): ExtractEngines {
  return {
    pdf: () => Promise.resolve({ getDocument }),
    pdfAssets: `${join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist')}/`,
    images: {
      decode: () => Promise.resolve({ base64: '', width: 0, height: 0 }),
      renderPdfPage: () => Promise.resolve(null),
    },
  };
}

function googleConfig(flags: Flags, needSecret: boolean): GoogleConfig {
  const clientId = process.env['GOOGLE_DRIVE_CLIENT_ID']?.trim() ?? '';
  if (clientId === '') fail('GOOGLE_DRIVE_CLIENT_ID is not set (.env or the environment)');
  const clientSecret = process.env['GOOGLE_DRIVE_CLIENT_SECRET']?.trim() ?? '';
  if (needSecret && clientSecret === '') fail('GOOGLE_DRIVE_CLIENT_SECRET is not set');
  return {
    clientId,
    clientSecret,
    redirectUri: `http://localhost:${String(flags.port)}/callback`,
    responseMode: flags.mode,
  };
}

const ONEPICK = { trigger_onepick: 'true', allow_multiple: 'true' } as const;

async function url(flags: Flags): Promise<void> {
  const config = googleConfig(flags, false);
  const google = createGoogleClient({ config, http: createHttpClient({ logger }) });
  const verifier = randomToken(48);
  say(
    google.authorizeUrl({
      state: randomToken(32),
      codeChallenge: await pkceChallenge(verifier),
      ...(flags.onepick ? { extra: ONEPICK } : {}),
    }),
  );
}

/** One callback from Google: the query, and (form_post) the body. */
function readParams(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const params: Record<string, string> = {};
    const address = new URL(request.url ?? '/', 'http://localhost');
    for (const [name, value] of address.searchParams) params[name] = value;
    if (request.method !== 'POST') {
      resolve(params);
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      if (body.length < 32_768) body += chunk;
    });
    request.on('end', () => {
      for (const [name, value] of new URLSearchParams(body)) params[name] = value;
      resolve(params);
    });
  });
}

function waitForCallback(
  port: number,
  state: string,
): Promise<{ method: string; params: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      void readParams(request).then((params) => {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(
          '<!doctype html><title>Drive probe</title><p>Received. You can close this tab and go back to the terminal.</p>',
        );
        if (params['state'] !== state) {
          say('A callback arrived with a state this probe did not issue; ignored.');
          return;
        }
        server.close();
        resolve({ method: request.method ?? 'GET', params });
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('no callback within ten minutes'));
    }, 10 * 60_000).unref();
  });
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

async function probe(flags: Flags): Promise<void> {
  const config = googleConfig(flags, false);
  const google = createGoogleClient({ config, http: createHttpClient({ logger, retries: 2 }) });
  const state = randomToken(32);
  const verifier = randomToken(48);
  const address = google.authorizeUrl({
    state,
    codeChallenge: await pkceChallenge(verifier),
    ...(flags.plain ? {} : { extra: ONEPICK }),
  });
  say(`Listening on ${config.redirectUri} (response mode: ${flags.mode}).`);
  say(
    flags.plain
      ? 'Open this address, and approve:'
      : 'Open this address, pick one or more files, and approve:',
  );
  say('');
  say(address);
  say('');
  const callback = await waitForCallback(flags.port, state);
  const params = callback.params;
  const picked = (params['picked_file_ids'] ?? '').split(',').filter((id) => id !== '');
  out({
    arrivedAs: callback.method,
    parameters: Object.keys(params).sort(),
    code:
      params['code'] === undefined
        ? 'absent'
        : `present (${String(params['code'].length)} characters, not shown)`,
    error: params['error'] ?? null,
    scope: params['scope'] === undefined ? null : grantedScopes(params['scope']),
    pickedFileIds: picked,
    onepickWorked: !flags.plain && picked.length > 0,
  });
  const code = params['code'];
  if (code === undefined) return;
  if ((process.env['GOOGLE_DRIVE_CLIENT_SECRET']?.trim() ?? '') === '') {
    say(
      'GOOGLE_DRIVE_CLIENT_SECRET is not set: stopping before the exchange. Google holds no token for an unexchanged code.',
    );
    return;
  }

  const secretConfig = googleConfig(flags, true);
  const live = createGoogleClient({
    config: secretConfig,
    http: createHttpClient({ logger, retries: 2 }),
  });
  const grant = await live.exchangeCode(code, verifier);
  if (!grant.ok) fail(`the exchange failed: ${grant.error.kind}`);
  const scope = checkGrantedScope(grant.value.scope);
  const account = await live.about(grant.value.accessToken);
  out({
    exchanged: true,
    grantedScope: grantedScopes(grant.value.scope),
    scopeCheck: scope,
    lastingAccess: grant.value.refreshToken !== null,
    account: account.ok
      ? {
          email: maskEmail(account.value.email),
          permissionId: `${account.value.permissionId.slice(0, 4)}…`,
        }
      : account.error.kind,
  });

  for (const fileId of picked) {
    const started = performance.now();
    const meta = await live.getFile(grant.value.accessToken, fileId);
    if (!meta.ok) {
      out({ fileId, read: false, reason: meta.error.kind });
      continue;
    }
    let file = meta.value;
    let plan = planFor(file);
    if (plan.kind === 'shortcut') {
      const target = await live.getFile(grant.value.accessToken, plan.targetId);
      if (!target.ok) {
        out({ fileId, read: false, shortcut: true, reason: target.error.kind });
        continue;
      }
      file = target.value;
      plan = planFor(file, true);
    }
    if (plan.kind !== 'export' && plan.kind !== 'download') {
      out({ fileId, name: file.name, type: typeGroup(file.mimeType), read: false, plan });
      continue;
    }
    const content = await live.readContent(grant.value.accessToken, file.id, plan);
    if (!content.ok) {
      out({
        fileId,
        name: file.name,
        type: typeGroup(file.mimeType),
        read: false,
        reason: content.error.kind,
      });
      continue;
    }
    const fetchedMs = Math.round(performance.now() - started);
    const extraction = await extractFile(
      { name: readerFileName(file, plan), bytes: content.value.bytes },
      nodeEngines(),
    );
    const base = {
      fileId,
      name: file.name,
      googleMimeType: file.mimeType,
      type: typeGroup(file.mimeType),
      exportedAs: plan.kind === 'export' ? plan.format.mimeType : null,
      bytes: content.value.bytes.length,
      fetchedMs,
      readMs: Math.round(performance.now() - started) - fetchedMs,
    };
    if (!extraction.ok) {
      out({ ...base, read: false, refusal: extraction.refusal });
      continue;
    }
    out({
      ...base,
      read: true,
      kind: extraction.kind,
      totalPages: extraction.totalPages,
      textPages: extraction.pages.length,
      chars: extraction.pages.reduce((sum, page) => sum + page.text.length, 0),
      pagesToReadAsImages: extraction.vision.map((page) => page.label),
      notes: extraction.notes,
      pages: extraction.pages.map((page) => ({
        label: page.label,
        chars: page.text.length,
        text: flags.full ? page.text : page.text.slice(0, 600),
      })),
    });
    extraction.dispose();
  }

  if (flags.keep) {
    say(
      '--keep: the grant is left at Google. Remove "Fundd Command Centre" at https://myaccount.google.com/connections when done.',
    );
    return;
  }
  const revoked = await live.revoke(grant.value.refreshToken ?? grant.value.accessToken);
  out({ revokedAtGoogle: revoked.ok ? revoked.value : revoked.error.kind });
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'url':
      await url(flags);
      return;
    case 'probe':
      await probe(flags);
      return;
    case undefined:
    default:
      fail(
        'usage: npm run drive -- url [--onepick] [--port N] [--mode form_post|query] | probe [--port N] [--plain] [--mode form_post|query] [--keep] [--full]',
      );
  }
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : String(caught));
});
