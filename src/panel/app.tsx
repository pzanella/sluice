// The panel: top bar, view tabs and views (ADR-38).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatBytes } from './format';
import { type InjectKind, type PanelConnectionAction, type TraceFile, type ReplayEnd } from '../shared/protocol';
import type { RuntimeConfig } from '../shared/rules';
import { HoldView, type HoldAction } from './holds';
import { InjectView } from './inject';
import { RecordView } from './record';
import { TracksView } from './tracks';
import { MonitorView } from './monitor-view';
import { moqtraceToMessages, readMoqtrace } from './moqtrace';
import { DEFAULT_THRESHOLDS, type MonitorThresholds } from './monitor';
import { type KnownTrack } from './rules';
import { RulesPage } from './rules-page';
import { STORE_LIMITS, sessionKey, type HoldRow, type InjectTarget, type Scope, type SessionRow } from './store';
import { store, useStoreVersion } from './panel-state';
import { chosenSessions, SessionPicker, Sidebar, SkippedWorkers, type SessionChoice } from './sessions';
import { Detail, MessageList } from './messages';

/** What the open sessions of the tab carry. */
function trafficOf(sessions: SessionRow[]): { datagrams: boolean; streams: boolean } {
  const open = sessions.filter((session) => !session.closed);
  return { datagrams: open.some((session) => session.hasDatagrams), streams: open.some((session) => session.streams.size > 0) };
}

/** MoQ tracks of all sessions of the tab, with their kind from the catalog, for the rule form. */
function knownTracks(sessions: SessionRow[]): KnownTrack[] {
  const kinds = new Map<string, KnownTrack['kind']>();
  const received = new Set<string>();
  for (const session of sessions) {
    for (const { renditions } of session.catalogs.values()) for (const rendition of renditions) kinds.set(rendition.name, rendition.kind);
    if (!session.closed) for (const name of session.tracks.keys()) received.add(name);
  }
  // What the player gets first, then the rest of the catalog.
  const names = [...received, ...[...kinds.keys()].filter((name) => !received.has(name))];
  return names.slice(0, 32).map((name) => ({ name, kind: kinds.get(name) ?? 'other', received: received.has(name) }));
}

/** Each opened `.moqtrace` file is a document of its own, so two files never share a session. */
let imports = 0;

type View = 'monitor' | 'messages' | 'tracks' | 'rules' | 'record';

export interface SiteConfig {
  origin: string;
  config: RuntimeConfig | null;
  error: string | null;
  granted: boolean;
}

interface AppProps {
  connected: () => boolean;
  /** Undefined until the page answers, which a hung page never does. Null = Sluice cannot run on it. */
  origin: () => string | null | undefined;
  site: () => SiteConfig | null;
  onSave: (origin: string, config: RuntimeConfig) => boolean;
  onResolve: (row: HoldRow, action: HoldAction) => boolean;
  onInject: (target: InjectTarget, kind: InjectKind, data: string) => number | null;
  onRecord: (on: boolean) => boolean;
  onArm: (trace: TraceFile, options: { end: ReplayEnd; overlay: boolean }) => boolean;
  onDisarm: () => boolean;
  onConnection: (session: SessionRow, action: PanelConnectionAction) => boolean;
}

const THRESHOLDS_KEY = 'sluice.monitor.thresholds';
/** Per viewer, and only a convenience: with no storage the defaults apply. */
function loadThresholds(): MonitorThresholds {
  try {
    const raw = JSON.parse(localStorage.getItem(THRESHOLDS_KEY) ?? 'null') as Partial<MonitorThresholds> | null;
    if (raw && typeof raw.pauseMs === 'number' && raw.pauseMs >= 100 && typeof raw.keyIntervalMs === 'number' && raw.keyIntervalMs >= 0) return { pauseMs: raw.pauseMs, keyIntervalMs: raw.keyIntervalMs };
  } catch {
    // No storage here.
  }
  return { ...DEFAULT_THRESHOLDS };
}

