// The rule editor: a form built on the DSL, not free text. Saved rules apply to the site of the tab, with no reload.
import { RULE_TEMPLATES, type RuleTemplate } from './rule-templates';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_SCENARIO_BYTES, parseScenario, toScenario } from '../shared/scenario';
import { NetworkSettings } from './network';
import { TimelineSettings } from './timeline';
import { DEFAULT_CONFIG, type HoldTimeoutAction, type Rule, type RuntimeConfig, type TrafficKind } from '../shared/rules';
import { LIMITS, validateRules } from '../shared/validate';
import { visible } from './format';
import { describeDraft, draftToRule, newDraft, ruleToDraft, type DraftAction, type RuleDraft } from './rule-draft';
import { Select } from './select';

/** A rule the form can edit, or one it must keep as it is. */
type RuleItem = { kind: 'draft'; draft: RuleDraft } | { kind: 'fixed'; rule: Rule };

const toItems = (rules: Rule[]): RuleItem[] =>
  rules.map((rule) => {
    const draft = ruleToDraft(rule);
    return draft ? { kind: 'draft', draft } : { kind: 'fixed', rule };
  });

const itemId = (item: RuleItem): string => (item.kind === 'draft' ? item.draft.id : item.rule.id);

function nextId(items: RuleItem[]): string {
  const used = new Set(items.map(itemId));
  for (let n = items.length + 1; ; n++) if (!used.has(`rule-${n}`)) return `rule-${n}`;
}

const ACTIONS: { value: DraftAction; label: string }[] = [
  { value: 'drop', label: 'Drop' },
  { value: 'delay', label: 'Delay' },
  { value: 'modify-replace', label: 'Replace text' },
  { value: 'modify-set', label: 'Set payload' },
  { value: 'log', label: 'Log to the page console' },
  { value: 'hold', label: 'Hold for me to decide' },
  { value: 'stall', label: 'Stall the session' },
  { value: 'close-session', label: 'Close the session' },
  { value: 'reset-stream', label: 'Reset the stream' },
];

/** Names of the form fields, for messages. The validator names paths of the DSL. */
const FIELD_LABELS: Record<string, string> = {
  id: 'Name',
  on: 'Traffic kinds',
  contains: 'Payload contains',
  prefix: 'Payload starts with',
  regex: 'Payload matches regex',
  regexFlags: 'Payload matches regex',
  minSize: 'Min size',
  maxSize: 'Max size',
  sessionUrl: 'Session URL contains',
  track: 'MoQ track name',
  trackAlias: 'MoQT track alias',
  groupMin: 'MoQT group from',
  groupMax: 'MoQT group to',
  subgroup: 'MoQT subgroup',
  objectMin: 'MoQT object from',
  objectMax: 'MoQT object to',
  probability: 'Only this % of the time',
  delayMs: 'Delay',
  timeoutMs: 'Wait at most',
  jitterMs: 'Jitter',
  find: 'Find',
  with: 'Replace with',
  data: 'New payload',
  durationMs: 'Stall for',
  closeCode: 'Close code',
  reason: 'Reason',
  code: 'Error code',
};

interface ReadableError {
  ruleIndex: number | null;
  field: string | null;
  text: string;
}

/** The validator talks about the DSL. A person reads the labels of the form. */
function plainMessage(message: string): string {
  if (message === 'must be a finite number') return 'enter a number';
  if (message === 'must have at least 1 item(s)') return 'choose at least one';
  if (message === 'must not be above maxSize') return 'must not be above Max size';
  if (message === 'must not be above groupMax') return 'must not be above MoQT group to';
  if (message === 'must not be above objectMax') return 'must not be above MoQT object to';
  const range = /^must be between (\d+) and (\d+)$/.exec(message);
  if (range && Number(range[2]) === Number.MAX_SAFE_INTEGER) return `must be ${range[1]} or more`;
  return message;
}

