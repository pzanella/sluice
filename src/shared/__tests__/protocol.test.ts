import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  parseControlMessage,
  parsePanelMessage,
  parsePanelRequest,
  parseRuntimeMessage,
  PROTOCOL_LIMITS,
  type TrafficItem,
} from '../protocol';
import { DEFAULT_CONFIG } from '../rules';

const wrap = (type: string, payload: unknown): unknown => ({ v: 1, type, id: 1, payload });
const item: TrafficItem = {
  sessionId: 1,
  streamId: null,
  kind: 'datagram',
  seq: 0,
  byteLength: 3,
  outcome: 'passed',
  modified: false,
  delayMs: 0,
  preview: 'AQID',
  at: 1,
};
const zero = { streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 };
const valid: unknown[] = [
  wrap('session-open', { sessionId: 1, url: 'https://a.test/', createdAt: 1 }),
  wrap('session-closed', { sessionId: 1, closeCode: 0, reason: '', at: 1 }),
  wrap('session-closed', { sessionId: 1, closeCode: null, reason: 'x', at: 1 }),
  wrap('stream-open', { sessionId: 1, streamId: 2, kind: 'uni', origin: 'remote', at: 1 }),
  wrap('traffic', { items: [item, { ...item, kind: 'uni', streamId: 2 }] }),
  wrap('stats', { stats: { datagram: zero, uni: zero, bidi: zero }, ruleHits: [{ id: '__proto__', count: 1 }], captureDropped: 0, disabledRules: [] }),
];

