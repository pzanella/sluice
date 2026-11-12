// What a MoQ session carries: the tracks of its catalogs, with what really arrived. All names come from the page, so they are only shown as text.
import type { Rendition } from '../shared/catalog';
import { formatBytes, hostAndPath, visible } from './format';
import { JsonTree } from './json-tree';
import { trackBitrate, type SessionRow, type TrackRow } from './store';

const formatBits = (bits: number | null | undefined): string => {
  if (bits === null || bits === undefined) return '';
  return bits >= 1e6 ? `${(bits / 1e6).toFixed(2)} Mbit/s` : `${Math.round(bits / 1e3)} kbit/s`;
};

function mediaOf(rendition: Rendition | undefined): string {
  if (!rendition) return '';
  if (rendition.kind === 'video') return rendition.width && rendition.height ? `${rendition.width}x${rendition.height}` : '';
  return [rendition.sampleRate && `${rendition.sampleRate} Hz`, rendition.channels && `${rendition.channels} ch`].filter(Boolean).join(', ');
}

interface Line {
  name: string;
  rendition?: Rendition;
  track?: TrackRow;
}

function linesOf(session: SessionRow): Line[] {
  const lines = new Map<string, Line>();
  for (const { renditions } of session.catalogs.values()) {
    for (const rendition of renditions) lines.set(rendition.name, { name: rendition.name, rendition });
  }
  for (const track of session.tracks.values()) lines.set(track.name, { ...lines.get(track.name), name: track.name, track });
  const rank = (line: Line): number => (line.rendition?.kind === 'video' ? 0 : line.rendition?.kind === 'audio' ? 1 : 2);
  return Array.from(lines.values()).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Bytes of the last seconds as small bars. Only a picture: the numbers next to it say the same. */
function Spark({ track }: { track: TrackRow }) {
  const bars = track.recent.slice(-6);
  const max = Math.max(1, ...bars.map((bar) => bar.bytes));
  return (
    <svg class="spark" viewBox="0 0 60 20" width="60" height="20" aria-hidden="true">
      {bars.map((bar, i) => {
        const height = Math.max(1, Math.round((bar.bytes / max) * 18));
        return <rect key={bar.second} x={i * 10 + 1} y={20 - height} width="8" height={height} rx="1" />;
      })}
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A track that got no frame for this long is not received now: the player took another quality, or it stopped. */
const STALE_MS = 5000;

function TrackCard({ line, open }: { line: Line; open: boolean }) {
  const { name, rendition, track } = line;
  const quietMs = track ? Date.now() - track.lastAt : 0;
  const stale = track !== undefined && open && quietMs > STALE_MS;
  const kind = rendition?.kind ?? 'other';
  const media = mediaOf(rendition);
  return (
    <article class={`track-card kind-${kind}${!track || stale ? ' idle' : ''}`} aria-label={`Track ${visible(name)}`}>
      <header>
        <span class="track-kind">{kind === 'other' ? 'track' : kind}</span>
        <h3>{visible(name)}</h3>
        {rendition?.codec ? <span class="chip">{visible(rendition.codec)}</span> : null}
        {media ? <span class="chip">{media}</span> : null}
      </header>
      {rendition || !track ? (
        <div class="track-now">
          <span class="big">{!track ? 'not subscribed' : stale ? 'not received now' : formatBits(trackBitrate(track)) || 'waiting'}</span>
          {track && !stale ? <Spark track={track} /> : null}
          {stale ? <span class="muted">last frame {Math.round(quietMs / 1000)} s ago</span> : null}
          {rendition?.bitrate ? <span class="muted">catalog {formatBits(rendition.bitrate)}</span> : null}
        </div>
      ) : null}
      {track ? (
        <dl class="track-stats">
          <Stat label="Groups" value={track.groups} />
          <Stat label="Last group" value={track.lastGroup ?? ''} />
          <Stat label="Frames" value={track.frames} />
          <Stat label="Key frames" value={track.keyframes} />
          <Stat label="Last key group" value={track.lastKeyGroup ?? ''} />
          <Stat label="Dropped" value={track.dropped} />
          <Stat label="Bytes" value={formatBytes(track.bytes)} />
        </dl>
      ) : null}
    </article>
  );
}

const isCatalog = (line: Line): boolean => !line.rendition && line.name.includes('catalog');

/**
 * The catalog: the first track a player asks for, as it lists the others. It comes once, and again only when it changes, so it is
 * never "not received". Its JSON is here.
 */
function CatalogCard({ line, session }: { line: Line | undefined; session: SessionRow }) {
  const catalogs = Array.from(session.catalogs);
  const renditions = catalogs.reduce((sum, [, catalog]) => sum + catalog.renditions.length, 0);
  const updated = line?.track ? Math.max(0, Math.round((Date.now() - line.track.lastAt) / 1000)) : null;
  return (
    <article class="track-card catalog-card" aria-label={`Catalog ${visible(line?.name ?? '')}`}>
      <header>
        <span class="track-kind">catalog</span>
        <h3>{visible(line?.name ?? 'catalog')}</h3>
        <span class="chip">{renditions} renditions</span>
        {line?.track ? <span class="chip">{line.track.frames === 1 ? '1 version' : `${line.track.frames} versions`}</span> : null}
      </header>
      <p class="muted">
        The first track the player asks for: it lists the others, with codec, size and bitrate.
        {updated !== null ? ` Last version ${updated} s ago.` : ''}
      </p>
      {catalogs.map(([broadcast, { json }]) => (
        <details key={broadcast} class="catalog-json">
          <summary>JSON of {visible(broadcast)}</summary>
          <JsonTree text={json} />
        </details>
      ))}
    </article>
  );
}

function SessionTracks({ session }: { session: SessionRow }) {
  const all = linesOf(session);
  const catalog = all.find(isCatalog);
  const lines = all.filter((line) => !isCatalog(line));
  return (
    <section>
      <h2>
        {hostAndPath(session.url)} {session.moqt && <span class="chip">{session.moqt}</span>}
      </h2>
      <div class="track-grid">
        {catalog || session.catalogs.size > 0 ? <CatalogCard line={catalog} session={session} /> : null}
        {lines.map((line) => (
          <TrackCard key={line.name} line={line} open={session.closed === null} />
        ))}
      </div>
    </section>
  );
}

export function TracksView({ sessions }: { sessions: SessionRow[] }) {
  const shown = sessions.filter((session) => session.tracks.size > 0 || session.catalogs.size > 0);
  if (shown.length === 0) {
    return (
      <div class="empty">
        <strong>No MoQ tracks yet.</strong>
        Tracks show here for moq-lite 3 to 6, from the first new streams after the panel opens. Reload the page to see the catalog from its start.
      </div>
    );
  }
  return (
    <div class="tracks">
      {shown.map((session) => (
        <SessionTracks key={session.key} session={session} />
      ))}
      <p class="rules-note">
        Bitrate now is what arrived in the last seconds. A frame is a key frame when the frame itself says, so some tracks show none. Counts start when the panel opens.
      </p>
    </div>
  );
}
