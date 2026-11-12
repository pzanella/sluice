// Sends a message that the app sees as if the server sent it. It does not pass through rules, and the server never sees it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { bytesToBase64, PROTOCOL_LIMITS, type InjectFailure, type InjectKind } from '../shared/protocol';
import { formatBytes, hexToBytes, visible } from './format';
import type { InjectResult, InjectTarget } from './store';
import { Select } from './select';

const encoder = new TextEncoder();
/** With no answer by then, the message was lost on the way, or the page is busy. */
const ANSWER_MS = 3000;

const FAILURE_TEXT: Record<InjectFailure, string> = {
  'no-session': 'Not sent: this session has ended.',
  'not-read': 'Not sent: the app does not read this kind of message on this session yet.',
  closed: 'Not sent: the app stopped reading this kind of message.',
  full: 'Not sent: too many messages wait for the app to read them.',
};

interface InjectProps {
  targets: InjectTarget[];
  connected: boolean;
  /** The id of the request, or null if nothing was sent. */
  onSend: (target: InjectTarget, kind: InjectKind, data: string) => number | null;
  result: (frameKey: string, injectId: number) => InjectResult | undefined;
}

export function InjectView({ targets, connected, onSend, result }: InjectProps) {
  const [key, setKey] = useState<string | null>(null);
  const [kind, setKind] = useState<InjectKind>('datagram');
  const [mode, setMode] = useState<'text' | 'hex'>('text');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ id: number; frameKey: string } | null>(null);
  const [late, setLate] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // Fixed once there is a choice, so a new session cannot take the place of the one on the screen.
  const first = targets[0]?.key;
  useEffect(() => {
    if (key === null && first !== undefined) setKey(first);
  }, [key, first]);

  if (targets.length === 0) {
    return (
      <div class="empty">
        <strong>No open session.</strong>
        Start a WebTransport session on the page. You can then send it a message here.
      </div>
    );
  }

  // A session that ended is not replaced: the page chooses when that happens, and the message would go to another one.
  const target = key === null ? targets[0] : targets.find((item) => item.key === key);
  const answer = pending === null ? undefined : result(pending.frameKey, pending.id);
  const status = pending === null || !target
    ? ''
    : answer
      ? answer.failure === null
        ? 'Queued for the app. The server knows nothing about it.'
        : FAILURE_TEXT[answer.failure]
      : late
        ? 'No answer from the page. It may be busy, or the message was lost.'
        : 'Sending.';

  const send = (): void => {
    if (!target) return;
    setKey(target.key);
    const data = mode === 'text' ? encoder.encode(value) : hexToBytes(value);
    if (!data) return setError('This is not valid hex. Use pairs of 0-9 and a-f.');
    if (data.length === 0) return setError('Write a message first. An empty message cannot be sent.');
    if (data.length > PROTOCOL_LIMITS.previewBytes) return setError(`The message must be at most ${formatBytes(PROTOCOL_LIMITS.previewBytes)}.`);
    setError('');
    const id = onSend(target, kind, bytesToBase64(data));
    if (id === null) return setError('Not sent: the panel is not connected. Try again.');
    setPending({ id, frameKey: target.frameKey });
    setLate(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLate(true), ANSWER_MS);
  };

  return (
    <div class="rules inject">
      <p class="rules-note">
        The app gets this message as if the server sent it. The server does not see it, and rules do not change it. The app must
        already read this kind of message.
      </p>
      <label class="field">
        <span>Session</span>
        <Select
          value={target?.key ?? ''}
          options={[...(target ? [] : [{ value: '', label: 'This session has ended. Choose another one.' }]), ...targets.map((item) => ({ value: item.key, label: visible(item.label) }))]}
          onChange={(value) => {
            setKey(value);
            setPending(null);
          }}
        />
      </label>
      <fieldset class="checks" aria-label="Send as">
        <legend>Send as</legend>
        <label>
          <input type="radio" name="inject-kind" checked={kind === 'datagram'} onChange={() => { setKind('datagram'); setPending(null); }} />
          Datagram
        </label>
        <label>
          <input type="radio" name="inject-kind" checked={kind === 'uni'} onChange={() => { setKind('uni'); setPending(null); }} />
          New uni stream (one message, then it closes)
        </label>
      </fieldset>
      <fieldset class="checks" aria-label="Write as">
        <legend>Write as</legend>
        <label>
          <input type="radio" name="inject-mode" checked={mode === 'text'} onChange={() => setMode('text')} />
          Text
        </label>
        <label>
          <input type="radio" name="inject-mode" checked={mode === 'hex'} onChange={() => setMode('hex')} />
          Hex
        </label>
      </fieldset>
      <textarea
        class="mono inject-text"
        aria-label="Payload"
        aria-invalid={error ? 'true' : undefined}
        value={value}
        onInput={(event) => {
          setValue(event.currentTarget.value);
          setError('');
        }}
      />
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="hold-actions">
        <button type="button" class="primary" disabled={!connected || !target} onClick={send}>
          Send to the app
        </button>
        <span class="note" role="status">
          {status}
        </span>
      </div>
    </div>
  );
}
