/**
 * The door to the file readers (Milestone 5 part 1). Everything behind it — the format
 * readers, the zip and PDF libraries, the canvas code — is loaded the first time someone
 * attaches a file and not before: a person who only ever types never downloads a megabyte of
 * PDF reader on their phone.
 */
import type { Extraction } from './types.js';

export async function extractInBrowser(
  input: { readonly name: string; readonly bytes: Uint8Array },
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<Extraction> {
  const [{ extractFile }, { browserEngines }] = await Promise.all([
    import('./extract.js'),
    import('./browser.js'),
  ]);
  return extractFile({ ...input, onProgress, signal }, browserEngines());
}

export async function hashInBrowser(bytes: Uint8Array): Promise<string> {
  const { sha256Hex } = await import('./extract.js');
  return sha256Hex(bytes);
}
