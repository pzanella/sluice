// Timeline of a site: steps in time from the open of each session, such as "at 10 s a mobile network, at 30 s a stall" (ADR-47).
// Saved apart from the rules, as the simulated network is.
import { useEffect, useRef, useState } from 'preact/hooks';
import { IMPAIRMENT_PROFILES } from '../shared/profiles';
import { DEFAULT_CONFIG, type RuntimeConfig, type TimelineStep } from '../shared/rules';
import { LIMITS, validateConfig } from '../shared/validate';
import { Select } from './select';

interface Props {
  site: string;
  saved: RuntimeConfig | null;
  connected: boolean;
  onSave: (origin: string, config: RuntimeConfig) => boolean;
}

type StepKind = 'network' | 'stall' | 'close-session';

interface StepDraft {
  key: number;
  at: string;
  kind: StepKind;
  /** A profile ID, or `custom` for values that no profile has. */
  profile: string;
  custom: { dropRate: number; delayMs: number; jitterMs: number; kbps?: number } | null;
  stall: string;
  code: string;
  reason: string;
}

let nextKey = 0;
const CUSTOM = 'custom';

const draftOf = (step: TimelineStep): StepDraft => {
  const base: StepDraft = { key: ++nextKey, at: String(step.atMs / 1000), kind: step.action.type, profile: 'mobile', custom: null, stall: '3', code: '0', reason: 'Closed by Sluice' };
  const { action } = step;
  if (action.type === 'stall') return { ...base, stall: String(action.durationMs / 1000) };
  if (action.type === 'close-session') return { ...base, code: String(action.closeCode), reason: action.reason };
  const profile = IMPAIRMENT_PROFILES.find((p) => p.dropRate === action.dropRate && p.delayMs === action.delayMs && p.jitterMs === action.jitterMs && p.kbps === action.kbps);
  return profile
    ? { ...base, profile: profile.id }
    : { ...base, profile: CUSTOM, custom: { dropRate: action.dropRate, delayMs: action.delayMs, jitterMs: action.jitterMs, ...(action.kbps === undefined ? {} : { kbps: action.kbps }) } };
};

const stepOf = (draft: StepDraft): TimelineStep => {
  const atMs = Math.round(Number(draft.at) * 1000);
  if (draft.kind === 'stall') return { atMs, action: { type: 'stall', durationMs: Math.round(Number(draft.stall) * 1000) } };
  if (draft.kind === 'close-session') return { atMs, action: { type: 'close-session', closeCode: Number(draft.code), reason: draft.reason } };
  const values = draft.profile === CUSTOM && draft.custom ? draft.custom : (IMPAIRMENT_PROFILES.find((p) => p.id === draft.profile) ?? IMPAIRMENT_PROFILES[0]);
  const kbps = values?.kbps;
  return { atMs, action: { type: 'network', dropRate: values?.dropRate ?? 0, delayMs: values?.delayMs ?? 0, jitterMs: values?.jitterMs ?? 0, ...(kbps === undefined ? {} : { kbps }) } };
};

/** A first timeline to change: a network that gets worse, a stall, a recovery, then a close. */
const EXAMPLE: TimelineStep[] = [
  { atMs: 10_000, action: { type: 'network', dropRate: 0.01, delayMs: 50, jitterMs: 20 } },
  { atMs: 30_000, action: { type: 'stall', durationMs: 5000 } },
  { atMs: 45_000, action: { type: 'network', dropRate: 0.1, delayMs: 300, jitterMs: 150 } },
  { atMs: 60_000, action: { type: 'network', dropRate: 0, delayMs: 0, jitterMs: 0 } },
  { atMs: 90_000, action: { type: 'close-session', closeCode: 0, reason: 'Closed by the Sluice timeline' } },
];

