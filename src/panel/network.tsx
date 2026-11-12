// Simulated network of a site: a profile, a seed, the order of datagrams. Saved apart from the rules, so unsaved rule edits stay.
import { useEffect, useRef, useState } from 'preact/hooks';
import { IMPAIRMENT_PROFILES, profileOf, withProfile } from '../shared/profiles';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../shared/rules';
import { validateConfig } from '../shared/validate';
import { Select } from './select';

const CUSTOM = 'custom';

interface Props {
  site: string;
  saved: RuntimeConfig | null;
  connected: boolean;
  onSave: (origin: string, config: RuntimeConfig) => boolean;
}

export function NetworkSettings({ site, saved, connected, onSave }: Props) {
  const config = saved ?? DEFAULT_CONFIG;
  const savedProfile = profileOf(config) ?? CUSTOM;
  const savedSeed = config.seed === undefined ? '' : String(config.seed);
  const savedOrder = config.datagram.preserveOrder;
  const [profile, setProfile] = useState(savedProfile);
  const [seed, setSeed] = useState(savedSeed);
  const [keepOrder, setKeepOrder] = useState(savedOrder);
  const [error, setError] = useState('');

  // What is saved can change from outside: the toolbar popup, a reload of the rules.
  // Not on mount: effects run a little late, and this would erase what the user just typed.
  const savedKey = `${savedProfile} ${savedSeed} ${savedOrder}`;
  const lastKey = useRef(savedKey);
  useEffect(() => {
    if (lastKey.current === savedKey) return;
    lastKey.current = savedKey;
    setProfile(savedProfile);
    setSeed(savedSeed);
    setKeepOrder(savedOrder);
  }, [savedKey, savedProfile, savedSeed, savedOrder]);

  const dirty = profile !== savedProfile || seed !== savedSeed || keepOrder !== savedOrder;

  const apply = (): void => {
    const base = withProfile(config, profile);
    const text = seed.trim();
    const next: RuntimeConfig = { ...base, datagram: { ...base.datagram, preserveOrder: keepOrder } };
    if (text === '') delete next.seed;
    else next.seed = Number(text);
    const result = validateConfig(next);
    if (!result.ok) {
      setError(text === '' ? 'These settings are not valid.' : 'The seed must be a whole number from 0 to 4294967295.');
      return;
    }
    setError(onSave(site, result.value) ? '' : 'The settings were not sent, because the panel is not connected. Try again.');
  };

  return (
    <fieldset class="network">
      <legend>Simulated network</legend>
      <label>
        Profile
        <Select
          value={profile}
          options={[...(savedProfile === CUSTOM ? [{ value: CUSTOM, label: 'Custom values' }] : []), ...IMPAIRMENT_PROFILES.map((p) => ({ value: p.id, label: p.label }))]}
          onChange={setProfile}
        />
      </label>
      <label>
        Seed
        <input type="text" inputMode="numeric" value={seed} aria-invalid={error !== ''} onInput={(event) => setSeed(event.currentTarget.value)} />
      </label>
      <label class="network-check">
        <input type="checkbox" checked={keepOrder} onChange={(event) => setKeepOrder(event.currentTarget.checked)} />
        Keep datagram order
      </label>
      <button type="button" onClick={apply} disabled={!dirty || !connected}>
        Apply network
      </button>
      {/* Not `error && ...`: an empty string is a text node that Preact writes on each render, and Chromium then closes an open select (ADR-32). */}
      {error !== '' ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}
      <small>
        Only the app sees this. Delay applies to all traffic, loss only to datagrams. A cap in kbit/s makes each session a link of that rate: chunks wait their turn,
        datagrams that would wait more than 1 s are lost, and the browser reads the network more slowly, so the server slows down too. With a seed, the same message gets the same decision in each run, but on a stream
        the network can cut chunks in a different way. With order kept, jitter makes datagrams wait for each other, so the mean delay is higher.
      </small>
    </fieldset>
  );
}