/** Turns `rules[0].match.minSize: must be ...` into words for a person who does not know the DSL. */
export function readableError(error: string): ReadableError {
  const found = /^rules\[(\d+)\]([^:]*): (.*)$/.exec(error);
  if (!found) return { ruleIndex: null, field: null, text: error };
  const ruleIndex = Number(found[1]);
  const names = (found[2] ?? '').match(/[a-zA-Z]+/g) ?? [];
  const field = [...names].reverse().find((name) => FIELD_LABELS[name] !== undefined) ?? null;
  const label = field ? FIELD_LABELS[field] : null;
  const fixed: Record<string, string> = {
    probability: 'must be between 0 and 100',
    timeoutMs: `must be between ${LIMITS.holdMinMs / 1000} and ${LIMITS.holdMaxMs / 1000} seconds`,
  };
  const message = (field && fixed[field]) ?? plainMessage(found[3] ?? '');
  return { ruleIndex, field, text: `Rule ${ruleIndex + 1}${label ? `, ${label}` : ''}: ${message}` };
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  mono?: boolean;
  invalid?: boolean;
}

function TextField({ label, value, onChange, hint, mono, invalid }: TextFieldProps) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        class={mono ? 'mono' : ''}
        type="text"
        value={value}
        aria-invalid={invalid ? 'true' : undefined}
        onInput={(event) => onChange(event.currentTarget.value)}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** A MoQ track that the panel saw in this tab, with its kind from the catalog. */
export interface KnownTrack {
  name: string;
  kind: 'video' | 'audio' | 'other';
  /** The player gets it now. A catalog can list more qualities than the player takes. */
  received: boolean;
}

/** The names that a template uses stand for the first track of that kind in this tab, as each player names its tracks. */
function forThisTab(track: string, known: KnownTrack[]): string {
  const pick = (test: (item: KnownTrack) => boolean): string | undefined => (known.find((item) => item.received && test(item)) ?? known.find(test))?.name;
  if (track === 'video' || track === 'audio') return pick((item) => item.kind === track) ?? track;
  if (track === 'catalog.json') return pick((item) => item.name.includes('catalog')) ?? track;
  return track;
}

