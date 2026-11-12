// Records what the network delivers, saves it to a file, and plays it to the app with no server (ADR-19).
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { canExportMoqtrace, traceToMoqtrace } from './moqtrace-export';
import { parseTrace, type TraceFile, type ReplayEnd } from '../shared/protocol';
import { formatBytes, hostAndPath, visible } from './format';
import type { RecordingRow } from './store';
import { Select } from './select';

interface RecordProps {
  /** Start and stop recording, and the state of a replay, at the top of the view. */
  controls: ComponentChildren;
  /** Messages of a recording on their way to the panel, or null. */
  onItsWay: number | null;
  /** The last recording had nothing in it. */
  empty: boolean;
  recording: boolean;
  rows: RecordingRow[];
  armedUrl: string | null;
  startedUrl: string | null;
  /** The recording that plays reached its end. */
  endedUrl: string | null;
  connected: boolean;
  end: ReplayEnd;
  onEnd: (end: ReplayEnd) => void;
  overlay: boolean;
  onOverlay: (on: boolean) => void;
  onArm: (trace: TraceFile) => boolean;
  /** Forgets a recording of this panel. A saved file stays. */
  onDelete: (key: string) => void;
  /** Opens a `.moqtrace` file as a session for analysis. It returns why not, or null. */
  onImport: (name: string, data: Uint8Array) => string | null;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** The sessions of one recording, together: their keys share the document and the recording. */
function groupsOf(rows: RecordingRow[]): { key: string; rows: RecordingRow[] }[] {
  const groups = new Map<string, RecordingRow[]>();
  for (const row of rows) {
    const key = row.key.split(' ').slice(0, 2).join(' ');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Array.from(groups, ([key, list]) => ({ key, rows: list }));
}

/** MoQ media with no key frame: a video decoder cannot start from it. */
const noVideoStart = (trace: TraceFile): boolean => {
  const tracks = trace.summary?.tracks ?? [];
  const media = tracks.filter((track) => !track.name.includes('catalog') && track.frames > 0);
  return media.length > 0 && media.every((track) => track.keyframes === 0) && media.some((track) => track.mediaMs !== undefined);
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** What any recording shows, also an old file with no summary. */
function traceFacts(trace: TraceFile): { ms: number; bytes: number; streams: number; datagrams: number } {
  let bytes = 0;
  let datagrams = 0;
  const streams = new Set<string>();
  for (const event of trace.events) {
    if (event.data) bytes += Math.floor((event.data.length * 3) / 4) - (event.data.endsWith('==') ? 2 : event.data.endsWith('=') ? 1 : 0);
    if (event.kind === 'datagram') datagrams++;
    else streams.add(`${event.kind} ${event.origin} ${String(event.streamId)}`);
  }
  const first = trace.events[0]?.t ?? 0;
  const last = trace.events.at(-1)?.t ?? 0;
  return { ms: trace.summary?.recordedMs ?? last - first, bytes, streams: streams.size, datagrams };
}

function RecordingFacts({ trace }: { trace: TraceFile }) {
  const facts = traceFacts(trace);
  const tracks = trace.summary?.tracks ?? [];
  return (
    <div class="recording-facts">
      <p class="chips">
        <span class="chip strong">{seconds(facts.ms)} recorded</span>
        <span class="chip">{formatBytes(facts.bytes)}</span>
        <span class="chip">{facts.streams} streams</span>
        {facts.datagrams > 0 ? <span class="chip">{facts.datagrams} datagrams</span> : null}
        <span class="chip">{trace.events.length} messages</span>
        {trace.protocol || trace.offered ? <span class="chip">{trace.protocol || trace.offered}</span> : null}
      </p>
      {tracks.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Track</th>
              <th scope="col">Groups</th>
              <th scope="col">Frames</th>
              <th scope="col">Key frames</th>
              <th scope="col">Media time</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track) => (
              <tr key={track.name}>
                <td>{visible(track.name)}</td>
                <td title={`Groups ${track.firstGroup} to ${track.lastGroup}`}>
                  {track.groups} ({track.firstGroup}–{track.lastGroup})
                </td>
                <td>{track.frames}</td>
                <td>{track.keyframes}</td>
                <td>{track.mediaMs === undefined ? '' : seconds(track.mediaMs)}</td>
                <td>{formatBytes(track.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

const fileName = (trace: TraceFile, end: string): string => {
  const { host } = new URL(trace.url);
  return `${host.replace(/[^a-zA-Z0-9.-]/g, '_')}${end}`;
};

const download = (blob: Blob, name: string): void => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const save = (trace: TraceFile): void => download(new Blob([JSON.stringify(trace)], { type: 'application/json' }), fileName(trace, '.sluicetrace.json'));

/** The recording as a `.moqtrace` file, for other tools (ADR-57). */
const exportMoqtrace = (trace: TraceFile): boolean => {
  try {
    const file = traceToMoqtrace(trace);
    if (!file) return false;
    download(new Blob([file], { type: 'application/octet-stream' }), fileName(trace, '.moqtrace'));
    return true;
  } catch {
    // A value that the format cannot hold, such as a number past 2^53: say so, never write half a file.
    return false;
  }
};

export function RecordView({ controls, onItsWay, empty, recording, rows, armedUrl, startedUrl, endedUrl, connected, end, onEnd, overlay, onOverlay, onArm, onImport, onDelete }: RecordProps) {
  const [error, setError] = useState('');
  const arm = (trace: TraceFile): void => {
    setError(onArm(trace) ? '' : 'Not sent: the panel is not connected. Try again.');
  };
  const load = async (file: File): Promise<void> => {
    if (file.size > MAX_FILE_BYTES) return setError(`The file must be at most ${formatBytes(MAX_FILE_BYTES)}.`);
    try {
      const parsed = parseTrace(JSON.parse(await file.text()));
      if (!parsed.ok) return setError('This is not a Sluice recording.');
      arm(parsed.value);
    } catch {
      setError('This is not a Sluice recording.');
    }
  };
  return (
    <div class="rules record">
      {controls}
      <p class="rules-note">
        A recording holds all that the network sent to the app, in full, and it can hold private data. It stays in this panel until
        you save it. Only what the app reads is recorded. When played, the app gets it with no server, in the same timing.
      </p>
      <div class="hold-actions">
        <label class="file-button">
          Play a saved file
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void load(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <label class="file-button" title="A trace in the .moqtrace format. It opens as a session in Monitor, Tracks and Messages. It does not play.">
          Open a .moqtrace
          <input
            type="file"
            accept=".moqtrace,application/octet-stream"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              if (file.size > MAX_FILE_BYTES) return setError(`The file must be at most ${formatBytes(MAX_FILE_BYTES)}.`);
              void file.arrayBuffer().then((buffer) => setError(onImport(file.name, new Uint8Array(buffer)) ?? ''));
            }}
          />
        </label>
        <span class="note" role="status">
          {recording ? 'Recording. Use the app, then click Stop recording. ' : null}
          {armedUrl ? (
            <strong>
              Ready to play. Now start a new session in your app, with no reload: the next session to {visible(armedUrl)} gets the recording. A session that is already open stays live.
            </strong>
          ) : null}
          {startedUrl && !armedUrl && !endedUrl ? (
            <strong>
              Playing to {visible(startedUrl)}, with no server. A failed connection to 127.0.0.1:9 in the console is normal: this is how Sluice keeps the real server out.
            </strong>
          ) : null}
          {endedUrl && !armedUrl ? (
            <strong>
              {end === 'hold'
                ? 'The recording ended. The app holds its last frame, and does not go live until you click Stop playing. If you start the player again, it plays again.'
                : end === 'loop'
                  ? 'The recording ended. It plays again on the next session of the app.'
                  : 'The recording ended. The next session of the app goes live.'}
            </strong>
          ) : null}
        </span>
      </div>
      <div class="replay-options">
        <strong>Replay options</strong>
        <label>
          At the end of a replay
          <Select
            value={end}
            options={[
              { value: 'hold', label: 'Hold the last frame (no live)' },
              { value: 'loop', label: 'Play it again' },
              { value: 'live', label: 'Go live' },
            ]}
            onChange={(value) => onEnd(value as ReplayEnd)}
          />
        </label>
        <label class="network-check">
          <input type="checkbox" checked={overlay} onChange={(event) => onOverlay(event.currentTarget.checked)} />
          Show track, group and frame on the page
        </label>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {onItsWay !== null ? (
        <p class="record-wait" role="status">
          <span class="loadbar" role="progressbar" aria-label="Getting the recording" />
          <span>
            Getting the recording from the page: <b>{onItsWay}</b> messages so far. It shows here when it is done.
          </span>
        </p>
      ) : null}
      {empty && onItsWay === null ? <p class="error" role="alert">Nothing was recorded: no session sent data to the app while recording.</p> : null}
      {rows.length === 0 && !recording && onItsWay === null && !empty ? <p class="empty">No recordings. Click Start recording, then use the app.</p> : null}
      <ol class="rule-list">
        {groupsOf(rows).map((group) => (
          <li key={group.key} class="rule-item recording-card">
            {group.rows.length > 1 ? (
              <p class="recording-note">
                The player opened {group.rows.length} sessions while you recorded, for example after a reconnect. Each one is a part of this
                recording and plays on its own.
              </p>
            ) : null}
            {group.rows.map((row, index) => (
              <div key={row.key} class="recording-part">
                <div class="rule-row">
                  <span class="rule-summary">
                    {hostAndPath(row.trace.url)}
                    {group.rows.length > 1 ? <span class="chip">part {index + 1}</span> : null}
                    {row.incomplete ? <span class="warn"> Not complete: some of it was lost or over the limit.</span> : null}
                  </span>
                  <button type="button" onClick={() => save(row.trace)}>
                    Save
                  </button>
                  {canExportMoqtrace(row.trace) ? (
                    <button type="button" title="A file for other MoQ tools. It does not play in Sluice: use Save for that." onClick={() => setError(exportMoqtrace(row.trace) ? '' : 'Not exported: this recording has data that a .moqtrace file cannot hold.')}>
                      Export .moqtrace
                    </button>
                  ) : null}
                  <button type="button" class="primary" disabled={!connected} onClick={() => arm(row.trace)}>
                    Play
                  </button>
                  <button type="button" class="ghost" aria-label={`Delete recording of ${hostAndPath(row.trace.url)}${group.rows.length > 1 ? `, part ${index + 1}` : ''}`} onClick={() => onDelete(row.key)}>
                    Delete
                  </button>
                </div>
                <RecordingFacts trace={row.trace} />
                {noVideoStart(row.trace) ? <p class="recording-note warn">No key frame in this part, so video cannot start from it: it plays audio only.</p> : null}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
