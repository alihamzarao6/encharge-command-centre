/**
 * A file in the conversation (Milestone 5 part 1): one that is attached, with its name, its
 * size and a way to remove it; one that is on its way in, with honest progress; and the line
 * left behind by one that was removed.
 *
 * Names are text a stranger chose. They are rendered as text (React escapes them), cut with
 * an ellipsis rather than allowed to push the layout sideways, and given in full in the
 * `title`. Progress is a native <progress>, which a screen reader reads without help; the
 * sentences about what happened go through the shell's live region.
 *
 * Milestone 5 part 2: a page read from a link is one of these too. It shows what a person
 * needs to judge it by — its title, the site it came from, when it was read — says plainly
 * when it was read only in part, and offers the page itself to check against. A title is the
 * page's own words: text, escaped, cut, never trusted.
 */
import { useState, type ReactElement } from 'react';

import { formatBytes } from '../../../src/lib/files/limits.js';
import type { MemoryActor } from '../../../src/lib/memory/access.js';
import type { AttachedFile } from '../lib/filesApi.js';
import {
  canRemove,
  confirmButtonText,
  confirmText,
  fileSummary,
  goneText,
  isExpired,
  missingNote,
  pageSummary,
  retentionText,
  sentNote,
  sourceNote,
  uploadPercent,
  uploadStatus,
} from '../lib/filesView.js';
import type { UploadItem } from '../lib/uploads.js';

interface AttachedProps {
  readonly file: AttachedFile;
  readonly actor: MemoryActor;
  readonly now: number;
  /** The id of a file being removed right now, if any. */
  readonly removing: string | null;
  readonly onRemove: (fileId: string) => void;
}

export function AttachedFileItem({
  file,
  actor,
  now,
  removing,
  onRemove,
}: AttachedProps): ReactElement {
  const [asking, setAsking] = useState(false);
  if (file.status === 'removed' || file.name === null || isExpired(file, now)) {
    return (
      <p className="file file--gone" data-testid="file-removed">
        {goneText(file, now)}
      </p>
    );
  }
  const busy = removing === file.id;
  const page = file.kind === 'html';
  const fromLink = file.sourceUrl !== null;
  const origin = page ? null : sourceNote(file, now);
  const partial = missingNote(file);
  const asSent = sentNote(file);
  return (
    <article
      className={`file${page ? ' file--page' : ''}`}
      data-testid="file"
      data-file-id={file.id}
      data-source={fromLink ? 'link' : 'file'}
      aria-label={`${page ? 'Web page read:' : 'Attached file'} ${file.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        {fromLink ? '🔗' : '📎'}
      </span>
      <div className="file__body">
        <p className="file__name" title={file.name}>
          {file.name}
        </p>
        <p className="file__meta">
          {page ? pageSummary(file, now) : fileSummary(file)}
          {origin === null ? '' : ` · ${origin}`} · {retentionText(file, now)}
        </p>
        {partial !== null && (
          <p className="file__partial" role="note" data-testid="file-partial">
            {partial}
          </p>
        )}
        {asSent !== null && (
          <p className="file__partial" role="note" data-testid="file-as-sent">
            {asSent}
          </p>
        )}
        {file.sourceUrl !== null && (
          <p className="file__origin">
            {/* The address was checked by the server before it was ever fetched; it is
                opened in a tab of its own, which is told nothing about this one. */}
            <a
              href={file.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={file.sourceUrl}
            >
              Open the {page ? 'page' : 'original'}
            </a>
          </p>
        )}
        {asking && (
          <div className="file__confirm" role="alert">
            <p>
              Remove this {page ? 'page' : 'file'}? What was read from it is deleted. What the
              assistant has already said about it stays in this conversation.
            </p>
            <div className="file__actions">
              <button
                type="button"
                className="button button--small button--primary"
                disabled={busy}
                onClick={() => {
                  onRemove(file.id);
                  setAsking(false);
                }}
              >
                {page ? 'Remove page' : 'Remove file'}
              </button>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setAsking(false);
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>
      {canRemove(file, actor) && !asking && (
        <button
          type="button"
          className="button button--small button--ghost file__remove"
          aria-label={`Remove ${file.name}`}
          disabled={busy}
          onClick={() => {
            setAsking(true);
          }}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      )}
    </article>
  );
}

interface UploadProps {
  readonly item: UploadItem;
  readonly onConfirm: (localId: string) => void;
  readonly onCancel: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
}

export function UploadItemRow({ item, onConfirm, onCancel, onRetry }: UploadProps): ReactElement {
  const status = uploadStatus(item);
  const percent = uploadPercent(item);
  const stopped = item.phase === 'failed' || item.phase === 'refused';
  const link = item.source === 'link';
  const doing = link ? 'Reading' : 'Attaching';
  return (
    <article
      className={`file file--upload${stopped ? ' file--stopped' : ''}`}
      data-testid="upload"
      data-phase={item.phase}
      data-source={item.source}
      aria-label={`${doing} ${item.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        {link ? '🔗' : '📎'}
      </span>
      <div className="file__body">
        <p className="file__name" title={link ? (item.url ?? item.name) : item.name}>
          {item.name}
        </p>
        <p className="file__meta">
          {/* A page has no size until it has arrived, and then its size is not the point. */}
          {link ? 'Web page' : formatBytes(item.byteSize)}
        </p>

        {status !== null && (
          <div className="file__progress">
            {percent === null ? (
              // No value: the bar is indeterminate, which is the truth before a page count exists.
              <progress className="file__bar" aria-label={`${doing} ${item.name}`} />
            ) : (
              <progress
                className="file__bar"
                max={100}
                value={percent}
                aria-label={`${doing} ${item.name}`}
              />
            )}
            <span className="file__status">{status}</span>
          </div>
        )}

        {item.phase === 'confirm' && item.estimate !== null && (
          <div className="file__confirm" role="alert" data-testid="upload-confirm">
            <p>{confirmText(item.estimate)}</p>
            <div className="file__actions">
              <button
                type="button"
                className="button button--small button--primary"
                onClick={() => {
                  onConfirm(item.localId);
                }}
              >
                {confirmButtonText(item.estimate)}
              </button>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  onCancel(item.localId);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {stopped && (
          <div className="file__problem" role="alert" data-testid="upload-problem">
            <p>{item.message}</p>
            <div className="file__actions">
              {item.phase === 'failed' && item.retryable && (
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => {
                    onRetry(item.localId);
                  }}
                >
                  Try again
                </button>
              )}
              <button
                type="button"
                className="button button--small button--ghost"
                onClick={() => {
                  onCancel(item.localId);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
      {!stopped && item.phase !== 'confirm' && (
        <button
          type="button"
          className="button button--small button--ghost file__remove"
          aria-label={`Stop ${doing.toLowerCase()} ${item.name}`}
          onClick={() => {
            onCancel(item.localId);
          }}
        >
          Stop
        </button>
      )}
    </article>
  );
}
