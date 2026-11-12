// The Rules view: simple (presets and one-click tests) or advanced (the full editor). The choice is kept per viewer (ADR-55).
import type { ComponentChildren } from 'preact';
import type { PanelConnectionAction } from '../shared/protocol';
import { useState } from 'preact/hooks';
import { RulesView, type RulesProps } from './rules';
import { SimpleRules } from './rules-simple';

type RulesMode = 'simple' | 'advanced';
const MODE_KEY = 'sluice.rules.mode';

function loadMode(): RulesMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

export function RulesPage(
  props: RulesProps & {
    traffic: { datagrams: boolean; streams: boolean };
    held: ComponentChildren;
    heldCount: number;
    /** Runs a stall or a close once on the newest open session (quick tests). Null when no session is open. */
    runNow: ((action: PanelConnectionAction) => boolean) | null;
  },
) {
  const [mode, setMode] = useState<RulesMode>(loadMode);
  const choose = (next: RulesMode): void => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // No storage here: the choice lasts while the panel is open.
    }
  };
  const { origin, saved, connected, held, heldCount } = props;
  return (
    <div class="rules-page">
      {/* Held messages: always in Advanced, and in Simple only when one waits. */}
      {mode === 'advanced' || heldCount > 0 ? held : null}
      <div class="mode-bar">
        <div class="segmented" role="radiogroup" aria-label="Rules view">
          <button type="button" role="radio" aria-checked={mode === 'simple'} onClick={() => choose('simple')}>
            Simple
          </button>
          <button type="button" role="radio" aria-checked={mode === 'advanced'} onClick={() => choose('advanced')}>
            Advanced
          </button>
        </div>
        <span class="hint">
          {mode === 'simple' ? 'Presets and quick tests. Changes apply at once.' : 'The full editor: rules, timeline, seed, scenarios. Save to apply.'}
        </span>
      </div>
      {mode === 'advanced' || !origin || saved === undefined ? (
        <RulesView {...props} />
      ) : (
        <SimpleRules
          site={origin}
          saved={saved}
          connected={connected}
          ruleHits={props.ruleHits}
          onSave={props.onSave}
          knownTracks={props.knownTracks ?? []}
          traffic={props.traffic}
          onAdvanced={() => choose('advanced')}
          runNow={props.runNow}
        />
      )}
    </div>
  );
}
