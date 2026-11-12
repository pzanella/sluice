// The message list and the detail of one message.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { decodePreview, looksBinary, formatBytes, formatTime, listTarget, toHex, toJson, toText, visible, visibleLines } from './format';
import { JsonTree } from './json-tree';
import { type MessageRow } from './store';

const ROW_HEIGHT = 22;

function RowText({ preview }: { preview: string }) {
  const bytes = decodePreview(preview);
  if (looksBinary(bytes)) return <span class="text hex">{toHex(bytes.subarray(0, 24), false).replace(/\n/g, ' ')}</span>;
  return <span class="text">{visible(toText(bytes).slice(0, 200))}</span>;
}

function Row(props: { row: MessageRow; index: number; total: number; selected: boolean; onSelect: () => void }) {
  const { row, index, total, selected, onSelect } = props;
  const { item } = row;
  return (
    <div
      id={`row-${row.n}`}
      class="row"
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      style={{ top: `${index * ROW_HEIGHT}px` }}
      onClick={onSelect}
    >
      <span class="time">{formatTime(item.at)}</span>
      <span class={`kind kind-${item.outgoing ? 'out' : item.kind}`} title={item.outgoing ? 'Sent by the app' : 'Received by the app'}>
        <span aria-hidden="true">{item.outgoing ? '↑' : '↓'}</span> {item.streamId === null ? item.kind : `${item.kind} #${item.streamId}`}
      </span>
      <span class="size">{formatBytes(item.byteLength)}</span>
      {item.outgoing && <span class="badge outgoing">sent</span>}
      {item.moqt && (
        <span class={`badge object${item.moqt.key ? ' key' : ''}`}>
          {item.moqt.key && 'key '}
          {item.moqt.track !== undefined && `${visible(item.moqt.track)} `}group {item.moqt.group} {/* IETF objects have a subgroup; moq-lite frames do not. */ item.moqt.subgroup === null && item.kind !== 'datagram' ? 'frame' : 'object'} {item.moqt.object}
        </span>
      )}
      {item.outcome === 'dropped' && <span class="badge dropped">dropped</span>}
      {item.modified && <span class="badge modified">modified</span>}
      {item.injected && <span class="badge injected">injected</span>}
      {item.delayMs > 0 && <span class="badge delayed">+{Math.round(item.delayMs)} ms</span>}
      <RowText preview={item.preview} />
    </div>
  );
}

export function MessageList({ rows, selected, onSelect }: { rows: MessageRow[]; selected: number | null; onSelect: (n: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => {
      // A list that gets smaller must keep the newest rows in view, or it stops following them.
      if (element.scrollTop + lastClientHeight.current >= element.scrollHeight - ROW_HEIGHT) element.scrollTop = element.scrollHeight;
      lastClientHeight.current = element.clientHeight;
      setView({ top: element.scrollTop, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // New rows keep the list at the bottom, unless the user scrolled up to read. This reads the real position against the
  // old height, because a scroll event comes later and would lose to a new row.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wasAtBottom = element.scrollTop + element.clientHeight >= lastHeight.current - ROW_HEIGHT;
    if (wasAtBottom) element.scrollTop = element.scrollHeight;
    lastHeight.current = element.scrollHeight;
  }, [rows.length]);

  const onScroll = (): void => {
    const element = ref.current;
    if (!element) return;
    setView({ top: element.scrollTop, height: element.clientHeight });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const element = ref.current;
    const pageRows = Math.max(1, Math.floor((element?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const index = listTarget(event.key, rows.findIndex((row) => row.n === selected), rows.length, pageRows);
    if (index === null) return;
    event.preventDefault();
    const next = rows[index];
    if (!next) return;
    onSelect(next.n);
    if (!element) return;
    if (index * ROW_HEIGHT < element.scrollTop) element.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = (index + 1) * ROW_HEIGHT - element.clientHeight;
    }
  };

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - 5);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + 5);
  const selectedIndex = selected === null ? -1 : rows.findIndex((row) => row.n === selected);
  return (
    <div
      ref={ref}
      class="list"
      role="listbox"
      tabIndex={0}
      aria-label="Messages"
      // Only a row that exists: the list renders the rows in view.
      aria-activedescendant={selectedIndex >= first && selectedIndex < last ? `row-${selected}` : undefined}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
        {rows.slice(first, last).map((row, i) => (
          <Row key={row.n} row={row} index={first + i} total={rows.length} selected={row.n === selected} onSelect={() => onSelect(row.n)} />
        ))}
      </div>
    </div>
  );
}

const DETAIL_TABS = [
  { id: 'hex', label: 'Hex' },
  { id: 'text', label: 'Text' },
  { id: 'json', label: 'JSON' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];

export function Detail({ row }: { row: MessageRow | null }) {
  // Until the user picks one: hex for a binary payload, such as a media frame, and text for the rest.
  const [picked, setTab] = useState<DetailTab | null>(null);
  const bytes = useMemo(() => (row ? decodePreview(row.item.preview) : null), [row]);
  const tab: DetailTab = picked ?? (bytes && looksBinary(bytes) ? 'hex' : 'text');
  // Not at each render: a large payload is slow here, and traffic renders 5 times per second.
  const json = useMemo(() => (tab === 'json' && bytes ? toJson(bytes) : null), [tab, bytes]);
  const jsonText = useMemo(() => (json?.ok ? visibleLines(json.text) : ''), [json]);
  if (!row || !bytes) return <div class="empty detail-empty">Select a message to see its payload.</div>;

  const { item } = row;
  const cut = bytes.length < item.byteLength;

  const onTabKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const at = DETAIL_TABS.findIndex(({ id }) => id === tab);
    const step = event.key === 'ArrowRight' ? 1 : DETAIL_TABS.length - 1;
    const next = DETAIL_TABS[(at + step) % DETAIL_TABS.length];
    if (next) {
      setTab(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  };

  return (
    <div class="detail">
      <div class="tabs">
        <div role="tablist" aria-label="Payload format" class="tablist" onKeyDown={onTabKey}>
          {DETAIL_TABS.map(({ id, label }) => (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="payload"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span class="note">
          {item.outcome === 'dropped' ? 'The app did not get this. ' : ''}
          {cut ? `First ${formatBytes(bytes.length)} of ${formatBytes(item.byteLength)}. ` : ''}
          Seq {item.seq}.{' '}
          {item.moqt
            ? `MoQ object payload: ${item.moqt.track === undefined ? '' : `track ${visible(item.moqt.track)}, `}track alias ${item.moqt.trackAlias}, group ${item.moqt.group}${item.moqt.subgroup === null ? '' : `, subgroup ${item.moqt.subgroup}`}, object ${item.moqt.object}.`
            : item.kind === 'datagram'
              ? ''
              : 'A chunk is not a message of the app.'}
        </span>
      </div>
      <div id="payload" class="payload" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'hex' && <pre>{toHex(bytes)}</pre>}
        {tab === 'text' && <pre class="wrap">{visibleLines(toText(bytes))}</pre>}
        {json &&
          (json.ok ? (
            <>
              {json.flat && <div class="empty">Valid JSON, but too deep to indent. This is the text as it came.</div>}
              json.flat ? <pre class="wrap">{jsonText}</pre> : <JsonTree text={json.text} />
            </>
          ) : (
            <div class="empty">{cut ? 'Not valid JSON. Only the first part of this payload is here.' : 'Not valid JSON.'}</div>
          ))}
      </div>
    </div>
  );
}