describe('parseRuntimeMessage', () => {
  it.each(valid.map((message) => [message]))('accepts %j and returns an equal copy', (message) => {
    const result = parseRuntimeMessage(message);
    expect(result).toEqual({ ok: true, value: message });
    if (result.ok) expect(result.value).not.toBe(message);
  });

  it('survives JSON, because Chrome ports use JSON', () => {
    for (const message of valid) {
      expect(parseRuntimeMessage(JSON.parse(JSON.stringify(message))).ok).toBe(true);
    }
  });

  it('never accepts a command from the page', () => {
    const result = parseRuntimeMessage(wrap('set-config', { config: DEFAULT_CONFIG, targetOrigin: 'https://a.test' }));
    expect(result.ok ? '' : result.errors[0]).toContain('not a message of this direction');
  });

  it('checks the MoQT fields of a traffic item', () => {
    const item = { sessionId: 1, streamId: 2, kind: 'uni', seq: 0, byteLength: 1, outcome: 'passed', modified: false, delayMs: 0, preview: '', at: 1 };
    const message = (moqt: unknown): unknown => ({ v: 1, type: 'traffic', id: 1, payload: { items: [{ ...item, moqt }] } });
    expect(parseRuntimeMessage(message({ trackAlias: 0, group: 1, subgroup: null, object: 2 })).ok).toBe(true);
    expect(parseRuntimeMessage(message({ trackAlias: 0, group: 'x', subgroup: 0, object: 2 })).ok).toBe(false);
    expect(parseRuntimeMessage(message({ trackAlias: 0, group: 1, subgroup: 0, object: 2, extra: 1 })).ok).toBe(false);
  });

  it.each([[null], ['x'], [[]], [{}], [{ v: 2, type: 'traffic', id: 1, payload: {} }]])('rejects %j', (value) => {
    expect(parseRuntimeMessage(value).ok).toBe(false);
  });

  it.each([[-1], [1.5], [NaN], ['1']])('rejects id %s', (id) => {
    expect(parseRuntimeMessage({ v: 1, type: 'traffic', id, payload: { items: [item] } }).ok).toBe(false);
  });

  it('rejects unknown envelope and payload fields', () => {
    expect(parseRuntimeMessage({ ...(valid[0] as object), frameId: 0 }).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, frameId: 0 }] })).ok).toBe(false);
  });

  it('rejects batches and text past the limits', () => {
    expect(parseRuntimeMessage(wrap('traffic', { items: new Array(PROTOCOL_LIMITS.batch + 1).fill(item) })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('traffic', { items: [] })).ok).toBe(false);
    const url = 'x'.repeat(PROTOCOL_LIMITS.url + 1);
    expect(parseRuntimeMessage(wrap('session-open', { sessionId: 1, url, createdAt: 1 })).ok).toBe(false);
    const reason = 'x'.repeat(PROTOCOL_LIMITS.closeReason + 1);
    expect(parseRuntimeMessage(wrap('session-closed', { sessionId: 1, closeCode: 0, reason, at: 1 })).ok).toBe(false);
  });

  it.each([['not base64!'], ['abc'], ['=AAA'], [1], [null], ['A'.repeat(87_384 + 4)]])('rejects preview %j', (preview) => {
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, preview }] })).ok).toBe(false);
  });

  it('accepts the largest preview', () => {
    const preview = bytesToBase64(new Uint8Array(PROTOCOL_LIMITS.previewBytes));
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, preview }] })).ok).toBe(true);
  });

  it('rejects holes in a batch', () => {
    expect(parseRuntimeMessage(wrap('traffic', { items: structuredClone(new Array(2)) })).ok).toBe(false);
  });

  it('accepts only https session URLs', () => {
    const open = (url: string): boolean => parseRuntimeMessage(wrap('session-open', { sessionId: 1, url, createdAt: 1 })).ok;
    expect(open('https://a.test/')).toBe(true);
    expect(open('javascript:alert(1)')).toBe(false);
    expect(open('http://a.test/')).toBe(false);
    expect(open('/relative')).toBe(false);
  });

  it('rejects a time that a Date cannot hold', () => {
    const at = 8.64e15 + 1;
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, at }] })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('session-open', { sessionId: 1, url: 'https://a.test/', createdAt: at })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('session-closed', { sessionId: 1, closeCode: 0, reason: '', at })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('stream-open', { sessionId: 1, streamId: 2, kind: 'uni', origin: 'remote', at })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, at: 8.64e15 }] })).ok).toBe(true);
  });

  it('checks stream ids against the kind', () => {
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, streamId: 1 }] })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, kind: 'uni' }] })).ok).toBe(false);
  });

  it.each([['sessionId', -1], ['seq', NaN], ['byteLength', 1.5], ['delayMs', -1], ['at', Infinity], ['outcome', 'held'], ['modified', 1]])(
    'rejects traffic item %s = %s',
    (key, value) => {
      expect(parseRuntimeMessage(wrap('traffic', { items: [{ ...item, [key]: value }] })).ok).toBe(false);
    },
  );

  it('rejects bad stats', () => {
    const stats = { datagram: zero, uni: zero, bidi: zero };
    expect(parseRuntimeMessage(wrap('stats', { stats: { ...stats, uni: { ...zero, bytes: -1 } }, ruleHits: [], captureDropped: 0, disabledRules: [] })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('stats', { stats: { datagram: zero, uni: zero }, ruleHits: [], captureDropped: 0, disabledRules: [] })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('stats', { stats, ruleHits: [{ id: '', count: 1 }], captureDropped: 0, disabledRules: [] })).ok).toBe(false);
  });

  it('turns a throwing getter into an error', () => {
    const hostile = {
      v: 1,
      type: 'traffic',
      id: 1,
      get payload(): unknown {
        throw new Error('boom');
      },
    };
    expect(parseRuntimeMessage(hostile).ok).toBe(false);
  });
});

describe('parseRuntimeMessage, worker messages', () => {
  const report = wrap('session-open', { sessionId: 1, url: 'https://a.test/wt', createdAt: 1 });
  const fromWorker = (message: unknown, workerId: unknown = 1): unknown => wrap('worker-message', { workerId, url: 'https://a.test/w.js', message });

  it('takes a report of a worker', () => {
    expect(parseRuntimeMessage(fromWorker(report)).ok).toBe(true);
  });
  it('checks the report inside', () => {
    expect(parseRuntimeMessage(fromWorker(wrap('session-open', { sessionId: 1, url: 'javascript:x', createdAt: 1 }))).ok).toBe(false);
  });
  it('refuses a worker message in a worker message', () => {
    expect(parseRuntimeMessage(fromWorker(fromWorker(report))).ok).toBe(false);
  });
  it('refuses a bad worker id', () => {
    expect(parseRuntimeMessage(fromWorker(report, '1')).ok).toBe(false);
  });
  it('takes worker-gone and checks it', () => {
    expect(parseRuntimeMessage(wrap('worker-gone', { workerId: 1 })).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('worker-gone', {})).ok).toBe(false);
  });
  it('takes a known skip reason only', () => {
    expect(parseRuntimeMessage(wrap('worker-skipped', { url: 'x', reason: 'csp' })).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('worker-skipped', { url: 'x', reason: 'other' })).ok).toBe(false);
  });
});

