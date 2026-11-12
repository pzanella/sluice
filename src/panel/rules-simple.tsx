// The simple Rules view (ADR-55): what is on now, network presets, one-click tests with a switch, and the rules of the user.
// Every change applies at once. The advanced view edits the same rules.
import { useEffect, useRef, useState } from 'preact/hooks';
import { IMPAIRMENT_PROFILES, profileOf, withProfile } from '../shared/profiles';
import type { PanelConnectionAction } from '../shared/protocol';
import type { Rule, RuntimeConfig } from '../shared/rules';
import { DEFAULT_CONFIG } from '../shared/rules';
import { visible } from './format';
import { GaugeIcon, ICONS } from './icons';
import { QUICK_PREFIX, QUICK_TESTS, paramsOf, type QuickGroup, type QuickParams, type QuickTest } from './quick-tests';
import { describeDraft, ruleToDraft } from './rule-draft';
import type { KnownTrack } from './rules';
import { Select } from './select';

interface SimpleRulesProps {
  site: string;
  saved: RuntimeConfig | null;
  connected: boolean;
  ruleHits: Map<string, number>;
  onSave: (origin: string, config: RuntimeConfig) => boolean;
  knownTracks: KnownTrack[];
  /** What the sessions of the tab carry, to say what the network does to them. */
  traffic: { datagrams: boolean; streams: boolean };
  onAdvanced: () => void;
  /** Runs an action once on the newest open session. Null when no session is open. */
  runNow: ((action: PanelConnectionAction) => boolean) | null;
}

const GROUPS: readonly QuickGroup[] = ['Video', 'Audio and sync', 'Connection', 'Content'];

function NetworkIcon({ id, kbps }: { id: string; kbps: number | undefined }) {
  if (kbps !== undefined) return <GaugeIcon level={Math.min(1, Math.log10(kbps / 100) / 2.2)} />;
  const icon = ICONS[id] ?? ICONS.none;
  return icon ? icon() : null;
}

const rate = (kbps: number): string => (kbps >= 1000 ? `${kbps / 1000} Mbit/s` : `${kbps} kbit/s`);

function networkEffect(config: RuntimeConfig, traffic: SimpleRulesProps['traffic']): string {
  const { datagram, stream, bandwidth } = config;
  if (datagram.dropRate === 0 && datagram.delayMs === 0 && stream.delayMs === 0 && !bandwidth) return 'The app gets the real network.';
  const parts: string[] = [];
  const delay = Math.max(stream.delayMs, datagram.delayMs);
  if (delay > 0) parts.push(`everything comes ${delay} ms later (± ${Math.max(stream.jitterMs, datagram.jitterMs)} ms)`);
  if (bandwidth) parts.push(`each session gets at most ${rate(bandwidth.kbps)}`);
  if (datagram.dropRate > 0) {
    const loss = `${Math.round(datagram.dropRate * 1000) / 10}%`;
    parts.push(traffic.datagrams || !traffic.streams ? `${loss} of datagrams are lost` : `${loss} of datagrams would be lost, but your sessions use streams only, which QUIC never loses`);
  }
  const text = parts.join(', ');
  const hint = !bandwidth && traffic.streams && !traffic.datagrams ? ' A player with a buffer may show nothing here: a bandwidth cap is what makes it struggle.' : '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.${hint}`;
}

/** The tracks that a test can use, the ones the player gets first. */
function tracksFor(kind: QuickTest['track'], known: KnownTrack[]): KnownTrack[] {
  const fit = known.filter((track) => (kind === 'catalog' ? track.name.includes('catalog') : kind === 'any' ? true : track.kind === kind));
  return [...fit.filter((track) => track.received), ...fit.filter((track) => !track.received)];
}