export function TimelineSettings({ site, saved, connected, onSave }: Props) {
  const config = saved ?? DEFAULT_CONFIG;
  const savedText = JSON.stringify(config.timeline ?? []);
  const [drafts, setDrafts] = useState<StepDraft[]>(() => (config.timeline ?? []).map(draftOf));
  const [error, setError] = useState('');
  const last = useRef(savedText);
  // What is saved can change from outside, such as an imported scenario. Not on mount, so typing is never lost.
  useEffect(() => {
    if (last.current === savedText) return;
    last.current = savedText;
    setDrafts((config.timeline ?? []).map(draftOf));
  }, [savedText]);

  const steps = drafts.map(stepOf);
  const dirty = JSON.stringify(steps) !== savedText;
  const change = (key: number, patch: Partial<StepDraft>): void => setDrafts(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  const apply = (): void => {
    const next: RuntimeConfig = { ...config };
    if (steps.length === 0) delete next.timeline;
    else next.timeline = [...steps].sort((a, b) => a.atMs - b.atMs);
    const result = validateConfig(next);
    if (!result.ok) {
      setError('A step is not valid. Times are seconds from 0 to 86400, a stall is from 0.001 to 120 s, and a close code is a whole number.');
      return;
    }
    setError(onSave(site, result.value) ? '' : 'The timeline was not sent, because the panel is not connected. Try again.');
  };

  return (
    <fieldset class="network timeline">
      <legend>Timeline</legend>
      {drafts.length === 0 ? <p class="hint">No steps. Each new session runs the timeline from its open.</p> : null}
      <ol class="timeline-steps">
        {drafts.map((draft, index) => (
          <li key={draft.key}>
            <label>
              At (s)
              <input type="number" min="0" step="1" value={draft.at} onInput={(event) => change(draft.key, { at: event.currentTarget.value })} />
            </label>
            <label>
              Do
              <Select
                aria-label="Do"
                value={draft.kind}
                options={[
                  { value: 'network', label: 'Set the network' },
                  { value: 'stall', label: 'Stall the session' },
                  { value: 'close-session', label: 'Close the session' },
                ]}
                onChange={(value) => change(draft.key, { kind: value as StepKind })}
              />
            </label>
            {draft.kind === 'network' ? (
              <label>
                Network
                <Select
                  aria-label="Network"
                  value={draft.profile}
                  options={[...(draft.custom ? [{ value: CUSTOM, label: 'Custom values' }] : []), ...IMPAIRMENT_PROFILES.map((p) => ({ value: p.id, label: p.label }))]}
                  onChange={(value) => change(draft.key, { profile: value })}
                />
              </label>
            ) : draft.kind === 'stall' ? (
              <label>
                For (s)
                <input type="number" min="0.1" max="120" step="0.5" value={draft.stall} onInput={(event) => change(draft.key, { stall: event.currentTarget.value })} />
              </label>
            ) : (
              <>
                <label>
                  Code
                  <input type="number" min="0" value={draft.code} onInput={(event) => change(draft.key, { code: event.currentTarget.value })} />
                </label>
                <label>
                  Reason
                  <input type="text" maxLength={200} value={draft.reason} onInput={(event) => change(draft.key, { reason: event.currentTarget.value })} />
                </label>
              </>
            )}
            <button type="button" aria-label={`Delete step ${index + 1}`} onClick={() => setDrafts(drafts.filter((item) => item.key !== draft.key))}>
              Delete
            </button>
          </li>
        ))}
      </ol>
      <div class="timeline-actions">
        <button
          type="button"
          disabled={drafts.length >= LIMITS.timelineSteps}
          onClick={() => {
            const lastAt = Math.max(0, ...drafts.map((draft) => Number(draft.at) || 0));
            setDrafts([...drafts, draftOf({ atMs: (lastAt + 10) * 1000, action: { type: 'stall', durationMs: 3000 } })]);
          }}
        >
          Add step
        </button>
        <button type="button" onClick={() => setDrafts(EXAMPLE.map(draftOf))}>
          Use the example
        </button>
        <button type="button" class="primary" onClick={apply} disabled={!dirty || !connected}>
          Apply timeline
        </button>
      </div>
      {error !== '' ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}
      <small>
        Times count from the open of each session, so a player that reconnects runs it again. A new timeline applies to the next session. Steps show in the Monitor.
        A network step replaces the simulated network for that session. Only the app sees it.
      </small>
    </fieldset>
  );
}
