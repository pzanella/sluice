// The catalog of a moq-lite broadcast (its `catalog.json` track), checked on real traffic. All of it comes from the page, so it is read with care.

export interface Rendition {
  name: string;
  kind: 'video' | 'audio';
  codec: string;
  container: string;
  width?: number;
  height?: number;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

const MAX_RENDITIONS = 64;

const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 128) : '');
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function renditionsOf(section: unknown, kind: Rendition['kind']): Rendition[] {
  if (typeof section !== 'object' || section === null) return [];
  const renditions = (section as { renditions?: unknown }).renditions;
  if (typeof renditions !== 'object' || renditions === null) return [];
  const out: Rendition[] = [];
  for (const [name, value] of Object.entries(renditions).slice(0, MAX_RENDITIONS)) {
    if (typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    const width = number(r.codedWidth);
    const height = number(r.codedHeight);
    const bitrate = number(r.bitrate);
    const sampleRate = number(r.sampleRate);
    const channels = number(r.numberOfChannels);
    out.push({
      name: name.slice(0, 256),
      kind,
      codec: text(r.codec),
      container: text((r.container as { kind?: unknown } | null | undefined)?.kind),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(bitrate === undefined ? {} : { bitrate }),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
    });
  }
  return out;
}

/** Null if this is not a catalog with renditions. */
export function parseCatalog(json: string): Rendition[] | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { video, audio } = value as { video?: unknown; audio?: unknown };
  const out = [...renditionsOf(video, 'video'), ...renditionsOf(audio, 'audio')];
  return out.length > 0 ? out : null;
}