function QuickCard({
  test,
  rule,
  hits,
  known,
  disabled,
  onChange,
  runNow,
}: {
  test: QuickTest;
  rule: Rule | undefined;
  hits: number;
  known: KnownTrack[];
  disabled: boolean;
  onChange: (rule: Rule | null) => void;
  runNow: ((action: PanelConnectionAction) => boolean) | null;
}) {
  const [note, setNote] = useState('');
  const on = rule !== undefined && rule.enabled !== false;
  const tracks = test.track === 'any' ? [] : tracksFor(test.track, known);
  const fallback = tracks[0]?.name ?? '';
  const initial = (): QuickParams => (rule ? paramsOf(test, rule) : { track: fallback, value: test.slider?.initial ?? 0 });
  const [params, setParams] = useState<QuickParams>(initial);
  // The saved rule can change elsewhere (Advanced, another panel): show what runs.
  const ruleKey = rule ? JSON.stringify(rule) : '';
  useEffect(() => {
    if (rule) setParams(paramsOf(test, rule));
  }, [ruleKey]);
  // A track name appears once the player runs: take it if none was chosen.
  useEffect(() => {
    if (!params.track && fallback) setParams((current) => ({ ...current, track: fallback }));
  }, [fallback]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const update = (next: QuickParams): void => {
    setParams(next);
    if (!on) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(test.build(next)), 300);
  };
  // With no track a MoQ test would act on every stream, the catalog too: it waits for the player.
  const needsTrack = test.track !== 'any' && !params.track;
  const Icon = ICONS[test.id];
  return (
    <article class={`quick-card ${on ? 'on' : ''}`} aria-label={test.title}>
      <header>
        <span class="quick-icon">{Icon ? Icon() : null}</span>
        <div class="quick-title">
          <h3>{test.title}</h3>
          <p class="quick-expect">{test.expect}</p>
        </div>
        <label class="switch" title={needsTrack && !on ? 'Start the player first, so Sluice knows its tracks.' : undefined}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`${test.title} on`}
            checked={on}
            disabled={disabled || (needsTrack && !on)}
            onChange={(event) => onChange(event.currentTarget.checked ? test.build(params) : null)}
          />
          <span class="switch-track" aria-hidden="true" />
        </label>
      </header>
      {on ? (
        <div class="quick-controls">
          {test.track !== 'any' ? (
            <label class="quick-field">
              <span>Track</span>
              <Select
                value={params.track}
                options={[
                  ...(params.track && !tracks.some((track) => track.name === params.track) ? [{ value: params.track, label: visible(params.track) }] : []),
                  ...tracks.map((track) => ({ value: track.name, label: `${visible(track.name)}${track.received ? '' : ' (not received now)'}` })),
                ]}
                onChange={(value) => update({ ...params, track: value })}
              />
            </label>
          ) : null}
          {test.slider ? (
            <label class="quick-field">
              <span>
                {test.slider.label}
                <b>{test.slider.unit === '%' ? `${params.value}%` : `${params.value} ${test.slider.unit}`}</b>
              </span>
              <input
                type="range"
                min={test.slider.min}
                max={test.slider.max}
                step={test.slider.step}
                value={params.value}
                onInput={(event) => update({ ...params, value: Number(event.currentTarget.value) })}
              />
            </label>
          ) : null}
          <span class={`quick-hits ${hits > 0 ? 'live' : ''}`}>
            {hits === 0 ? 'Waiting for a match…' : hits === 1 ? '1 match' : `${hits} matches`}
          </span>
        </div>
      ) : needsTrack ? (
        <p class="quick-wait">Start the player first: Sluice needs to see its tracks.</p>
      ) : null}
      {test.now ? (
        <div class="quick-now">
          <button
            type="button"
            disabled={disabled || !runNow}
            title={runNow ? 'Once, now, on the newest open session of this tab' : 'Start the player first: there is no open session.'}
            onClick={() => {
              const run = test.now?.(params);
              if (!run || !runNow) return;
              setNote(runNow(run.action) ? run.done : 'Not sent: the panel is not connected. Try again.');
            }}
          >
            Run once now
          </button>
          <span class="quick-note" role="status">
            {note}
          </span>
        </div>
      ) : null}
    </article>
  );
}

