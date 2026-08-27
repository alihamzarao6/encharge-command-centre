/**
 * Notes the assistant wrote for itself: every ten messages it summarises what a stretch of a
 * conversation was about, and those summaries are what a later conversation can draw on.
 * Nobody asked for them, so they are second here, and everything about the presentation says
 * "this is what it noticed", not "this is what you told it".
 *
 * They come from real conversations and can contain a client's name or a figure. The page
 * does three things about that and no more: it says so in plain words at the top; it shows a
 * preview rather than the whole note, so a screen in a café gives less away and the list is
 * scannable; and Delete really deletes. Automatic redaction is deliberately absent — it would
 * mangle the notes and, worse, make the warning feel unnecessary.
 */
import { useState, type ReactElement } from 'react';

import type { MemoryChunkView } from '../lib/memoryView.js';

interface Props {
  readonly chunks: readonly MemoryChunkView[];
  readonly busy: string | null;
  readonly hasMore: boolean;
  readonly onShowMore: () => void;
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onDelete: (chunkId: string) => Promise<void>;
}

function ChunkCard({
  chunk,
  busy,
  onOpenConversation,
  onDelete,
}: {
  readonly chunk: MemoryChunkView;
  readonly busy: boolean;
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onDelete: (chunkId: string) => Promise<void>;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const truncated = chunk.preview !== chunk.summary;

  return (
    <li className="card mem__card">
      <div className="mem__card-head">
        <h3 className="mem__chunk-title">
          {chunk.conversationTitle ?? 'A conversation that has since been removed'}
        </h3>
      </div>
      <p className="muted mem__meta">
        {chunk.when}
        {chunk.audience !== null && chunk.audience !== '' ? ` · for ${chunk.audience}` : ''}
        {chunk.byYou ? '' : ' · from a teammate'}
      </p>
      <p className="mem__value">{expanded ? chunk.summary : chunk.preview}</p>
      {truncated && (
        <button
          className="link mem__link"
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((open) => !open);
          }}
        >
          {expanded ? 'Show less' : 'Read the whole note'}
        </button>
      )}

      {confirming ? (
        <div className="notice mem__confirm" role="alert">
          <p>
            Delete this note? The assistant stops using it straight away and the text is removed.
            This one cannot be undone. The conversation itself is not touched.
          </p>
          <div className="mem__row">
            <button
              className="button button--small mem__danger"
              type="button"
              disabled={busy}
              onClick={() => {
                void onDelete(chunk.id).then(() => {
                  setConfirming(false);
                });
              }}
            >
              {busy ? 'Deleting…' : 'Delete it'}
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="mem__row mem__actions">
          {chunk.conversationTitle !== null && (
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                onOpenConversation(chunk.conversationId);
              }}
            >
              Open conversation
            </button>
          )}
          {chunk.canRemove && (
            <button
              className="link mem__link mem__link--danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function MemoryChunks({
  chunks,
  busy,
  hasMore,
  onShowMore,
  onOpenConversation,
  onDelete,
}: Props): ReactElement {
  return (
    <div className="mem__pane">
      <p className="muted mem__hint mem__warning">
        These are written automatically from real conversations, so one can mention a client, a
        figure or something said in passing. Everyone who uses the Command Centre can read them.
      </p>
      {chunks.length === 0 ? (
        <p className="muted mem__none">
          Nothing yet. After about ten messages in a conversation, the assistant writes a short note
          about what it was for, and it appears here.
        </p>
      ) : (
        <>
          <ul className="mem__list">
            {chunks.map((chunk) => (
              <ChunkCard
                key={chunk.id}
                chunk={chunk}
                busy={busy === chunk.id}
                onOpenConversation={onOpenConversation}
                onDelete={onDelete}
              />
            ))}
          </ul>
          {hasMore && (
            <button className="button button--block" type="button" onClick={onShowMore}>
              Show older notes
            </button>
          )}
        </>
      )}
    </div>
  );
}
