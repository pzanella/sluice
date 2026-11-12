// A report in one HTML file, to attach to a ticket (ADR-51). It has no script and no outside resource. All text from the page is
// escaped, as the file opens in a browser of someone else.
import { avOffsetMs, monitorReport, series, type MonitorThresholds } from './monitor';
import { playbackReport, playbackSeries, type PlaybackState } from './playback';
import type { SessionRow } from './store';
import { hostAndPath } from './format';

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const CHART_SECONDS = 120;

function chart(values: number[], label: string): string {
  const width = 480;
  const height = 60;
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((value, i) => `${(i * step).toFixed(1)},${(height - 2 - (value / max) * (height - 6)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(label)}"><polyline points="0,${height} ${points} ${width},${height}" fill="#eef0ff"/><polyline points="${points}" fill="none" stroke="#4f46e5" stroke-width="1.5"/></svg>`;
}

const bits = (value: number): string => (value >= 1e6 ? `${(value / 1e6).toFixed(2)} Mbit/s` : `${Math.round(value / 1e3)} kbit/s`);
const time = (at: number): string => new Date(at).toISOString().slice(11, 23);

export function htmlReport(sessions: SessionRow[], playback: PlaybackState[], thresholds: MonitorThresholds, now = Date.now()): string {
  const parts: string[] = [];
  for (const state of playback) {
    const report = playbackReport(state, now);
    parts.push(`<section><h2>Playback <span class="chip">${escape(report.health)}</span></h2>
<p>${escape(state.label)}</p>
<p>${report.decoders.map((decoder) => `<span class="chip">${escape(decoder.kind)} ${escape(decoder.codec)}${decoder.width && decoder.height ? ` ${decoder.width}x${decoder.height}` : ''}</span>`).join(' ')}</p>
<p>Video frames per second (last 10 s): <b>${report.videoFramesPerSecond.toFixed(1)}</b> · audio: <b>${report.audioFramesPerSecond.toFixed(1)}</b> · dropped: <b>${report.droppedFramesPerSecond.toFixed(1)}</b></p>
${chart(playbackSeries(state, now, CHART_SECONDS, (bucket) => bucket.videoFrames), 'Video frames shown per second')}
${report.events.length > 0 ? `<table><tr><th>Time</th><th>Event</th><th>Text</th></tr>${report.events.slice(-100).map((event) => `<tr><td>${time(event.at)}</td><td>${escape(event.kind)}</td><td>${escape(event.text)}</td></tr>`).join('')}</table>` : ''}
</section>`);
  }
  for (const session of sessions) {
    const open = session.closed === null;
    // No query: a token can be in it.
    const url = session.url ? hostAndPath(session.url) : 'session';
    const report = monitorReport(url, session.monitor, thresholds, now, open);
    const kinds = new Map<string, string>();
    for (const { renditions } of session.catalogs.values()) for (const rendition of renditions) kinds.set(rendition.name, rendition.kind);
    const tracks = Array.from(session.monitor.tracks.values());
    const offset = avOffsetMs(
      tracks.find((track) => kinds.get(track.name) === 'video'),
      tracks.find((track) => kinds.get(track.name) === 'audio'),
    );
    parts.push(`<section><h2>${escape(url)} <span class="chip">${escape(session.moqt)}</span> <span class="chip ${report.pass ? 'pass' : 'fail'}">${report.pass ? 'all checks pass' : 'checks fail'}</span></h2>
<p>${open ? 'Open' : `Closed${session.closed?.closeCode === null || session.closed === null ? '' : ` (code ${session.closed.closeCode})`}`}${offset === null ? '' : ` · A/V: ${offset >= 0 ? `video ${offset} ms ahead` : `audio ${-offset} ms ahead`}`}</p>
<table><tr><th>Track</th><th>Bitrate, last 10 s</th><th>Frames/s</th><th>Key every</th><th>Lag</th><th>Gaps</th><th>Pauses</th><th>Checks</th></tr>
${report.tracks
  .map(
    (track) =>
      `<tr><td>${escape(track.name)}</td><td>${bits(track.bitsPerSecond)}</td><td>${track.framesPerSecond.toFixed(1)}</td><td>${track.keyIntervalMs === null ? '' : `${(track.keyIntervalMs / 1000).toFixed(1)} s`}</td><td>${track.lagMs === null ? '' : `${Math.round(track.lagMs)} ms`}</td><td>${track.gaps}</td><td>${track.pauses}</td><td>${track.checks.map((check) => `<span class="chip ${check.pass ? 'pass' : 'fail'}" title="${escape(check.detail)}">${check.pass ? '✓' : '✗'} ${escape(check.id)}</span>`).join(' ')}</td></tr>`,
  )
  .join('')}</table>
${tracks.map((track) => `<h3>${escape(track.name)}</h3>${chart(series(track, now, CHART_SECONDS, (bucket) => bucket.bytes * 8), `Bitrate of ${track.name}`)}`).join('')}
${report.events.length > 0 ? `<h3>Events</h3><table><tr><th>Time</th><th>Kind</th><th>Track</th><th>Text</th></tr>${report.events.slice(-200).reverse().map((event) => `<tr><td>${time(event.at)}</td><td>${escape(event.kind)}</td><td>${escape(event.track ?? '')}</td><td>${escape(event.text)}</td></tr>`).join('')}</table>` : ''}
</section>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Sluice report</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;color:#1c2024;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin:24px 0 4px}h3{font-size:13px;margin:12px 0 2px;color:#5c6670}
section{border:1px solid #e1e5ea;border-radius:10px;padding:12px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e1e5ea}
th{color:#5c6670;font-weight:600}.chip{display:inline-block;padding:0 8px;border-radius:999px;background:#f0f2f5;font-size:12px}
.pass{background:#e6f4ea;color:#1a7f37}.fail{background:#fde8e4;color:#c4320a}svg{max-width:100%;height:auto}
</style></head><body>
<h1>Sluice report</h1>
<p>Made ${escape(new Date(now).toISOString())}. Limits: a pause after ${thresholds.pauseMs} ms with no frame, key frames at most ${thresholds.keyIntervalMs / 1000} s apart. Counts are of what reached the panel. No payloads.</p>
${parts.join('\n') || '<p>Nothing to report: no MoQ track and no playback.</p>'}
</body></html>`;
}