export function SimpleRules({ site, saved, connected, ruleHits, onSave, knownTracks, traffic, onAdvanced, runNow }: SimpleRulesProps) {
  // Shown at once, before the saved copy comes back.
  const [pending, setPending] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState('');
  const config = pending ?? saved ?? DEFAULT_CONFIG;
  // Each save comes back as a new saved copy, written again by the validator: from then on, it is the truth. With two quick
  // clicks, the copy of the first save must not hide the second one: the shown copy waits for the last save to come back.
  const unanswered = useRef(0);
  useEffect(() => {
    unanswered.current = Math.max(0, unanswered.current - 1);
    if (unanswered.current === 0) setPending(null);
  }, [saved]);
  // A slider saves a moment later: it must build on what is shown then, not on what was shown when it moved.
  const latest = useRef(config);
  latest.current = config;

  const save = (next: RuntimeConfig): void => {
    latest.current = next;
    setPending(next);
    const sent = onSave(site, next);
    if (sent) unanswered.current++;
    setError(sent ? '' : 'Not sent: the panel is not connected. Try again.');
  };
  const setRule = (id: string, rule: Rule | null): void => {
    const current = latest.current;
    const rules = current.rules.filter((item) => item.id !== id);
    if (rule) {
      const at = current.rules.findIndex((item) => item.id === id);
      rules.splice(at >= 0 ? at : rules.length, 0, rule);
    }
    save({ ...current, rules });
  };
  const profile = profileOf(config);
  const profileName = IMPAIRMENT_PROFILES.find((p) => p.id === profile)?.label.replace(/\s*\(.*\)$/, '') ?? 'Custom';
  const quickOn = QUICK_TESTS.filter((test) => config.rules.some((rule) => rule.id === `${QUICK_PREFIX}${test.id}` && rule.enabled !== false));
  const others = config.rules.filter((rule) => !rule.id.startsWith(QUICK_PREFIX));
  const othersOn = others.filter((rule) => rule.enabled !== false);
  const anything = profile !== 'none' || config.rules.some((rule) => rule.enabled !== false) || (config.timeline?.length ?? 0) > 0;

  return (
    <div class="simple-rules">
      <div class={`now-strip ${anything ? 'active' : ''}`} role="status">
        <span class="now-dot" aria-hidden="true" />
        <span class="now-text">
          {anything ? (
            <>
              <b>Active:</b> network <b>{profileName}</b>
              {quickOn.length > 0 ? ` · ${quickOn.map((test) => test.title).join(', ')}` : ''}
              {othersOn.length > 0 ? ` · ${othersOn.length} of your rules` : ''}
              {config.timeline?.length ? ` · a timeline of ${config.timeline.length} steps` : ''}
            </>
          ) : (
            'Nothing is changed: the app gets the real network.'
          )}
        </span>
        {anything ? (
          <button
            type="button"
            disabled={!connected}
            onClick={() => {
              const next = withProfile({ ...config, rules: config.rules.map((rule) => ({ ...rule, enabled: false })) }, 'none');
              delete next.timeline;
              // Quick tests go; rules of the user stay, turned off.
              next.rules = next.rules.filter((rule) => !rule.id.startsWith(QUICK_PREFIX));
              save(next);
            }}
          >
            Turn all off
          </button>
        ) : null}
      </div>

      <section class="simple-section">
        <div class="section-head">
          <h2>Network</h2>
          <p class="hint">Only the app sees it: the server and QUIC do not change.</p>
        </div>
        <div class="network-presets" role="radiogroup" aria-label="Simulated network">
          {IMPAIRMENT_PROFILES.map((p, index) => {
            const open = p.label.indexOf('(');
            const name = open > 0 ? p.label.slice(0, open).trim() : p.label;
            const detail = open > 0 ? p.label.slice(open + 1, -1) : 'the real network';
            const first = index === 0 || (p.kbps !== undefined && IMPAIRMENT_PROFILES[index - 1]?.kbps === undefined);
            return [
              first ? (
                <span key={`group-${p.id}`} class="preset-group">
                  {p.kbps === undefined ? 'Delay and loss' : 'Bandwidth cap: less than the player needs'}
                </span>
              ) : null,
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={profile === p.id}
                class={`preset ${profile === p.id ? 'on' : ''}`}
                disabled={!connected}
                onClick={() => save(withProfile(config, p.id))}
              >
                <span class="preset-icon">
                  <NetworkIcon id={p.id} kbps={p.kbps} />
                </span>
                <span class="preset-name">{name}</span>
                <span class="preset-detail">{detail}</span>
              </button>,
            ];
          })}
          {profile === null ? (
            <button type="button" role="radio" aria-checked class="preset on" onClick={onAdvanced}>
              <span class="preset-icon">{ICONS.custom ? ICONS.custom() : null}</span>
              <span class="preset-name">Custom</span>
              <span class="preset-detail">change it in Advanced</span>
            </button>
          ) : null}
        </div>
        <p class="network-effect">{networkEffect(config, traffic)}</p>
      </section>

      <section class="simple-section">
        <div class="section-head">
          <h2>Quick tests</h2>
          <p class="hint">Turn one on, then watch the player and the Monitor.</p>
        </div>
        {GROUPS.map((group) => (
          <div key={group} class="quick-group">
            <span class="preset-group">{group}</span>
            <div class="quick-grid">
              {QUICK_TESTS.filter((test) => test.group === group).map((test) => (
                <QuickCard
                  key={test.id}
                  test={test}
                  rule={config.rules.find((rule) => rule.id === `${QUICK_PREFIX}${test.id}`)}
                  hits={ruleHits.get(`${QUICK_PREFIX}${test.id}`) ?? 0}
                  known={knownTracks}
                  disabled={!connected}
                  onChange={(rule) => setRule(`${QUICK_PREFIX}${test.id}`, rule)}
                  runNow={runNow}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section class="simple-section">
        <div class="section-head">
          <h2>Your rules</h2>
          <p class="hint">
            {others.length === 0 ? 'None yet. ' : 'Turn a rule off to keep it for later. '}
            <button type="button" class="link" onClick={onAdvanced}>
              {others.length === 0 ? 'Build one in Advanced' : 'Edit them in Advanced'}
            </button>
          </p>
        </div>
        {others.length > 0 ? (
          <ul class="active-rules">
            {others.map((rule) => {
              const draft = ruleToDraft(rule);
              const hits = ruleHits.get(rule.id) ?? 0;
              const on = rule.enabled !== false;
              return (
                <li key={rule.id} class={on ? '' : 'off'}>
                  <label class="switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Rule ${rule.id} on`}
                      checked={on}
                      disabled={!connected}
                      onChange={(event) => {
                        const next = { ...rule };
                        if (event.currentTarget.checked) delete next.enabled;
                        else next.enabled = false;
                        setRule(rule.id, next);
                      }}
                    />
                    <span class="switch-track" aria-hidden="true" />
                  </label>
                  <span class="active-summary">{draft ? visible(describeDraft({ ...draft, enabled: true })) : visible(rule.id)}</span>
                  <span class={`quick-hits ${hits > 0 && on ? 'live' : ''}`}>{hits === 1 ? '1 match' : `${hits} matches`}</span>
                  <button type="button" class="ghost" aria-label={`Delete rule ${rule.id}`} disabled={!connected} onClick={() => setRule(rule.id, null)}>
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      {error !== '' ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