const VIEWS = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'messages', label: 'Messages' },
  { id: 'rules', label: 'Rules' },
  { id: 'record', label: 'Record' },
] as const;

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function App({ connected, origin, site, onSave, onResolve, onInject, onRecord, onArm, onDisarm, onConnection }: AppProps) {
  const [thresholds, setThresholds] = useState<MonitorThresholds>(() => {
    const loaded = loadThresholds();
    store.thresholds = loaded;
    return loaded;
  });
  const [recording, setRecording] = useState(false);
  const [recordSince, setRecordSince] = useState(0);
  const [, setTick] = useState(0);
  const [armedUrl, setArmedUrl] = useState<string | null>(null);
  /** The recording that waits or plays: deleting it stops the replay. */
  const [armedTrace, setArmedTrace] = useState<TraceFile | null>(null);
  const [end, setEnd] = useState<ReplayEnd>('hold');
  const [overlay, setOverlay] = useState(true);
  const version = useStoreVersion();
  const [view, setView] = useState<View>('messages');
  const [choice, setChoice] = useState<SessionChoice>('open');
  const [scopeState, setScope] = useState<Scope>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [injectOpen, setInjectOpen] = useState(false);
  const shown = chosenSessions(choice);
  const shownKeys = shown.map((session) => session.key).join(' ');
  // A scope of a session out of view does not apply.
  const scope: Scope = scopeState && shown.some((session) => session.key === scopeState.sessionKey) ? scopeState : null;
  const rows = useMemo(
    () => store.visibleRows(scope, filter, choice === 'all' ? null : new Set(shownKeys.split(' '))),
    [version, scope?.sessionKey, scope?.stream, filter, shownKeys, choice],
  );
  const selectedRow = useMemo(() => store.rows.find((row) => row.n === selected) ?? null, [version, selected]);
  const totals = store.totals();
  const lost = store.lostItems();
  const holdRows = store.holdRows();
  const currentOrigin = origin();
  const currentSite = site();
  const saved = currentSite && currentSite.origin === currentOrigin ? currentSite : null;
  const onItsWay = store.recordingOnItsWay();
  const startedUrl = store.replayStartedUrl;
  const endedUrl = store.replayEndedUrl;
  const waiting = armedUrl !== null && armedUrl !== startedUrl ? armedUrl : null;
  // Quick tests run once on the newest open session that the picker shows.
  const liveSession = shown.filter((session) => !session.closed).at(-1) ?? null;
  const trackCount = shown.reduce((sum, session) => sum + session.tracks.size, 0);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const disarm = (): boolean => {
    const sent = onDisarm();
    if (sent) {
      setArmedUrl(null);
      setArmedTrace(null);
      store.replayStartedUrl = null;
      store.replayEndedUrl = null;
    }
    return sent;
  };
  const record = (on: boolean): boolean => {
    // A recording is of the live server: a replay that waits or plays would take the next session.
    if (on && (armedUrl || store.replayStartedUrl)) disarm();
    const sent = onRecord(on);
    if (sent) {
      setRecording(on);
      if (on) {
        store.recordEmpty = false;
        setRecordSince(Date.now());
      } else store.waitForRecording();
    }
    return sent;
  };

  // Recording and replay, at the top of the Record view.
  const recordBar = (
    <div class="record-bar" role="region" aria-label="Recording and replay">
      <button type="button" class={recording ? 'stop rec-button' : 'primary rec-button'} disabled={!connected() || onItsWay !== null} onClick={() => record(!recording)}>
        {recording ? 'Stop recording' : 'Start recording'}
      </button>
      {/* One slot for what records and what plays: its text changes, but the buttons around it never move. */}
      <div class="bar-state">
        {recording ? (
          <span class="rec-state" role="timer" aria-label="Recording time">
            <span class="rec-dot" aria-hidden="true" /> Recording {clock(Date.now() - recordSince)}
          </span>
        ) : onItsWay !== null ? (
          <span class="rec-state">Getting the recording: {onItsWay} messages</span>
        ) : null}
        {waiting || startedUrl ? (
          <span
            class="replay-state"
            title={endedUrl && end === 'hold' ? 'The session of the app stays open with no more data, so the player shows its last frame. Stop playing: the next session of the app is live.' : undefined}
          >
            {waiting ? 'Replay ready: start a new session in the app' : endedUrl ? (end === 'hold' ? 'Replay ended: the app shows the last frame' : 'Replay ended') : 'Replaying'}
          </span>
        ) : null}
        {waiting || (startedUrl && end !== 'live') ? (
          <button type="button" onClick={() => disarm()}>
            {waiting ? 'Cancel play' : 'Stop playing'}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div class="app">
      <div class="global-bar" role="region" aria-label="Session">
        <div class="bar-top">
          <span class="brand">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <rect x="1" y="2" width="3" height="12" rx="1" fill="currentColor" />
              <rect x="12" y="2" width="3" height="12" rx="1" fill="currentColor" />
              <path d="M4 6h8M4 10c1.5-1.5 2.5 1.5 4 0s2.5 1.5 4 0" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
            </svg>
            Sluice
          </span>
          <SessionPicker
            choice={choice}
            onChoice={(next) => {
              setChoice(next);
              setScope(null);
              setSelected(null);
            }}
          />
        </div>
      </div>
      <header class="toolbar">
        <div
          class="view-tabs"
          role="tablist"
          aria-label="View"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const at = VIEWS.findIndex(({ id }) => id === view);
            const next = VIEWS[(at + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
            if (!next) return;
            setView(next.id);
            document.getElementById(`view-tab-${next.id}`)?.focus();
          }}
        >
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              id={`view-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={view === id}
              aria-controls="view"
              tabIndex={view === id ? 0 : -1}
              aria-label={
                id === 'rules' && holdRows.length > 0
                  ? `Rules, ${holdRows.length} held`
                  : id === 'record' && recording
                    ? 'Record, recording'
                    : id === 'record' && (waiting || (startedUrl && !endedUrl))
                      ? `Record, replay ${waiting ? 'ready' : 'playing'}`
                      : undefined
              }
              onClick={() => setView(id)}
            >
              {label}
              {id === 'rules' && holdRows.length > 0 && <span class="badge held">{holdRows.length} held</span>}
              {id === 'tracks' && trackCount > 0 && <span class="count">{trackCount}</span>}
              {id === 'record' && recording ? <span class="rec-dot" title="Recording" /> : null}
              {id === 'record' && !recording && (waiting || (startedUrl && !endedUrl)) ? <span class="badge play">{waiting ? 'ready' : 'playing'}</span> : null}
              {id === 'record' && store.recordings.size > 0 && <span class="count">{store.recordings.size}</span>}
            </button>
          ))}
        </div>
        <span class="status" role="status">
          {connected() ? '' : <strong>Not connected. Trying again. </strong>}
          {store.evicted > 0 ? <span title={`The list keeps the last ${STORE_LIMITS.rows} rows. Counters still include the older ones.`}>{store.evicted} older rows removed </span> : null}
          {lost > 0 ? <strong title="Too many messages to send to the panel at once. Counters still include them.">{lost} not shown</strong> : null}
        </span>
        <span class="counters">
          {totals.chunks} chunks · {formatBytes(totals.bytes)} · {totals.dropped} dropped · {totals.modified} modified ·{' '}
          {totals.delayed} delayed
        </span>
      </header>
      <div id="view" class={`view view-${view}`} role="tabpanel" aria-labelledby={`view-tab-${view}`}>
        {view === 'monitor' ? (
          <MonitorView
            sessions={shown}
            playback={Array.from(store.playback.values())}
            onReset={() => store.resetMonitor()}
            thresholds={thresholds}
            onThresholds={(next) => {
              setThresholds(next);
              store.thresholds = next;
              try {
                localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(next));
              } catch {
                // No storage here: the setting lasts while the panel is open.
              }
            }}
          />
        ) : view === 'tracks' ? (
          <TracksView sessions={shown} />
        ) : view === 'record' ? (
          <RecordView
            controls={recordBar}
            recording={recording}
            onItsWay={onItsWay}
            empty={store.recordEmpty}
            rows={Array.from(store.recordings.values())}
            onDelete={(key) => {
              // A recording that is gone cannot play: its replay stops, and the next session of the app is live.
              if (armedTrace && store.recordings.get(key)?.trace === armedTrace) disarm();
              store.deleteRecording(key);
            }}
            armedUrl={waiting}
            startedUrl={startedUrl}
            connected={connected()}
            endedUrl={endedUrl}
            end={end}
            onEnd={setEnd}
            overlay={overlay}
            onOverlay={setOverlay}
            onImport={(name, data) => {
              const trace = readMoqtrace(data);
              if (!trace) return 'This is not a .moqtrace file of a version that Sluice reads (1 or 2).';
              const documentId = `moqtrace-${++imports}`;
              const { messages } = moqtraceToMessages(trace, documentId, name);
              for (const message of messages) store.handle(message);
              setChoice(sessionKey(documentId, 1));
              setScope(null);
              setSelected(null);
              setView('monitor');
              return null;
            }}
            onArm={(trace) => {
              const sent = onArm(trace, { end, overlay });
              if (sent) {
                store.replayStartedUrl = null;
                store.replayEndedUrl = null;
                setArmedUrl(trace.url);
                setArmedTrace(trace);
              }
              return sent;
            }}
          />
        ) : view === 'rules' ? (
          <div class="rules-tab">
            {/* A key, so nothing of one site can be saved to the next one. See ADR-11. */}
            <RulesPage
              held={
                <section class="held-section" aria-label="Held messages">
                  <HoldView rows={holdRows} onResolve={onResolve} />
                </section>
              }
              heldCount={holdRows.length}
              key={currentOrigin ?? ''}
              traffic={trafficOf(Array.from(store.sessions.values()))}
              origin={currentOrigin}
              saved={saved ? saved.config : undefined}
              saveError={saved?.error ?? null}
              connected={connected()}
              disabledRules={store.disabledRules()}
              ruleHits={store.ruleHits()}
              onSave={onSave}
              granted={saved?.granted}
              knownTracks={knownTracks(Array.from(store.sessions.values()))}
              runNow={liveSession ? (action) => onConnection(liveSession, action) : null}
            />
          </div>
        ) : (
          <div class="messages-tab">
            {/* Only for the list of messages: they stay in this view, so the bar above never changes. */}
            <div class="messages-bar">
              <input
                type="search"
                placeholder="Show only messages with this text"
                aria-label="Filter payload text"
                title="Shows only the messages whose payload, read as text, has this text"
                value={filter}
                onInput={(event) => setFilter(event.currentTarget.value)}
              />
              <button
                type="button"
                title="Empties the list. Counters start again from 0."
                onClick={() => {
                  store.clear();
                  setScope(null);
                  setSelected(null);
                }}
              >
                Clear
              </button>
              <button type="button" title="Send the app a message as if the server sent it" aria-expanded={injectOpen} aria-controls="inject-drawer" onClick={() => setInjectOpen(!injectOpen)}>
                Inject
              </button>
            </div>
            <SkippedWorkers />
            {store.sessions.size === 0 ? (
              <div class="empty onboarding">
                <strong>No WebTransport sessions yet.</strong>
                <ol class="steps">
                  <li class={saved?.granted ? 'done' : ''}>
                    <b>Turn Sluice on.</b> Click the Sluice button in the Chrome toolbar and turn it on for this site.
                    {saved?.granted ? ' Done: Sluice is on for this site.' : ''}
                  </li>
                  <li>
                    <b>Reload the page</b>, so Sluice runs before the app opens its session.
                  </li>
                  <li>
                    <b>Start the player or the app.</b> Its sessions, tracks and messages show here.
                  </li>
                </ol>
                <span class="hint">Only sessions of this tab are shown.</span>
              </div>
            ) : (
              <div class="main">
                <Sidebar scope={scope} onScope={setScope} sessions={shown} hidden={choice === 'open' ? store.sessions.size - shown.length : 0} onShowAll={() => setChoice('all')} />
                <div class="content">
                  <MessageList rows={rows} selected={selected} onSelect={setSelected} />
                  <Detail row={selectedRow} />
                </div>
              </div>
            )}
            {injectOpen ? (
              <section id="inject-drawer" class="inject-drawer" aria-label="Inject">
                <InjectView targets={store.injectTargets(currentOrigin)} connected={connected()} onSend={onInject} result={(frameKey, id) => store.injectResults.get(`${frameKey} ${id}`)} />
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
