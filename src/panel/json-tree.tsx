// A JSON value as a tree to explore. All of it comes from the page, so it is only shown as text. Children are made only when a node is open, so a large value costs little.
import { useState } from 'preact/hooks';
import { visible } from './format';

const MAX_CHILDREN = 1000;
/** Levels open at the start. */
const OPEN_LEVELS = 2;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isBranch = (value: Json): value is Json[] | { [key: string]: Json } => typeof value === 'object' && value !== null;

function Leaf({ value }: { value: Exclude<Json, Json[] | { [key: string]: Json }> }) {
  if (typeof value === 'string') return <span class="json-string">"{visible(value)}"</span>;
  return <span class={value === null ? 'json-null' : typeof value === 'number' ? 'json-number' : 'json-boolean'}>{String(value)}</span>;
}

function Node({ name, value, level, allOpen }: { name: string | null; value: Json; level: number; allOpen: { open: boolean; turn: number } }) {
  const [state, setState] = useState<{ open: boolean; turn: number } | null>(null);
  const label = name === null ? null : <span class="json-key">{visible(name)}: </span>;
  if (!isBranch(value)) {
    return (
      <div class="json-line">
        {label}
        <Leaf value={value} />
      </div>
    );
  }
  // A choice of the user holds until the next Expand all or Collapse all.
  const open = state && state.turn === allOpen.turn ? state.open : allOpen.turn === 0 ? level < OPEN_LEVELS : allOpen.open;
  const array = Array.isArray(value);
  const entries: [string, Json][] = array ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  return (
    <details
      class="json-node"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) setState({ open: next, turn: allOpen.turn });
      }}
    >
      <summary>
        {label}
        <span class="json-type">{array ? `array (${entries.length})` : `object (${entries.length})`}</span>
      </summary>
      {open && (
        <div class="json-children">
          {entries.slice(0, MAX_CHILDREN).map(([key, item]) => (
            <Node key={key} name={key} value={item} level={level + 1} allOpen={allOpen} />
          ))}
          {entries.length > MAX_CHILDREN && <div class="json-line json-type">{entries.length - MAX_CHILDREN} more not shown</div>}
        </div>
      )}
    </details>
  );
}

export function JsonTree({ text }: { text: string }) {
  const [allOpen, setAllOpen] = useState({ open: false, turn: 0 });
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return <pre class="wrap">{visible(text)}</pre>;
  }
  return (
    <div class="json-tree">
      {isBranch(value) && (
        <div class="json-actions">
          <button type="button" onClick={() => setAllOpen({ open: true, turn: allOpen.turn + 1 })}>
            Expand all
          </button>
          <button type="button" onClick={() => setAllOpen({ open: false, turn: allOpen.turn + 1 })}>
            Collapse all
          </button>
        </div>
      )}
      <Node name={null} value={value} level={0} allOpen={allOpen} />
    </div>
  );
}
