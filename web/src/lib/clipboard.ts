/**
 * Copy-to-clipboard that works on a phone. The async Clipboard API needs a secure context
 * and a user gesture (both true for a tap on the deployed HTTPS page); older WebViews and
 * some in-app browsers still lack it, so the legacy selection path is the fallback. The
 * result is a boolean the button can show, never an exception.
 */
export interface ClipboardDeps {
  readonly clipboard: { writeText(text: string): Promise<void> } | null;
  readonly document: Document | null;
}

export async function copyText(deps: ClipboardDeps, text: string): Promise<boolean> {
  if (deps.clipboard !== null) {
    try {
      await deps.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  return legacyCopy(deps.document, text);
}

function legacyCopy(doc: Document | null, text: string): boolean {
  if (doc === null) return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the fallback for WebViews without navigator.clipboard; deprecated but still implemented everywhere
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

export function browserClipboardDeps(): ClipboardDeps {
  return {
    clipboard:
      typeof navigator !== 'undefined' && 'clipboard' in navigator ? navigator.clipboard : null,
    document: typeof document !== 'undefined' ? document : null,
  };
}
