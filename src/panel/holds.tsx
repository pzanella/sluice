// The held messages: the user forwards, edits or drops each one before its time runs out. The page has the timer, so
// the countdown here is only a display (ADR-16).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { bytesToBase64, PROTOCOL_LIMITS } from '../shared/protocol';
import { decodePreview, formatBytes, hexToBytes, toHex, toText, visible, visibleLines } from './format';
import type { HoldRow } from './store';

export type HoldAction = { action: 'forward' | 'drop'; data: null } | { action: 'edit'; data: string };

interface EditState {
  key: string;
  mode: 'text' | 'hex';
  value: string;
  error: string;
}

const encoder = new TextEncoder();

/** Text only if the bytes survive the trip, and no character is invisible. An edit box must show what it would send. */
function showsAsText(bytes: Uint8Array): boolean {
  const text = toText(bytes);
  const same = encoder.encode(text);
  return same.length === bytes.length && same.every((byte, i) => byte === bytes[i]) && visibleLines(text) === text;
}

function startEdit(row: HoldRow, bytes: Uint8Array): EditState {
  const isText = showsAsText(bytes);
  return { key: row.key, mode: isText ? 'text' : 'hex', value: isText ? toText(bytes) : toHex(bytes, false), error: '' };
}

/** A row decided once, until the page announces it again: a decision lost in a restart must be possible to repeat. */
const sentKey = (row: HoldRow): string => `${row.key}#${row.announced}`;

const secondsLeft = (row: HoldRow, now: number): number => Math.max(0, Math.ceil((row.deadline - now) / 1000));

