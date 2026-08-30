/**
 * The Team page (Stage 3 part 4). Who can use the Command Centre, and — for an
 * administrator — how to add someone, take their access away, give it back, and hand out a
 * password when one is lost.
 *
 * Everyone allowlisted sees the page, and that is deliberate. A shared brain (D33) with a
 * hidden membership list is a strange thing: memory says "added by a teammate", the client
 * asks who, and the only answer is to ring the developer. So the roster is readable by every
 * active member (migration 20260828010000 widened exactly that far and no further) and
 * non-admins get the list, plainly labelled read-only, with no controls at all — not
 * disabled controls, which read as "you did something wrong", but none.
 *
 * Every CHANGE goes to the admin Edge Function, which verifies the caller against the same
 * rules this file imports (src/lib/auth/access.ts). The browser holds SELECT and nothing
 * else, so that is not a convention here either — it is the only thing that works.
 *
 * THE PASSWORD. It arrives once, lives in React state, and is shown on a panel the admin has
 * to dismiss. It is never written to storage, never put in the URL, never logged. A refresh
 * loses it, which is exactly what the words on the panel promise.
 */
import type { Session } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import {
  ONE_TIME_PASSWORD_HANDOVER,
  ONE_TIME_PASSWORD_PROMISE,
  STAFF_EMAIL_MAX_CHARS,
  type StaffActor,
} from '../../../src/lib/auth/access.js';
import { browserClipboardDeps, copyText } from '../lib/clipboard.js';
import { webConfig } from '../lib/env.js';
import { supabase } from '../lib/supabase.js';
import {
  callUsers,
  type SignInRecord,
  type UsersOutcome,
  type UsersRequest,
} from '../lib/usersApi.js';
import {
  buildRoster,
  statusLabel,
  type AppUserRow,
  type StaffMemberView,
} from '../lib/usersView.js';

interface Props {
  readonly session: Session;
  readonly staff: AppUserRow;
  readonly onSessionExpired: () => Promise<void>;
}

type Banner = { readonly tone: 'ok' | 'warn'; readonly text: string } | null;

/** The one-time password, held only here and only until it is dismissed. */
interface Handover {
  readonly email: string;
  readonly password: string;
  readonly isReset: boolean;
}