function DraftForm({ draft, onChange, invalid, known }: { draft: RuleDraft; onChange: (next: RuleDraft) => void; invalid: Set<string>; known: KnownTrack[] }) {
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void => onChange({ ...draft, [key]: value });
  const kinds: { kind: TrafficKind; label: string }[] = [
    { kind: 'datagram', label: 'Datagrams' },
    { kind: 'uni', label: 'Uni streams' },
    { kind: 'bidi', label: 'Bidi streams' },
  ];
  return (
    <div class="rule-form">
      <fieldset>
        <legend>What to do</legend>
        <label class="field">
          <span>Action</span>
          <Select id={`action-${draft.id}`} value={draft.action} options={ACTIONS} onChange={(value) => set('action', value as DraftAction)} />
        </label>
        {draft.action === 'delay' && (
          <>
            <TextField invalid={invalid.has('delayMs')} label="Delay (ms)" value={draft.delayMs} onChange={(value) => set('delayMs', value)} />
            <TextField invalid={invalid.has('jitterMs')} label="Jitter (ms)" value={draft.jitterMs} onChange={(value) => set('jitterMs', value)} hint="Adds or removes up to this many ms at random. Chunks stay in order, so a chunk can wait for the one before it. With many chunks per second, most delays get close to delay + jitter." />
          </>
        )}
        {draft.action === 'modify-replace' && (
          <>
            <TextField invalid={invalid.has('find')} label="Find" mono value={draft.find} onChange={(value) => set('find', value)} />
            <TextField invalid={invalid.has('with')} label="Replace with" mono value={draft.replaceWith} onChange={(value) => set('replaceWith', value)} />
          </>
        )}
        {draft.action === 'hold' && (
          <>
            <TextField
              invalid={invalid.has('timeoutMs')}
              label="Wait at most (seconds)"
              value={draft.holdSeconds}
              onChange={(value) => set('holdSeconds', value)}
              hint="Messages wait at the top of Rules, only while this panel is open. With no panel open, they pass at once. Later messages on the same stream or session wait behind a held one."
            />
            <label class="field">
              <span>If time runs out</span>
              <Select
                value={draft.onTimeout}
                options={[
                  { value: 'forward', label: 'Forward it' },
                  { value: 'drop', label: 'Drop it' },
                ]}
                onChange={(value) => set('onTimeout', value as HoldTimeoutAction)}
              />
            </label>
          </>
        )}
        {draft.action === 'stall' && (
          <TextField
            invalid={invalid.has('durationMs')}
            label="Stall for (seconds)"
            value={draft.stallSeconds}
            onChange={(value) => set('stallSeconds', value)}
            hint="From the first match, the app gets nothing more of this session for this time, this message too. Then all of it comes, in order. A match during a stall does not make it longer."
          />
        )}
        {draft.action === 'close-session' && (
          <>
            <TextField invalid={invalid.has('closeCode')} label="Close code" value={draft.closeCode} onChange={(value) => set('closeCode', value)} />
            <TextField
              invalid={invalid.has('reason')}
              label="Reason"
              value={draft.closeReason}
              onChange={(value) => set('closeReason', value)}
              hint="Closes the whole session at the first match, as WebTransport.close() does. The server sees it. Use it to test how the app reconnects."
            />
          </>
        )}
        {draft.action === 'reset-stream' && (
          <TextField
            invalid={invalid.has('code')}
            label="Error code (0 to 255)"
            value={draft.resetCode}
            onChange={(value) => set('resetCode', value)}
            hint="The stream of the message ends with an error for the app, and the server stream is stopped. Datagrams have no stream, so nothing happens to them."
          />
        )}
        {draft.action === 'log' && <small>Prints the payload in the console of the page, where scripts of the page may read it.</small>}
        {draft.action === 'modify-set' && (
          <TextField invalid={invalid.has('data')} label="New payload" mono value={draft.setData} onChange={(value) => set('setData', value)} />
        )}
      </fieldset>
      <fieldset>
        <legend>When (all that you fill in)</legend>
        <div class="checks">
          {kinds.map(({ kind, label }) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={draft.kinds[kind]}
                onChange={(event) => set('kinds', { ...draft.kinds, [kind]: event.currentTarget.checked })}
              />
              {label}
            </label>
          ))}
        </div>
        <label>
          Direction
          <Select
            value={draft.direction}
            options={[
              { value: 'in', label: 'What the app receives' },
              { value: 'out', label: 'What the app sends' },
              { value: 'both', label: 'Both' },
            ]}
            onChange={(value) => set('direction', value as RuleDraft['direction'])}
          />
        </label>
        <small>Datagrams can get lost or come in any order. Streams come complete and in order. Uni streams go one way, bidi streams go both ways.</small>
        <TextField invalid={invalid.has('contains')} label="Payload contains" mono value={draft.contains} onChange={(value) => set('contains', value)} />
        <TextField invalid={invalid.has('prefix')} label="Payload starts with" mono value={draft.prefix} onChange={(value) => set('prefix', value)} />
        <TextField
          invalid={invalid.has('regex')}
          label="Payload matches regex"
          mono
          value={draft.regex}
          onChange={(value) => set('regex', value)}
          hint="Tests the first 4 KiB as text. With a longer payload, a regex with $ does not match. A slow regex can hang the page. Sluice turns it off after one slow test, if the page survives it."
        />
        <div class="checks">
          <label>
            <input type="checkbox" checked={draft.ignoreCase} onChange={(event) => set('ignoreCase', event.currentTarget.checked)} />
            Ignore case in the regex
          </label>
        </div>
        <TextField invalid={invalid.has('minSize')} label="Min size (bytes)" value={draft.minSize} onChange={(value) => set('minSize', value)} />
        <TextField invalid={invalid.has('maxSize')} label="Max size (bytes)" value={draft.maxSize} onChange={(value) => set('maxSize', value)} />
        <TextField invalid={invalid.has('sessionUrl')} label="Session URL contains" mono value={draft.sessionUrl} onChange={(value) => set('sessionUrl', value)} />
        <small>MoQ fields work on whole objects, for new streams of a session that Sluice can read (IETF drafts 7 to 23, moq-lite 3 to 6). While such a rule is on, all rules see each object's payload.</small>
        <TextField
          invalid={invalid.has('track')}
          label="MoQ track name"
          mono
          value={draft.track}
          onChange={(value) => set('track', value)}
          hint={
            known.length > 0
              ? `Tracks the player gets: ${known.filter((item) => item.received).map((item) => `${item.name} (${item.kind})`).join(', ') || 'none yet'}. Empty = every track.`
              : 'The names show in Tracks once the player runs. Empty = every track.'
          }
        />
        {known.length > 0 && (
          <label>
            Pick a track
            <Select
              value=""
              options={[
                { value: '', label: 'Choose from the tracks of the player…' },
                ...known.map((item) => ({ value: item.name, label: `${item.name} (${item.kind}${item.received ? '' : ', not received now'})` })),
              ]}
              onChange={(value) => set('track', value)}
            />
          </label>
        )}
        <label>
          MoQ frame type
          <Select
            value={draft.keyframe}
            options={[
              { value: '', label: 'Any' },
              { value: 'key', label: 'Key frames only' },
              { value: 'delta', label: 'Not key frames' },
            ]}
            onChange={(value) => set('keyframe', value as RuleDraft['keyframe'])}
          />
        </label>
        {(['trackAlias', 'groupMin', 'groupMax', 'subgroup', 'objectMin', 'objectMax'] as const).map((key) => (
          <TextField key={key} invalid={invalid.has(key)} label={FIELD_LABELS[key] as string} value={draft[key]} onChange={(value) => set(key, value)} />
        ))}
        <TextField invalid={invalid.has('probability')} label="Only this % of the time" value={draft.percent} onChange={(value) => set('percent', value)} />
        <div class="checks">
          <label>
            <input type="checkbox" checked={draft.final} onChange={(event) => set('final', event.currentTarget.checked)} />
            If this rule matches, skip the rules after it
          </label>
        </div>
      </fieldset>
    </div>
  );
}