export function HoldView({ rows, onResolve }: { rows: HoldRow[]; onResolve: (row: HoldRow, action: HoldAction) => boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const hasRows = rows.length > 0;
  // A row that left is not replaced for an action: the page can end a hold, and a key press must not hit the next one.
  const row = selected === null ? rows[0] : rows.find((item) => item.key === selected);
  const at = row ? rows.indexOf(row) : -1;
  const payload = row?.data;
  const bytes = useMemo(() => decodePreview(payload ?? ''), [payload]);
  const text = useMemo(() => visibleLines(toText(bytes)), [bytes]);
  const hexView = useMemo(() => toHex(bytes), [bytes]);

  useEffect(() => {
    if (!hasRows) return undefined;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [hasRows]);

  if (!hasRows) {
    return (
      <p class="hold-empty">
        <strong>Nothing is held.</strong> Messages that match a rule with the action "Hold for me to decide" wait here while this panel is open.
      </p>
    );
  }

  const complete = row !== undefined && bytes.length === row.byteLength;
  const editing = row && edit?.key === row.key ? edit : null;
  const isSent = row !== undefined && sent.has(sentKey(row));

  const select = (key: string): void => {
    setFailed(false);
    setSelected(key);
  };
  const resolve = (action: HoldAction): void => {
    if (!row || isSent) return;
    if (!onResolve(row, action)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setSent(new Set([...sent, sentKey(row)]));
    setEdit(null);
    // Its own choice moves on to the next row. With none, the next one to come is selected: on a stream it comes only now.
    setSelected((rows[at + 1] ?? rows[at - 1])?.key ?? null);
    document.getElementById('hold-list')?.focus();
  };
  const openEdit = (): void => {
    if (!row || !complete || isSent) return;
    setFailed(false);
    setEdit(startEdit(row, bytes));
    setTimeout(() => document.getElementById('hold-edit')?.focus(), 0);
  };
  const sendEdit = (state: EditState): void => {
    const data = state.mode === 'text' ? encoder.encode(state.value) : hexToBytes(state.value);
    if (!data) return setEdit({ ...state, error: 'This is not valid hex. Use pairs of 0-9 and a-f.' });
    if (data.length === 0) return setEdit({ ...state, error: 'An empty message cannot be sent. Use Drop.' });
    if (data.length > PROTOCOL_LIMITS.previewBytes) {
      return setEdit({ ...state, error: `The message must be at most ${formatBytes(PROTOCOL_LIMITS.previewBytes)}.` });
    }
    resolve({ action: 'edit', data: bytesToBase64(data) });
  };
  const switchMode = (state: EditState, mode: 'text' | 'hex'): void => {
    if (mode === state.mode) return;
    if (mode === 'hex') return setEdit({ ...state, mode, value: toHex(encoder.encode(state.value), false), error: '' });
    const data = hexToBytes(state.value);
    if (!data) return setEdit({ ...state, error: 'This is not valid hex, so it cannot be shown as text.' });
    if (!showsAsText(data)) return setEdit({ ...state, error: 'These bytes would change as text. Stay in hex.' });
    setEdit({ ...state, mode, value: toText(data), error: '' });
  };
  const onListKey = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.key);
    } else if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
      // A held key must not drain the list.
      return;
    } else if (key === 'f') {
      resolve({ action: 'forward', data: null });
    } else if (key === 'd') {
      resolve({ action: 'drop', data: null });
    } else if (key === 'e') {
      event.preventDefault();
      openEdit();
    }
  };

  return (
    <div class="main hold-view">
      <div
        id="hold-list"
        class="hold-list"
        role="listbox"
        tabIndex={0}
        aria-label="Held messages. F forwards, E edits, D drops."
        aria-activedescendant={at >= 0 ? `hold-${at}` : undefined}
        onKeyDown={onListKey}
      >
        {rows.map((item, i) => (
          <div
            key={item.key}
            id={`hold-${i}`}
            class="hold-row"
            role="option"
            aria-selected={i === at}
            onClick={() => select(item.key)}
          >
            <span class="badge held">held</span>
            <span class="kind">
              {item.streamId === null ? item.kind : `${item.kind} #${item.streamId}`}
              {item.workerId === null ? '' : `, worker ${item.workerId}`}
            </span>
            <span class="size">{formatBytes(item.byteLength)}</span>
            <span class="hold-time">
              {sent.has(sentKey(item)) ? 'sent' : `${secondsLeft(item, now)} s, then ${item.onTimeout}`}
            </span>
          </div>
        ))}
      </div>
      {!row ? (
        <div class="empty detail-empty">This message is gone: it was sent, or its time ran out. Select another one.</div>
      ) : (
      <div class="hold-detail">
        <div class="hold-actions">
          <button type="button" class="primary" disabled={isSent} onClick={() => resolve({ action: 'forward', data: null })}>
            Forward
          </button>
          <button type="button" disabled={isSent || !complete} aria-expanded={editing !== null} onClick={openEdit}>
            Edit
          </button>
          <button type="button" disabled={isSent} onClick={() => resolve({ action: 'drop', data: null })}>
            Drop
          </button>
          <span class="note">
            Rule {visible(row.ruleId)}. Message {row.seq}.{' '}
            {complete ? '' : `Too large to edit: this is the first ${formatBytes(bytes.length)} of ${formatBytes(row.byteLength)}. `}
            {row.kind === 'datagram' ? 'Later datagrams of this session wait behind it.' : 'Later data of this stream waits behind it.'}
          </span>
        </div>
        {failed && (
          <p class="error" role="alert">
            Not sent: the panel lost its connection. If it stays lost, Sluice will do the timeout action.
          </p>
        )}
        {editing ? (
          <div class="hold-editor">
            <div class="checks" role="radiogroup" aria-label="Edit as">
              {(['text', 'hex'] as const).map((mode) => (
                <label key={mode}>
                  <input type="radio" name="hold-mode" checked={editing.mode === mode} onChange={() => switchMode(editing, mode)} />
                  {mode === 'text' ? 'Text' : 'Hex'}
                </label>
              ))}
            </div>
            <textarea
              id="hold-edit"
              class="mono"
              aria-label="New payload"
              aria-invalid={editing.error ? 'true' : undefined}
              value={editing.value}
              onInput={(event) => setEdit({ ...editing, value: event.currentTarget.value, error: '' })}
            />
            {editing.error && (
              <p class="error" role="alert">
                {editing.error}
              </p>
            )}
            <div class="hold-actions">
              <button type="button" class="primary" disabled={isSent} onClick={() => sendEdit(editing)}>
                Forward edited
              </button>
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setEdit(null);
                  document.getElementById('hold-list')?.focus();
                }}
              >
                Cancel edit
              </button>
            </div>
          </div>
        ) : (
          <div class="payload" tabIndex={0} aria-label="Held payload">
            <pre class="wrap">{text}</pre>
            <pre>{hexView}</pre>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