export function Users({ session, staff, onSessionExpired }: Props): ReactElement {
  const actor: StaffActor = useMemo(
    () => ({ userId: staff.user_id, isAdmin: staff.is_admin }),
    [staff.user_id, staff.is_admin],
  );
  const [rows, setRows] = useState<readonly AppUserRow[]>([]);
  const [signIns, setSignIns] = useState<readonly SignInRecord[]>([]);
  const [signInsKnown, setSignInsKnown] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [handover, setHandover] = useState<Handover | null>(null);

  const call = useCallback(
    async (request: UsersRequest): Promise<UsersOutcome> => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token ?? session.access_token;
      return callUsers(
        {
          adminUrl: webConfig.adminUrl,
          anonKey: webConfig.anonKey,
          fetch: fetch.bind(globalThis),
        },
        accessToken,
        request,
      );
    },
    [session.access_token],
  );

  const load = useCallback(async (): Promise<void> => {
    const roster = await supabase
      .from('app_users')
      .select('user_id, email, role, is_active, is_admin, created_at')
      .order('email', { ascending: true })
      .limit(500);
    if (roster.error !== null) {
      setState('error');
      return;
    }
    setRows(roster.data);
    setState('ready');
    // Sign-in times are admin-only and come from GoTrue, which RLS cannot reach. A failure
    // here degrades the column to "—"; it never stops the page from showing the roster.
    if (!actor.isAdmin) return;
    const seen = await call({ action: 'sign_ins' });
    if (seen.kind === 'ok' && seen.reply.action === 'sign_ins') {
      setSignIns(seen.reply.signIns);
      setSignInsKnown(true);
    }
  }, [actor.isAdmin, call]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One change, with the outcome turned into one sentence and the list reloaded. */
  const run = useCallback(
    async (request: UsersRequest, key: string): Promise<UsersOutcome> => {
      setBusy(key);
      setBanner(null);
      const outcome = await call(request);
      setBusy(null);
      if (outcome.kind === 'error') {
        if (outcome.failure === 'unauthenticated') {
          await onSessionExpired();
          return outcome;
        }
        setBanner({ tone: 'warn', text: outcome.message });
        // Refused because the list moved under them (someone else is administering too).
        if (outcome.failure === 'refused') await load();
        return outcome;
      }
      await load();
      return outcome;
    },
    [call, load, onSessionExpired],
  );

  const onAdd = useCallback(
    async (email: string): Promise<boolean> => {
      const outcome = await run({ action: 'create', email }, 'add');
      if (outcome.kind !== 'ok' || outcome.reply.action !== 'create') return false;
      setHandover({
        email: outcome.reply.email,
        password: outcome.reply.oneTimePassword,
        isReset: false,
      });
      return true;
    },
    [run],
  );

  const onReset = useCallback(
    async (member: StaffMemberView): Promise<void> => {
      const outcome = await run({ action: 'reset_password', userId: member.userId }, member.userId);
      if (outcome.kind !== 'ok' || outcome.reply.action !== 'reset_password') return;
      setHandover({
        email: outcome.reply.email,
        password: outcome.reply.oneTimePassword,
        isReset: true,
      });
    },
    [run],
  );

  const onFlag = useCallback(
    async (
      member: StaffMemberView,
      action: 'deactivate' | 'reactivate' | 'promote' | 'demote',
    ): Promise<void> => {
      const outcome = await run({ action, userId: member.userId }, member.userId);
      if (outcome.kind !== 'ok') return;
      const reply = outcome.reply;
      // Only the four flag replies carry an outcome; a password reply or a sign-in list here
      // would mean the server answered a question nobody asked, and is not this handler's.
      if (!('outcome' in reply)) return;
      if (reply.outcome === 'unchanged') {
        setBanner({ tone: 'ok', text: 'That was already the case. Nothing changed.' });
        return;
      }
      const SAID: Readonly<Record<typeof action, string>> = {
        deactivate: `${reply.email} can no longer sign in. Everything they taught the assistant stays.`,
        reactivate: `${reply.email} can sign in again with the password they already had.`,
        promote: `${reply.email} can now add and remove people.`,
        demote: `${reply.email} can no longer add or remove people.`,
      };
      setBanner({ tone: 'ok', text: SAID[action] });
    },
    [run],
  );

  const roster = useMemo(
    () => buildRoster(rows, actor, signIns, signInsKnown),
    [rows, actor, signIns, signInsKnown],
  );

  return (
    <section className="team" aria-labelledby="team-title">
      <div className="team__bar">
        <h1 id="team-title" className="team__title">
          Team
        </h1>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={() => {
            void load();
          }}
        >
          Refresh
        </button>
      </div>

      {handover !== null && (
        <PasswordHandover
          handover={handover}
          onDone={() => {
            setHandover(null);
          }}
        />
      )}

      {banner !== null && handover === null && (
        <p className={banner.tone === 'ok' ? 'team__banner' : 'notice team__banner'} role="status">
          {banner.text}
        </p>
      )}

      {state === 'loading' && <p className="muted team__none">Loading…</p>}
      {state === 'error' && (
        <p className="error team__none" role="alert">
          Couldn&rsquo;t load the team.{' '}
          <button
            className="link"
            type="button"
            onClick={() => {
              void load();
            }}
          >
            Try again
          </button>
        </p>
      )}

      {state === 'ready' && (
        <>
          {actor.isAdmin ? (
            <AddUserForm busy={busy === 'add'} onAdd={onAdd} />
          ) : (
            <p className="muted team__hint">
              Everyone here can use the Command Centre, and everything the assistant is taught is
              shared between them. Only an administrator can add someone or change their access —
              ask one of the people marked <strong>Administrator</strong> below.
            </p>
          )}

          <p className="muted team__count">
            {String(roster.activeCount)} with access
            {roster.inactiveCount > 0 ? `, ${String(roster.inactiveCount)} without` : ''} ·{' '}
            {String(roster.activeAdmins)} administrator
            {roster.activeAdmins === 1 ? '' : 's'}
          </p>

          <ul className="team__list">
            {roster.members.map((member) => (
              <MemberCard
                key={member.userId}
                member={member}
                canManage={actor.isAdmin}
                showLastSeen={signInsKnown}
                busy={busy === member.userId}
                onFlag={onFlag}
                onReset={onReset}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The one-time password, handed over. There is no email sender configured and adding one is
 * a scope conversation, so the honest design is a screen that says exactly what this is,
 * makes it one tap to copy, and refuses to pretend it can be recovered.
 */
function PasswordHandover({
  handover,
  onDone,
}: {
  readonly handover: Handover;
  readonly onDone: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card team__handover" role="alertdialog" aria-labelledby="team-handover-title">
      <h2 id="team-handover-title" className="team__handover-title">
        {handover.isReset ? 'New password for' : 'Account created for'} {handover.email}
      </h2>
      <p className="team__handover-value">
        <code>{handover.password}</code>
      </p>
      <div className="mem__row">
        <button
          className="button button--primary button--small"
          type="button"
          onClick={() => {
            void copyText(browserClipboardDeps(), handover.password).then(setCopied);
          }}
        >
          {copied ? 'Copied' : 'Copy password'}
        </button>
      </div>
      <p className="team__handover-promise">
        <strong>{ONE_TIME_PASSWORD_PROMISE}</strong>
      </p>
      <p className="muted">{ONE_TIME_PASSWORD_HANDOVER}</p>
      <p className="muted">
        They sign in at this same address with their email and this password. They can use the
        assistant and everything it remembers straight away.
      </p>
      <button className="button button--block" type="button" onClick={onDone}>
        Done — I&rsquo;ve handed it over
      </button>
    </div>
  );
}

function AddUserForm({
  busy,
  onAdd,
}: {
  readonly busy: boolean;
  readonly onAdd: (email: string) => Promise<boolean>;
}): ReactElement {
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed === '' || busy) return;
    void onAdd(trimmed).then((added) => {
      if (added) {
        setEmail('');
        setOpen(false);
      }
    });
  };

  if (!open) {
    return (
      <button
        className="button button--primary button--block team__add-open"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        + Add someone
      </button>
    );
  }

  return (
    <form className="card team__add" onSubmit={submit}>
      <label className="field__label" htmlFor="team-add">
        Their work email address
      </label>
      <input
        id="team-add"
        className="field__input"
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={STAFF_EMAIL_MAX_CHARS}
        value={email}
        placeholder="name@fundd.com.au"
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <p className="muted team__hint">
        A password is generated and shown to you once, on the next screen. You hand it over —
        nothing is emailed, and it cannot be looked up later.
      </p>
      <div className="mem__row">
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || email.trim() === ''}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setEmail('');
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

type Pending = 'deactivate' | 'reactivate' | 'promote' | 'demote' | 'reset_password' | null;

/** What each confirm step says. Every sentence is a consequence, not a restatement. */
const CONFIRMS: Readonly<Record<Exclude<Pending, null>, { verb: string; says: string }>> = {
  deactivate: {
    verb: 'Remove access',
    says: 'They are signed out and cannot sign back in. Nothing they taught the assistant is removed — that is the whole team’s, and it stays. You can give their access back at any time.',
  },
  reactivate: {
    verb: 'Restore access',
    says: 'They can sign in again straight away, with the password they already had.',
  },
  promote: {
    verb: 'Make administrator',
    // Since D72 an administrator canNOT remove another administrator's access — they have to
    // remove their administrator rights first. The old sentence promised "remove anyone's
    // access", which is no longer true, and a confirm step that overstates what it is handing
    // over is the worst place to be wrong.
    says: 'They will be able to add people, remove a member’s access and reset anyone’s password — including yours. To remove another administrator’s access they would have to remove their administrator rights first.',
  },
  demote: {
    verb: 'Remove administrator',
    says: 'They keep their own access and everything else. They will no longer be able to add or remove people.',
  },
  reset_password: {
    verb: 'Reset password',
    says: 'Their current password stops working immediately. A new one is shown to you once, and you hand it over.',
  },
};

function MemberCard({
  member,
  canManage,
  showLastSeen,
  busy,
  onFlag,
  onReset,
}: {
  readonly member: StaffMemberView;
  readonly canManage: boolean;
  readonly showLastSeen: boolean;
  readonly busy: boolean;
  readonly onFlag: (
    member: StaffMemberView,
    action: 'deactivate' | 'reactivate' | 'promote' | 'demote',
  ) => Promise<void>;
  readonly onReset: (member: StaffMemberView) => Promise<void>;
}): ReactElement {
  const [pending, setPending] = useState<Pending>(null);
  const offered = (
    ['reactivate', 'promote', 'demote', 'reset_password', 'deactivate'] as const
  ).filter((action) => canManage && member.can[action]);

  const confirm = (action: Exclude<Pending, null>): void => {
    if (action === 'reset_password') void onReset(member);
    else void onFlag(member, action);
    setPending(null);
  };

  return (
    <li className={`card team__card${member.isActive ? '' : ' team__card--inactive'}`}>
      <div className="team__card-head">
        <span className="team__email" title={member.email}>
          {member.email}
        </span>
        {member.isYou && <span className="badge">You</span>}
      </div>
      <p className="muted team__meta">
        {statusLabel(member)} · added {member.addedOn}
        {showLastSeen ? ` · last signed in ${member.lastSeen}` : ''}
      </p>

      {pending !== null && (
        <div className="notice team__confirm" role="alert">
          <p>{CONFIRMS[pending].says}</p>
          <div className="mem__row">
            <button
              className={`button button--small${pending === 'deactivate' ? ' mem__danger' : ''}`}
              type="button"
              disabled={busy}
              onClick={() => {
                confirm(pending);
              }}
            >
              {busy ? 'Working…' : CONFIRMS[pending].verb}
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending === null && offered.length > 0 && (
        <div className="mem__row team__actions">
          {offered.map((action) => (
            <button
              key={action}
              className={`link mem__link${action === 'deactivate' ? ' mem__link--danger' : ''}`}
              type="button"
              disabled={busy}
              onClick={() => {
                setPending(action);
              }}
            >
              {CONFIRMS[action].verb}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
