// Sessions: the picker of the top bar, the sidebar of Messages, and workers that are not inspected.
import { visible, hostAndPath } from './format';
import { type WorkerSkipReason } from '../shared/protocol';
import { type Scope, type SessionRow } from './store';
import { store } from './panel-state';
import { Select } from './select';

const SKIP_TEXT: Record<WorkerSkipReason, string> = {
  csp: 'The security policy (CSP) of the page blocks how Sluice starts workers',
  starting: 'It started before Sluice knew if the security policy (CSP) allows it. Reload to try again',
  'blob-url': 'It starts from a blob: URL',
  'data-url': 'It starts from a data: URL',
  limit: 'The page has too many workers',
  refused: 'The browser refused the script with Sluice in it',
};

/** Real text, not a tooltip: a keyboard or a screen reader must reach the reason. It counts scripts: workers of one URL are one entry. */
export function SkippedWorkers() {
  const { size } = store.skippedWorkers;
  if (size === 0) return null;
  return (
    <details class="skipped">
      <summary>{size === 1 ? '1 worker script is not inspected' : `${size} worker scripts are not inspected`}</summary>
      <ul>
        {Array.from(store.skippedWorkers, ([key, { url, reason }]) => (
          <li key={key}>
            {SKIP_TEXT[reason]}: {visible(url)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function sessionState(session: SessionRow): string {
  if (!session.closed) return 'open';
  return session.closed.closeCode === null ? 'closed with error' : `closed (${session.closed.closeCode})`;
}

/** A server opens many uni streams on a live session (with MoQ, about one for each group of each track), so they stay folded. */
const STREAM_GROUPS = [
  { kind: 'bidi', origin: null, label: 'Bidi streams', hint: 'Two-way streams. With MoQ they usually carry control messages, such as subscribe.' },
  { kind: 'uni', origin: 'local', label: 'Uni streams sent', hint: 'One-way streams that the app opened.' },
  { kind: 'uni', origin: 'remote', label: 'Uni streams', hint: 'One-way streams that the server opened. With MoQ they usually carry media. The number is a counter of Sluice, not the QUIC stream ID.' },
] as const;

/**
 * What the session picker shows. By default the open sessions, so a player that starts again leaves its closed sessions out of view.
 * With no open session, all of them: an app with short sessions still shows its traffic.
 */
export type SessionChoice = 'open' | 'all' | string;

export function chosenSessions(choice: SessionChoice): SessionRow[] {
  const all = Array.from(store.sessions.values());
  if (choice === 'all') return all;
  if (choice !== 'open') {
    const session = store.sessions.get(choice);
    if (session) return [session];
  }
  const open = all.filter((session) => !session.closed);
  return open.length > 0 ? open : all;
}

const sessionLabel = (session: SessionRow): string =>
  `${hostAndPath(session.url)} #${session.sessionId}${session.workerId !== null ? `, worker ${session.workerId}` : ''}${session.moqt ? `, ${session.moqt}` : ''}`;

export function SessionPicker({ choice, onChoice }: { choice: SessionChoice; onChoice: (choice: SessionChoice) => void }) {
  const all = Array.from(store.sessions.values()).reverse();
  const open = all.filter((session) => !session.closed);
  const closed = all.filter((session) => session.closed);
  const value = choice === 'open' || choice === 'all' || store.sessions.has(choice) ? choice : 'open';
  return (
    <label class="session-pick">
      Session
      <Select
        value={value}
        options={[
          { value: 'open', label: 'Open sessions' },
          { value: 'all', label: 'All sessions' },
          ...open.map((session) => ({ value: session.key, label: sessionLabel(session), group: 'Open' })),
          ...closed.map((session) => ({ value: session.key, label: `${sessionLabel(session)}, ${sessionState(session)}`, group: 'Closed' })),
        ]}
        onChange={onChoice}
      />
    </label>
  );
}

export function Sidebar({ scope, onScope, sessions, hidden, onShowAll }: { scope: Scope; onScope: (scope: Scope) => void; sessions: SessionRow[]; hidden: number; onShowAll: () => void }) {
  const isOn = (sessionKey: string, stream: number | 'datagram' | null): boolean =>
    scope?.sessionKey === sessionKey && scope.stream === stream;
  const all = sessions;
  const open = all.filter((session) => !session.closed);
  // Newest first: a player that starts again leaves many closed sessions behind.
  const closed = all.filter((session) => session.closed).reverse();
  // Folded only when they would push open sessions down, or make a long list.
  const fold = closed.length > 0 && (open.length > 0 || closed.length > 3);
  const sessionItem = (session: SessionRow) => (
          <li key={session.key}>
            <button
              type="button"
              class="session"
              title={`${hostAndPath(session.url)} (${session.workerUrl === null ? `frame ${session.frameId}` : `worker ${visible(session.workerUrl)}`}, ${sessionState(session)})`}
              aria-pressed={isOn(session.key, null)}
              onClick={() => onScope({ sessionKey: session.key, stream: null })}
            >
              <span class="session-name">{hostAndPath(session.url)}</span>
              <span class="session-state">
                {session.moqt && `${session.moqt}, `}
                {session.workerId !== null && `worker ${session.workerId}, `}
                {sessionState(session)}
              </span>
            </button>
            <ul>
              {session.hasDatagrams && (
                <li>
                  <button
                    type="button"
                    class="child"
                    aria-pressed={isOn(session.key, 'datagram')}
                    onClick={() => onScope({ sessionKey: session.key, stream: 'datagram' })}
                  >
                    datagrams
                  </button>
                </li>
              )}
              {STREAM_GROUPS.map(({ kind, origin, label, hint }) => {
                // Newest first: on a live stream, the one that is moving is the one to look at.
                const streams = Array.from(session.streams.values()).filter((stream) => stream.kind === kind && (origin === null || (origin === 'local') === (stream.origin === 'local'))).reverse();
                if (streams.length === 0) return null;
                const holdsScope = streams.some((stream) => isOn(session.key, stream.streamId));
                return (
                  <li key={label}>
                    <details class="stream-group" open={holdsScope || undefined}>
                      <summary title={hint}>
                        {label} ({streams.length})
                      </summary>
                      <ul>
                        {streams.map((stream) => (
                          <li key={stream.streamId}>
                            <button
                              type="button"
                              class="child"
                              aria-pressed={isOn(session.key, stream.streamId)}
                              onClick={() => onScope({ sessionKey: session.key, stream: stream.streamId })}
                            >
                              {stream.kind} #{stream.streamId}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                );
              })}
            </ul>
          </li>
  );
  return (
    <nav class="sidebar" aria-label="Sessions and streams">
      <ul>
        <li>
          <button type="button" aria-pressed={scope === null} onClick={() => onScope(null)}>
            {sessions.length === 1 ? 'All of this session' : 'All sessions'}
          </button>
        </li>
        {open.map(sessionItem)}
        {fold ? null : closed.map(sessionItem)}
        {fold ? (
          <li>
            <details class="stream-group closed-sessions" open={closed.some((session) => scope?.sessionKey === session.key) || undefined}>
              <summary>Closed sessions ({closed.length})</summary>
              <ul>{closed.map(sessionItem)}</ul>
              <button
                type="button"
                class="child"
                onClick={() => {
                  if (scope && closed.some((session) => session.key === scope.sessionKey)) onScope(null);
                  store.removeClosed();
                }}
              >
                Remove closed sessions
              </button>
            </details>
          </li>
        ) : null}
        {hidden > 0 ? (
          <li>
            <button type="button" class="child" onClick={onShowAll}>
              Show {hidden} closed {hidden === 1 ? 'session' : 'sessions'}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
