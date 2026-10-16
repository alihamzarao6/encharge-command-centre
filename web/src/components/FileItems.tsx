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
 *
 * Milestone 5 part 3a: a file from Google Drive says so, says when it was read, offers the
 * file in Drive, and — to the person whose Drive it came from — "Read again from Drive", which
 * replaces this copy with the file as it is now (D121). A Drive upload that failed because
 * the CONNECTION is broken points at Settings rather than offering "Try again" (D122).
 */
import { useState, type ReactElement } from 'react';

import { formatBytes } from '../../../src/lib/files/limits.js';
import type { MemoryActor } from '../../../src/lib/memory/access.js';
import type { AttachedFile } from '../lib/filesApi.js';
import {
  OPEN_IN_DRIVE_LABEL,
  READ_AGAIN_DRIVE_LABEL,
  RECONNECT_LABEL,
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
  /** Milestone 5 part 3a: read a Drive file again, as it is in Drive now. */
  readonly onReadAgain?: (file: AttachedFile) => void;
}

export function AttachedFileItem({
  file,
  actor,
  now,
  removing,
  onRemove,
  onReadAgain,
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
  const fromDrive = file.driveFileId !== null;
  const fromLink = file.sourceUrl !== null && !fromDrive;
  const origin = page ? null : sourceNote(file, now);
  const partial = missingNote(file);
  const asSent = sentNote(file);
  // Reading it again uses the reader's own Drive: offered to the person it came from.
  const canReadAgain = fromDrive && onReadAgain !== undefined && file.uploadedBy === actor.userId;
  return (
    <article
      className={`file${page ? ' file--page' : ''}`}
      data-testid="file"
      data-file-id={file.id}
      data-source={fromDrive ? 'drive' : fromLink ? 'link' : 'file'}
      aria-label={`${page ? 'Web page read:' : fromDrive ? 'File from Google Drive' : 'Attached file'} ${file.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        {fromDrive ? '☁️' : fromLink ? '🔗' : '📎'}
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
        {fromDrive && file.sourceUrl !== null && (
          <div className="file__drive-actions">
            <p className="file__origin">
              {/* Google's own page for the file; it opens only for someone Drive lets in. */}
              <a href={file.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                {OPEN_IN_DRIVE_LABEL}
              </a>
            </p>
            {canReadAgain && (
              <button
                type="button"
                className="button button--small button--ghost"
                data-testid="drive-read-again"
                onClick={() => {
                  onReadAgain(file);
                }}
              >
                {READ_AGAIN_DRIVE_LABEL}
              </button>
            )}
          </div>
        )}
        {fromLink && (
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
  const drive = item.source === 'drive';
  const doing = link ? 'Reading' : drive ? 'Getting from Google Drive' : 'Attaching';
  return (
    <article
      className={`file file--upload${stopped ? ' file--stopped' : ''}`}
      data-testid="upload"
      data-phase={item.phase}
      data-source={item.source}
      aria-label={`${doing} ${item.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        {drive ? '☁️' : link ? '🔗' : '📎'}
      </span>
      <div className="file__body">
        <p className="file__name" title={link ? (item.url ?? item.name) : item.name}>
          {item.name}
        </p>
        <p className="file__meta">
          {/* A page has no size until it has arrived, and then its size is not the point. */}
          {link
            ? 'Web page'
            : drive
              ? `From Google Drive${item.byteSize > 0 ? ` · ${formatBytes(item.byteSize)}` : ''}`
              : formatBytes(item.byteSize)}
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
              {item.reconnect && (
                // A full page visit to Settings: this upload has stopped, and is not resumed.
                <a className="file__reconnect" href="/settings" data-testid="upload-reconnect">
                  {RECONNECT_LABEL}
                </a>
              )}
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