describe('parseControlMessage', () => {
  it('accepts set-config with a valid config', () => {
    const message = wrap('set-config', { config: DEFAULT_CONFIG, targetOrigin: 'https://a.test' });
    expect(parseControlMessage(message)).toEqual({ ok: true, value: message });
  });

  it('checks set-capture', () => {
    const message = wrap('set-capture', { traffic: true, previewBytes: 4096 });
    expect(parseControlMessage(message)).toEqual({ ok: true, value: message });
    expect(parseControlMessage(wrap('set-capture', { traffic: 1, previewBytes: 1 })).ok).toBe(false);
    expect(parseControlMessage(wrap('set-capture', { traffic: true, previewBytes: PROTOCOL_LIMITS.previewBytes + 1 })).ok).toBe(false);
  });

  it('rejects a bad config and other types', () => {
    expect(parseControlMessage(wrap('set-config', { config: { ...DEFAULT_CONFIG, maxDelayedBytes: -1 }, targetOrigin: 'https://a.test' })).ok).toBe(false);
    expect(parseControlMessage(wrap('set-config', {})).ok).toBe(false);
    expect(parseControlMessage(wrap('set-config', { config: DEFAULT_CONFIG })).ok).toBe(false);
    expect(parseControlMessage(valid[0]).ok).toBe(false);
  });
});

describe('parsePanelMessage', () => {
  const frame = { frameId: 0, documentId: 'doc', frameUrl: 'https://a.test/' };

  it('accepts frame messages', () => {
    const message = wrap('frame-message', { ...frame, message: valid[0] });
    expect(parsePanelMessage(message)).toEqual({ ok: true, value: message });
    const gone = wrap('frame-gone', { frameId: 0, documentId: 'doc' });
    expect(parsePanelMessage(gone)).toEqual({ ok: true, value: gone });
  });

  it('checks the config reply', () => {
    const reply = wrap('config', { targetOrigin: 'https://a.test', config: null, error: 'full', granted: true });
    expect(parsePanelMessage(reply)).toEqual({ ok: true, value: reply });
    const full = wrap('config', { targetOrigin: 'https://a.test', config: DEFAULT_CONFIG, error: null, granted: false });
    expect(parsePanelMessage(full).ok).toBe(true);
    expect(parsePanelMessage(wrap('config', { targetOrigin: 'https://a.test', config: null, error: null })).ok).toBe(false);
    expect(parsePanelMessage(wrap('site-changed', {})).ok).toBe(true);
    expect(parsePanelMessage(wrap('site-changed', { extra: 1 })).ok).toBe(false);
    expect(parsePanelMessage(wrap('config', { targetOrigin: 'https://a.test', config: { bad: 1 }, error: null })).ok).toBe(false);
  });

  it('rejects a bad inner message', () => {
    expect(parsePanelMessage(wrap('frame-message', { ...frame, message: wrap('set-config', {}) })).ok).toBe(false);
    expect(parsePanelMessage(wrap('frame-message', { ...frame, documentId: '', message: valid[0] })).ok).toBe(false);
    expect(parsePanelMessage(valid[0]).ok).toBe(false);
  });
});

describe('parsePanelRequest', () => {
  it('accepts get-config and set-config, and nothing else', () => {
    const get = wrap('get-config', { targetOrigin: 'https://a.test' });
    expect(parsePanelRequest(get)).toEqual({ ok: true, value: get });
    const set = wrap('set-config', { config: DEFAULT_CONFIG, targetOrigin: 'https://a.test' });
    expect(parsePanelRequest(set)).toEqual({ ok: true, value: set });
    expect(parsePanelRequest(wrap('set-capture', { traffic: true, previewBytes: 1 })).ok).toBe(false);
    expect(parsePanelRequest(wrap('get-config', {})).ok).toBe(false);
    expect(parsePanelRequest(valid[0]).ok).toBe(false);
  });
});

