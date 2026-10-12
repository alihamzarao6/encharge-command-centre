/**
 * A file in the conversation (Milestone 5 part 1): one that is attached, with its name, its
 * size and a way to remove it; one that is on its way in, with honest progress; and the line
 * left behind by one that was removed.
 *
 * Names are text a stranger chose. They are rendered as text (React escapes them), cut with
 * an ellipsis rather than allowed to push the layout sideways, and given in full in the
 * `title`. Progress is a native <progress>, which a screen reader reads without help; the
 * sentences about what happened go through the shell's live region.
 */
import { useState, type ReactElement } from 'react';

import { formatBytes } from '../../../src/lib/files/limits.js';
import type { MemoryActor } from '../../../src/lib/memory/access.js';
import type { AttachedFile } from '../lib/filesApi.js';
import {
  EXPIRED_FILE_TEXT,
  REMOVED_FILE_TEXT,
  canRemove,
  confirmButtonText,
  confirmText,
  fileSummary,
  isExpired,
  retentionText,
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
  if (file.status === 'removed' || file.name === null) {
    return (
      <p className="file file--gone" data-testid="file-removed">
        {REMOVED_FILE_TEXT}
      </p>
    );
  }
  if (isExpired(file, now)) {
    return (
      <p className="file file--gone" data-testid="file-removed">
        {EXPIRED_FILE_TEXT}
      </p>
    );
  }
  const busy = removing === file.id;
  return (
    <article
      className="file"
      data-testid="file"
      data-file-id={file.id}
      aria-label={`Attached file ${file.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        📎
      </span>
      <div className="file__body">
        <p className="file__name" title={file.name}>
          {file.name}
        </p>
        <p className="file__meta">
          {fileSummary(file)} · {retentionText(file, now)}
        </p>
        {asking && (
          <div className="file__confirm" role="alert">
            <p>
              Remove this file? What was read from it is deleted. What the assistant has already
              said about it stays in this conversation.
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
                Remove file
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
  return (
    <article
      className={`file file--upload${stopped ? ' file--stopped' : ''}`}
      data-testid="upload"
      data-phase={item.phase}
      aria-label={`Attaching ${item.name}`}
    >
      <span className="file__icon" aria-hidden="true">
        📎
      </span>
      <div className="file__body">
        <p className="file__name" title={item.name}>
          {item.name}
        </p>
        <p className="file__meta">{formatBytes(item.byteSize)}</p>

        {status !== null && (
          <div className="file__progress">
            {percent === null ? (
              // No value: the bar is indeterminate, which is the truth before a page count exists.
              <progress className="file__bar" aria-label={`Attaching ${item.name}`} />
            ) : (
              <progress
                className="file__bar"
                max={100}
                value={percent}
                aria-label={`Attaching ${item.name}`}
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
          aria-label={`Stop attaching ${item.name}`}
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
