/**
 * Configuration for reading files (Milestone 5 part 1) — read from the SERVER environment.
 * Everything an operator might tune without a redeploy; every value has a default that is the
 * decision on record (docs/MEMORY.md D85, D88, D90), and a malformed value is a CONFIG error
 * rather than a silent fallback: someone set it, and got it wrong.
 *
 * The limits a browser must also honour (file size, files per conversation, page counts) are
 * NOT here — they are constants in limits.ts, imported by both sides, so the interface cannot
 * promise a number the server does not enforce.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';
import type { ModelRoute } from '../llm/client.js';
import { DEFAULT_USER_AGENT, PAGE_LIMITS } from '../pages/limits.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from './context.js';
import { FILE_LIMITS } from './limits.js';

export interface FilesConfig {
  /** Document text per turn, in characters (D88). */
  readonly contextMaxChars: number;
  /** Days a file's text is kept (D85). */
  readonly retentionDays: number;
  /** Which model reads a page image. `default` is Sonnet; `fast` is Haiku. */
  readonly visionRoute: ModelRoute;
  /** Output ceiling for one page's transcription. */
  readonly visionMaxTokens: number;
  /** Days the text of a web page read from a link is kept (D95). */
  readonly pageRetentionDays: number;
  /** Who a page fetch says it is (D96). Honest, with a contact address. */
  readonly pageUserAgent: string;
}

export const FILES_DEFAULTS = {
  contextMaxChars: DEFAULT_CONTEXT_MAX_CHARS,
  retentionDays: FILE_LIMITS.retentionDays,
  // The default model: a payslip photo is read once and acted on, and a wrong digit is real
  // harm. Sonnet sees a page at up to 2,576 px; Haiku at 1,568.
  visionRoute: 'default' as ModelRoute,
  visionMaxTokens: 4_096,
  // One day: a page of rates a day old is a wrong answer waiting to be given, and reading it
  // again is one tap and costs nothing.
  pageRetentionDays: PAGE_LIMITS.pageRetentionDays,
  pageUserAgent: DEFAULT_USER_AGENT,
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number, ConfigError> {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return ok(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return err(
      new ConfigError(`${name} must be an integer from ${String(min)} to ${String(max)}`, {
        context: { name },
      }),
    );
  }
  return ok(value);
}

export function loadFilesConfig(env: Env = process.env): Result<FilesConfig, ConfigError> {
  const contextMaxChars = integer(
    env,
    'FILES_CONTEXT_MAX_CHARS',
    FILES_DEFAULTS.contextMaxChars,
    2_000,
    400_000,
  );
  if (!contextMaxChars.ok) return contextMaxChars;
  const retentionDays = integer(env, 'FILES_RETENTION_DAYS', FILES_DEFAULTS.retentionDays, 1, 365);
  if (!retentionDays.ok) return retentionDays;
  const visionMaxTokens = integer(
    env,
    'FILES_VISION_MAX_TOKENS',
    FILES_DEFAULTS.visionMaxTokens,
    256,
    16_000,
  );
  if (!visionMaxTokens.ok) return visionMaxTokens;
  const route = env['FILES_VISION_ROUTE']?.trim();
  if (route !== undefined && route !== '' && route !== 'default' && route !== 'fast') {
    return err(new ConfigError('FILES_VISION_ROUTE must be "default" or "fast"'));
  }
  const pageRetentionDays = integer(
    env,
    'FILES_PAGE_RETENTION_DAYS',
    FILES_DEFAULTS.pageRetentionDays,
    1,
    30,
  );
  if (!pageRetentionDays.ok) return pageRetentionDays;
  const agent = env['PAGES_USER_AGENT']?.trim();
  // A header value: printable ASCII only, and it must say how to reach whoever runs it —
  // an agent with no contact address is the anonymous crawler CLAUDE.md §7 rules out.
  if (
    agent !== undefined &&
    agent !== '' &&
    !(/^[\x20-\x7E]{12,200}$/.test(agent) && /\+https:\/\/[a-z0-9.-]+/i.test(agent))
  ) {
    return err(
      new ConfigError(
        'PAGES_USER_AGENT must be 12 to 200 printable characters and contain a contact address as +https://…',
      ),
    );
  }
  return ok({
    contextMaxChars: contextMaxChars.value,
    retentionDays: retentionDays.value,
    visionRoute: route === 'fast' ? 'fast' : FILES_DEFAULTS.visionRoute,
    visionMaxTokens: visionMaxTokens.value,
    pageRetentionDays: pageRetentionDays.value,
    pageUserAgent: agent === undefined || agent === '' ? FILES_DEFAULTS.pageUserAgent : agent,
  });
}