describe('base64', () => {
  it('matches btoa for every length around a block', () => {
    for (let size = 0; size < 8; size++) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => 250 + i);
      const expected = btoa(String.fromCharCode(...bytes));
      expect(bytesToBase64(bytes)).toBe(expected);
      expect(base64ToBytes(expected)).toEqual(bytes);
    }
  });

  it('keeps zero bytes at the end', () => {
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==');
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe('AAA=');
  });
});

describe('hold messages', () => {
  const held = {
    holdId: 1, sessionId: 1, streamId: null, kind: 'datagram', seq: 0, byteLength: 2, data: btoa('hi'), ruleId: 'r', timeoutMs: 1000, onTimeout: 'drop',
  };
  it('checks a held message', () => {
    expect(parseRuntimeMessage(wrap('hold', held)).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('hold', { ...held, streamId: 3 })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('hold', { ...held, data: '!' })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('hold', { ...held, timeoutMs: 1e12 })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('hold-end', { holdId: 1, outcome: 'gone' })).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('hold-end', { holdId: 1, outcome: 'other' })).ok).toBe(false);
  });
  it('a page cannot send a decision as a report, and a decision has data only for an edit', () => {
    const decision = { holdId: 1, workerId: null, action: 'forward', data: null };
    expect(parseRuntimeMessage(wrap('hold-resolve', decision)).ok).toBe(false);
    expect(parseControlMessage(wrap('hold-resolve', decision)).ok).toBe(true);
    expect(parseControlMessage(wrap('hold-resolve', { ...decision, data: btoa('x') })).ok).toBe(false);
    expect(parseControlMessage(wrap('hold-resolve', { ...decision, action: 'edit', data: null })).ok).toBe(false);
    expect(parseControlMessage(wrap('hold-resolve', { ...decision, action: 'edit', data: btoa('x') })).ok).toBe(true);
    expect(parsePanelRequest(wrap('hold-resolve', { ...decision, documentId: 'd' })).ok).toBe(true);
    expect(parsePanelRequest(wrap('hold-resolve', decision)).ok).toBe(false);
  });
});

describe('inject messages', () => {
  const request = { injectId: 1, sessionId: 1, workerId: null, kind: 'datagram', data: btoa('x') };
  it('checks a request', () => {
    expect(parseControlMessage(wrap('inject', request)).ok).toBe(true);
    expect(parsePanelRequest(wrap('inject', { ...request, documentId: 'd' })).ok).toBe(true);
    expect(parsePanelRequest(wrap('inject', request)).ok).toBe(false);
    expect(parseControlMessage(wrap('inject', { ...request, data: '' })).ok).toBe(false);
    expect(parseControlMessage(wrap('inject', { ...request, kind: 'bidi' })).ok).toBe(false);
  });
  it('a page cannot send a request as a report, and a result has a known reason', () => {
    expect(parseRuntimeMessage(wrap('inject', request)).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('inject-result', { injectId: 1, failure: null })).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('inject-result', { injectId: 1, failure: 'closed' })).ok).toBe(true);
    expect(parseRuntimeMessage(wrap('inject-result', { injectId: 1, failure: 'other' })).ok).toBe(false);
  });
});

describe('connection messages (ADR-41)', () => {
  it('a panel request to stall passes; a reset from the panel does not (rules reset streams)', () => {
    const request = { v: 1, type: 'connection', id: 1, payload: { documentId: 'd', sessionId: 1, workerId: null, action: { type: 'stall', durationMs: 500 } } };
    expect(parsePanelRequest(request).ok).toBe(true);
    expect(parsePanelRequest({ ...request, payload: { ...request.payload, action: { type: 'reset-stream', streamId: 4, code: 2 } } }).ok).toBe(false);
    expect(parsePanelRequest({ ...request, payload: { ...request.payload, action: { type: 'explode' } } }).ok).toBe(false);
  });

  it('a connection event from the page passes', () => {
    const message = { v: 1, type: 'connection-event', id: 1, payload: { sessionId: 1, action: { type: 'stall', durationMs: 500 }, streamId: null, at: 5 } };
    expect(parseRuntimeMessage(message).ok).toBe(true);
  });
});
