// The Monitor view: health of each MoQ track over the last two minutes, with the problems the app saw (ADR-42).
import { useEffect, useState } from 'preact/hooks';
import { formatTime, hostAndPath, visible } from './format';
import { average, avOffsetMs, MONITOR_SECONDS, monitorReport, series, trackChecks, trackHealth, type MonitorEvent, type MonitorThresholds, type MonitorTrack, type TrackHealth } from './monitor';
import type { SessionRow } from './store';
import { htmlReport } from './html-report';
import { playbackHealth, playbackSeries, type PlaybackHealth, type PlaybackState } from './playback';

const CHART_SECONDS = 60;

const HEALTH_TEXT: Record<TrackHealth, string> = { ok: 'OK', warn: 'Problem', stalled: 'Stalled', idle: 'Waiting', left: 'Not received' };

const bits = (bytes: number): string => {
  const value = bytes * 8;
  return value >= 1e6 ? `${(value / 1e6).toFixed(2)} Mbit/s` : `${Math.round(value / 1e3)} kbit/s`;
};

/** A line over the last seconds. Only a picture: the numbers next to it say the same. */
function Chart({ values, label }: { values: number[]; label: string }) {
  const width = 240;
  const height = 36;
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((value, i) => `${(i * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg class="chart" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
      <polyline points={`0,${height} ${points} ${width},${height}`} class="area" />
      <polyline points={points} class="line" />
    </svg>
  );
}

function TrackRow({ session, track, now, thresholds }: { session: SessionRow; track: MonitorTrack; now: number; thresholds: MonitorThresholds }) {
  const health = trackHealth(session.monitor, track, now, thresholds, session.closed === null);
  const bytes = series(track, now, CHART_SECONDS, (bucket) => bucket.bytes);
  const frames = series(track, now, 5, (bucket) => bucket.frames);
  const lastFull = bytes.at(-2) ?? 0;
  const keyMs = average(track.keyIntervals);
  return (
    <tr class={`health-${health}`}>
      <th scope="row">
        <span class={`dot ${health}`} aria-hidden="true" /> {visible(track.name)}
      </th>
      <td>
        <span class={`health-word ${health}`}>{HEALTH_TEXT[health]}</span>
      </td>
      <td class="chart-cell">
        <Chart values={bytes} label={`Bitrate of ${visible(track.name)} over the last ${CHART_SECONDS} seconds`} />
      </td>
      <td>{bits(lastFull)}</td>
      <td>{Math.round((frames.slice(0, -1).reduce((sum, value) => sum + value, 0) / 4) * 10) / 10}</td>
      <td>{keyMs === null ? '' : `${(keyMs / 1000).toFixed(1)} s`}</td>
      <td>{track.gaps}</td>
      <td>{track.pauses}</td>
      <td>{track.lateKeys}</td>
      <td title="How much later than its best of the last 30 s the last frame came, from the timestamps of the frames">{track.lagMs === null ? '' : `${Math.round(track.lagMs)} ms`}</td>
      <td>{track.lastAt === null ? '' : `${Math.max(0, (now - track.lastAt) / 1000).toFixed(1)} s ago`}</td>
      <td class="checks-cell">
        {trackChecks(track, now, thresholds, session.closed === null, health === 'left').map((check) => (
          <span key={check.id} class={`check ${check.pass ? 'pass' : 'fail'}`} title={check.detail}>
            {check.pass ? '✓' : '✗'} {check.id.replace('-', ' ')}
          </span>
        ))}
      </td>
    </tr>
  );
}

function EventList({ events }: { events: MonitorEvent[] }) {
  if (events.length === 0) return <p class="hint">No problems seen. Gaps, pauses, late key frames and actions of Sluice show here.</p>;
  return (
    <ol class="events">
      {[...events].reverse().slice(0, 100).map((event, i) => (
        <li key={`${event.at} ${i}`} class={`event ${event.kind}`}>
          <time>{formatTime(event.at)}</time>
          <span class="event-kind">{event.kind.replace('-', ' ')}</span>
          {event.track !== null ? <strong>{visible(event.track)}</strong> : null}
          <span>{visible(event.text)}</span>
        </li>
      ))}
    </ol>
  );
}

const download = (text: string, name: string, type: string): void => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type }));
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const save = (session: SessionRow, thresholds: MonitorThresholds): void => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([JSON.stringify(monitorReport(session.url && hostAndPath(session.url), session.monitor, thresholds, Date.now(), session.closed === null), null, 2)], { type: 'application/json' }));
  link.href = url;
  link.download = 'sluice-monitor-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const PLAYBACK_TEXT: Record<PlaybackHealth, string> = { playing: 'Playing', frozen: 'Frozen', idle: 'Waiting' };

/** What the player showed: frames that its decoders gave back, or that its <video> showed (ADR-49). */
function PlaybackCard({ state, now }: { state: PlaybackState; now: number }) {
  const health = playbackHealth(state, now);
  const video = playbackSeries(state, now, CHART_SECONDS, (bucket) => bucket.videoFrames);
  const audio = playbackSeries(state, now, 5, (bucket) => bucket.audioFrames);
  const dropped = playbackSeries(state, now, 5, (bucket) => bucket.droppedFrames);
  const perSecond = (values: number[]): number => Math.round((values.slice(0, -1).reduce((sum, value) => sum + value, 0) / Math.max(1, values.length - 1)) * 10) / 10;
  const queue = state.seconds.at(-1)?.queue ?? 0;
  return (
    <section class="monitor-session playback">
      <header>
        <h2>Playback</h2>
        <span class="chip">{visible(state.label)}</span>
        {state.decoders.map((decoder, i) => (
          <span key={i} class="chip">
            {decoder.kind} {visible(decoder.codec || 'not configured')}
            {decoder.width && decoder.height ? ` ${decoder.width}x${decoder.height}` : ''}
          </span>
        ))}
        <span class={`health-word ${health === 'playing' ? 'ok' : health === 'frozen' ? 'stalled' : ''}`}>{PLAYBACK_TEXT[health]}</span>
      </header>
      <div class="playback-row">
        <Chart values={video} label={`Video frames shown per second over the last ${CHART_SECONDS} seconds`} />
        <dl class="track-stats">
          <div>
            <dt>Video frames/s</dt>
            <dd>{perSecond(video.slice(-5))}</dd>
          </div>
          <div>
            <dt>Audio frames/s</dt>
            <dd>{perSecond(audio)}</dd>
          </div>
          <div>
            <dt>Dropped/s</dt>
            <dd>{perSecond(dropped)}</dd>
          </div>
          <div>
            <dt>Decode queue</dt>
            <dd>{queue}</dd>
          </div>
        </dl>
      </div>
      {state.events.length > 0 ? (
        <ol class="events">
          {[...state.events].reverse().slice(0, 50).map((event, i) => (
            <li key={`${event.at} ${i}`} class={`event ${event.kind}`}>
              <time>{formatTime(event.at)}</time>
              <span class="event-kind">{event.kind.replace('-', ' ')}</span>
              <span>{visible(event.text)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function MonitorView({
  sessions,
  playback,
  thresholds,
  onThresholds,
  onReset,
}: {
  sessions: SessionRow[];
  playback: PlaybackState[];
  thresholds: MonitorThresholds;
  onThresholds: (next: MonitorThresholds) => void;
  onReset: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const shown = sessions.filter((session) => session.monitor.tracks.size > 0 || session.monitor.events.length > 0);
  return (
    <div class="monitor">
      <div class="monitor-settings">
        <label>
          Warn when a track has no frame for
          <input
            type="number"
            min="100"
            step="100"
            value={thresholds.pauseMs}
            onInput={(event) => {
              const value = Number(event.currentTarget.value);
              if (value >= 100) onThresholds({ ...thresholds, pauseMs: value });
            }}
          />
          ms
        </label>
        <label>
          and when key frames are more than
          <input
            type="number"
            min="0"
            step="0.5"
            value={thresholds.keyIntervalMs / 1000}
            onInput={(event) => {
              const value = Number(event.currentTarget.value);
              if (value >= 0) onThresholds({ ...thresholds, keyIntervalMs: Math.round(value * 1000) });
            }}
          />
          s apart (0: off)
        </label>
        <button type="button" onClick={onReset} title="Counts, checks and events start from zero, for example after you change a rule.">
          Reset checks
        </button>
        <button
          type="button"
          class="primary"
          disabled={shown.length === 0 && playback.length === 0}
          title="One HTML file with the tracks, checks, charts and events of this view. No payloads."
          onClick={() => download(htmlReport(shown, playback, thresholds), 'sluice-report.html', 'text/html')}
        >
          Save HTML report
        </button>
      </div>
      {playback.map((state) => (
        <PlaybackCard key={state.label} state={state} now={now} />
      ))}
      {shown.length === 0 && playback.length === 0 ? (
        <div class="empty">
          <strong>Nothing to monitor yet.</strong>
          The Monitor follows MoQ tracks (moq-lite 3 to 6, and IETF drafts 7 to 23) from the first new streams after the panel opens. Playback shows here when the page decodes or plays video.
        </div>
      ) : (
        shown.map((session) => {
          const tracks = Array.from(session.monitor.tracks.values());
          const problems = session.monitor.events.filter((event) => now - event.at < 60_000 && event.track !== null).length;
          const stalled = session.stalledUntil !== null && session.stalledUntil > now;
          return (
            <section key={session.key} class="monitor-session">
              <header>
                <h2>{hostAndPath(session.url)}</h2>
                {session.moqt ? <span class="chip">{session.moqt}</span> : null}
                <span class={`chip ${session.closed ? '' : 'strong'}`}>{session.closed ? 'closed' : 'open'}</span>
                {(() => {
                  const kinds = new Map<string, string>();
                  for (const { renditions } of session.catalogs.values()) for (const rendition of renditions) kinds.set(rendition.name, rendition.kind);
                  const pick = (kind: string) => tracks.find((track) => kinds.get(track.name) === kind);
                  const offset = avOffsetMs(pick('video'), pick('audio'));
                  return offset === null ? null : (
                    <span class={`chip ${Math.abs(offset) > 1000 ? 'stall' : ''}`} title="Media time of the last video frame minus the one of the last audio frame">
                      A/V {offset >= 0 ? `video ${offset} ms ahead` : `audio ${-offset} ms ahead`}
                    </span>
                  );
                })()}
                {stalled ? <span class="chip stall">stalled, {Math.ceil(((session.stalledUntil ?? 0) - now) / 1000)} s left</span> : null}
                <span class={`summary ${problems > 0 ? 'bad' : 'good'}`}>{problems > 0 ? `${problems} ${problems === 1 ? 'problem' : 'problems'} in the last minute` : 'No problems in the last minute'}</span>
                <button type="button" onClick={() => save(session, thresholds)}>
                  Save report
                </button>
              </header>
              {tracks.length > 0 ? (
                <div class="monitor-table">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Track</th>
                        <th scope="col">State</th>
                        <th scope="col">Bitrate, last {CHART_SECONDS} s</th>
                        <th scope="col">Now</th>
                        <th scope="col">Frames/s</th>
                        <th scope="col">Key every</th>
                        <th scope="col">Gaps</th>
                        <th scope="col">Pauses</th>
                        <th scope="col">Late keys</th>
                        <th scope="col">Lag</th>
                        <th scope="col">Last frame</th>
                        <th scope="col">Checks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tracks.map((track) => (
                        <TrackRow key={track.name} session={session} track={track} now={now} thresholds={thresholds} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <h3>Events</h3>
              <EventList events={session.monitor.events} />
            </section>
          );
        })
      )}
      <p class="rules-note">
        Counts come from what reaches the panel: under heavy load it is a sample, and the status bar says how many messages were not shown. The Monitor keeps the last {MONITOR_SECONDS} s. Sizes are
        the payloads that the app got.
      </p>
    </div>
  );
}
