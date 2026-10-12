import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

import { ACCEPT_ATTRIBUTE } from '../../../src/lib/files/limits.js';
import { ATTACH_LABEL, RETENTION_HINT } from '../lib/filesView.js';

interface Props {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  /** Milestone 4 part 2: the panel's composer needs its own id beside the page's. */
  readonly inputId?: string;
  /** Focus the box on mount — the panel opens ready to type. */
  readonly autoFocus?: boolean;
  /**
   * Milestone 5 part 1: attach files to this conversation. Absent = no attach control (an
   * administrator's read-only view has no composer at all, so this is for completeness).
   */
  readonly onAttach?: (files: File[]) => void;
  /**
   * A file is still on its way in. A message sent now would be answered without it, so Send
   * waits — and this sentence says why, rather than a greyed-out button saying nothing.
   */
  readonly sendBlockedNote?: string | null;
}

export const MAX_MESSAGE_CHARS = 8_000;

/** A mouse-and-keyboard machine sends on Enter; a touch screen keeps Enter as a newline. */
function enterSends(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
}

export function Composer({
  value,
  disabled,
  onChange,
  onSend,
  inputId = 'composer-input',
  autoFocus = false,
  onAttach,
  sendBlockedNote = null,
}: Props): ReactElement {
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Grow with the text up to a cap, so a long brief is visible without a tiny scrollbox.
  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, 160))}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  const canSend =
    !disabled &&
    sendBlockedNote === null &&
    value.trim() !== '' &&
    value.length <= MAX_MESSAGE_CHARS;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && enterSends()) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <>
      {sendBlockedNote !== null && (
        <p className="composer__note" role="status" data-testid="send-blocked">
          {sendBlockedNote}
        </p>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend();
        }}
      >
        {onAttach !== undefined && (
          <>
            {/* The button is the control: reachable by Tab, opened by Enter or Space. The
                input behind it is the browser's own file picker and takes no focus itself. */}
            <button
              type="button"
              className="button composer__attach"
              aria-label={ATTACH_LABEL}
              title={`${ATTACH_LABEL}. ${RETENTION_HINT}`}
              onClick={() => {
                picker.current?.click();
              }}
            >
              <span aria-hidden="true">📎</span>
              {/* Hidden from a screen reader: the button already has this as its name. */}
              <span className="composer__attach-label" aria-hidden="true">
                {ATTACH_LABEL}
              </span>
            </button>
            <input
              ref={picker}
              className="composer__picker"
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              tabIndex={-1}
              aria-hidden="true"
              data-testid={`${inputId}-files`}
              onChange={(event) => {
                const chosen = Array.from(event.target.files ?? []);
                // Cleared so that choosing the same file again is a change the browser reports.
                event.target.value = '';
                if (chosen.length > 0) onAttach(chosen);
              }}
            />
          </>
        )}
        <label className="sr-only" htmlFor={inputId}>
          Message
        </label>
        <textarea
          id={inputId}
          ref={area}
          className="composer__input"
          placeholder="Ask for a post, an ad, a reply…"
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_CHARS}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
          enterKeyHint="send"
          autoCapitalize="sentences"
        />
        <button
          className="button button--primary composer__send"
          type="submit"
          disabled={!canSend}
          aria-label="Send"
        >
          {disabled ? '…' : 'Send'}
        </button>
      </form>
    </>
  );
}