export interface RulesProps {
  /** Undefined until the page answers. Null = Sluice cannot run on it. */
  origin: string | null | undefined;
  /** Undefined until the worker answers. */
  saved: RuntimeConfig | null | undefined;
  saveError: string | null;
  connected: boolean;
  disabledRules: string[];
  ruleHits: Map<string, number>;
  /** False if nothing was sent. */
  onSave: (origin: string, config: RuntimeConfig) => boolean;
  /** Undefined until the worker answers. */
  granted?: boolean | undefined;
  /** MoQ tracks seen in this tab, so a rule can use their real names. */
  knownTracks?: KnownTrack[];
}

/** Edits that are not saved, by site. The view closes when the user looks at Messages, and they must stay. */
const unsavedEdits = new Map<string, RuleItem[]>();

export function RulesView({ origin, saved, saveError, connected, disabledRules, ruleHits, onSave, granted, knownTracks = [] }: RulesProps) {
  const [edits, setEdits] = useState<RuleItem[] | null>(() => (origin ? (unsavedEdits.get(origin) ?? null) : null));
  const [openId, setOpenId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    if (focusNext.current) document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  // A save is done only when the worker says so. A port can close after the message left.
  useEffect(() => {
    if (sent === null) return;
    if (!connected || saveError) {
      setSent(null);
      return;
    }
    if (saved !== undefined && JSON.stringify(saved?.rules ?? []) === sent) {
      setSent(null);
      setEdits(null);
      if (origin) unsavedEdits.delete(origin);
    }
  }, [saved, saveError, connected, sent, origin]);

  if (origin === undefined) {
    return (
      <div class="empty">
        <strong>Waiting for the page.</strong>
        If this page is hung by a rule, click the Sluice button in the Chrome toolbar. You can delete the rules there.
      </div>
    );
  }
  if (origin === null) {
    return (
      <div class="empty">
        <strong>This page cannot have rules.</strong>
        Sluice runs on https pages and on localhost.
      </div>
    );
  }
  // Nothing to edit yet. A save now would replace rules that have not arrived.
  if (saved === undefined && !connected) return <div class="empty">Not connected. Trying again.</div>;
  if (saved === undefined) return <div class="empty">Loading rules.</div>;

  const site: string = origin;
  const items = edits ?? toItems(saved?.rules ?? []);
  const dirty = edits !== null;

  const change = (next: RuleItem[]): void => {
    setEdits(next);
    unsavedEdits.set(site, next);
    setErrors([]);
    setSendFailed(false);
  };
  const add = (template?: RuleTemplate): void => {
    const base = { ...newDraft(nextId(items)), ...template?.draft };
    const draft = base.track ? { ...base, track: forThisTab(base.track, knownTracks) } : base;
    change([...items, { kind: 'draft', draft }]);
    setOpenId(draft.id);
    focusNext.current = `action-${draft.id}`;
  };
  const move = (index: number, step: number): void => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    if (!item) return;
    const to = index + step;
    next.splice(to, 0, item);
    change(next);
    // The button that was used can now be disabled, and a disabled button loses the focus.
    if (to === 0) focusNext.current = 'move-down-0';
    else if (to === next.length - 1) focusNext.current = `move-up-${to}`;
    else focusNext.current = `move-${step < 0 ? 'up' : 'down'}-${to}`;
  };
  const remove = (index: number): void => {
    const next = items.filter((_, i) => i !== index);
    change(next);
    focusNext.current = next.length === 0 ? 'add-rule' : `delete-${Math.min(index, next.length - 1)}`;
  };
  const save = (): void => {
    const result = validateRules(items.map((item) => (item.kind === 'draft' ? draftToRule(item.draft) : item.rule)));
    if (!result.ok) {
      setErrors(result.errors);
      const firstRule = readableError(result.errors[0] ?? '').ruleIndex;
      const failing = firstRule === null ? undefined : items[firstRule];
      if (failing) setOpenId(itemId(failing));
      return;
    }
    if (!onSave(site, { ...(saved ?? DEFAULT_CONFIG), rules: result.value })) {
      setSendFailed(true);
      return;
    }
    setSent(JSON.stringify(result.value));
    setErrors([]);
    setSendFailed(false);
    // A saved list reads better as one line per rule: Edit opens one again.
    setOpenId(null);
  };

  const exportScenario = (): void => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(toScenario(saved ?? DEFAULT_CONFIG), null, 2)], { type: 'application/json' }));
    link.href = url;
    link.download = `${site.replace(/[^a-zA-Z0-9.-]/g, '_')}.sluice-scenario.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importScenario = async (file: File): Promise<void> => {
    if (dirty) return setErrors(['Save your rule edits first: a scenario replaces all rules.']);
    if (file.size > MAX_SCENARIO_BYTES) return setErrors(['This file is too large for a scenario.']);
    const parsed = parseScenario(await file.text());
    if (!parsed.ok) return setErrors(parsed.errors.slice(0, 5));
    setErrors([]);
    if (!onSave(site, parsed.config)) setSendFailed(true);
  };

  const readable = errors.map(readableError);
  const stateText = !connected ? 'Not connected' : sent !== null ? 'Saving' : dirty || saveError ? 'Not saved' : 'Saved';

  return (
    <div class="rules">
      <header class="rules-head">
        <h2>Rules for {visible(site)}</h2>
        <span class="rules-state" role="status">
          {stateText}
        </span>
        <button type="button" onClick={exportScenario} disabled={dirty}>
          Export scenario
        </button>
        <label class="file-button">
          Import scenario
          <input
            type="file"
            accept=".json,application/json"
            disabled={!connected}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importScenario(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <Select
          aria-label="Add a rule from a template"
          value=""
          disabled={items.length >= LIMITS.rules}
          options={[{ value: '', label: 'Start from a template…' }, ...RULE_TEMPLATES.map(({ id, label }) => ({ value: id, label }))]}
          onChange={(value) => {
            const template = RULE_TEMPLATES.find(({ id }) => id === value);
            if (template) add(template);
          }}
        />
        <button id="add-rule" type="button" onClick={() => add()} disabled={items.length >= LIMITS.rules}>
          Add rule
        </button>
        <button type="button" class="primary" onClick={save} disabled={!dirty || !connected || sent !== null}>
          Save and apply
        </button>
      </header>
      <NetworkSettings site={site} saved={saved} connected={connected} onSave={onSave} />
      <TimelineSettings site={site} saved={saved} connected={connected} onSave={onSave} />
      <p class="rules-note">
        Rules run in order, on incoming data, and only the app sees the effect: the network connection (QUIC, congestion
        control) and the server do not change. On streams a chunk is not a message of the app. Rules do not reach frames of
        other sites.
      </p>
      {granted === false && (
        <p class="rules-off">
          Sluice is off for this site. To run these rules, click the Sluice button in the Chrome toolbar, turn it on, then
          reload the page. A page still running Sluice can use them until it reloads.
        </p>
      )}
      {(saveError || sendFailed) && (
        <p class="error" role="alert">
          {saveError ?? 'The rules were not sent, because the panel is not connected. Try again.'}
        </p>
      )}
      {readable.length > 0 && (
        <ul class="error" role="alert">
          {readable.map(({ text }) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {items.length === 0 && <p class="empty">No rules. A page that is open may keep old rules until you reload it.</p>}
      <ol class="rule-list">
        {items.map((item, index) => {
          const id = itemId(item);
          const hits = ruleHits.get(id) ?? 0;
          const slow = disabledRules.includes(id);
          const invalid = new Set(readable.filter((error) => error.ruleIndex === index && error.field).map((error) => error.field as string));
          return (
            <li key={id} class="rule-item">
              <div class="rule-row">
                {item.kind === 'draft' ? (
                  <label class="rule-on">
                    <input
                      type="checkbox"
                      aria-label={`Rule ${index + 1} is on`}
                      checked={item.draft.enabled}
                      onChange={(event) => {
                        const next = [...items];
                        next[index] = { kind: 'draft', draft: { ...item.draft, enabled: event.currentTarget.checked } };
                        change(next);
                      }}
                    />
                  </label>
                ) : (
                  <span class="rule-on" />
                )}
                <span class="rule-summary">
                  {item.kind === 'draft' ? visible(describeDraft(item.draft)) : `${visible(id)}: cannot be edited here`}
                  {item.kind === 'draft' && item.draft.track && knownTracks.some((track) => track.received) && !knownTracks.some((track) => track.received && track.name === item.draft.track) ? (
                    <span class="rule-warning">
                      {' '}
                      {knownTracks.some((track) => track.name === item.draft.track) ? `The player does not get "${visible(item.draft.track)}" now` : `No track "${visible(item.draft.track)}" in this tab`}: it
                      matches nothing. Tracks the player gets: {knownTracks.filter((track) => track.received).map((track) => visible(track.name)).join(', ')}.
                    </span>
                  ) : null}
                </span>
                {slow && <span class="badge dropped">turned off: too slow</span>}
                <span class="rule-hits">{hits === 1 ? '1 hit' : `${hits} hits`}</span>
                {item.kind === 'draft' && (
                  <button type="button" aria-expanded={openId === id} onClick={() => setOpenId(openId === id ? null : id)}>
                    Edit
                  </button>
                )}
                <button id={`move-up-${index}`} type="button" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button
                  id={`move-down-${index}`}
                  type="button"
                  aria-label={`Move rule ${index + 1} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button id={`delete-${index}`} type="button" aria-label={`Delete rule ${index + 1}`} onClick={() => remove(index)}>
                  Delete
                </button>
              </div>
              {item.kind === 'draft' && openId === id && (
                <DraftForm
                  known={knownTracks}
                  draft={item.draft}
                  invalid={invalid}
                  onChange={(draft) => {
                    const next = [...items];
                    next[index] = { kind: 'draft', draft };
                    change(next);
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
