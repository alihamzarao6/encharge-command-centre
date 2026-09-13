import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

interface Props {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  /** Milestone 4 part 2: the panel's composer needs its own id beside the page's. */
  readonly inputId?: string;
  /** Focus the box on mount — the panel opens ready to type. */
  readonly autoFocus?: boolean;
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
}: Props): ReactElement {
  const area = useRef<HTMLTextAreaElement>(null);

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

  const canSend = !disabled && value.trim() !== '' && value.length <= MAX_MESSAGE_CHARS;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && enterSends()) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
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
  );
}
