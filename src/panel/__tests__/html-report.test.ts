import { describe, expect, it } from 'vitest';
import { htmlReport } from '../html-report';
import { DEFAULT_THRESHOLDS } from '../monitor';
import { PanelStore } from '../store';

describe('HTML report (ADR-51)', () => {
  it('escapes all page text, has no script, and keeps no query of the URL', () => {
    const store = new PanelStore();
    const frame = (message: object) => ({ v: 1, type: 'frame-message', id: 1, payload: { frameId: 0, documentId: 'd', frameUrl: 'https://a.test/', message } }) as never;
    store.handle(frame({ v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://relay.test/moq?jwt=secret', createdAt: 1 } }));
    store.handle(
      frame({
        v: 1,
        type: 'traffic',
        id: 1,
        payload: { items: [{ sessionId: 1, streamId: 2, kind: 'uni', seq: 0, byteLength: 10, outcome: 'passed', modified: false, delayMs: 0, preview: '', at: Date.now(), moqt: { trackAlias: 0, group: 1, subgroup: null, object: 0, track: '<img src=x onerror=alert(1)>' } }] },
      }),
    );
    const html = htmlReport(Array.from(store.sessions.values()), [], DEFAULT_THRESHOLDS);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('secret');
    expect(html).toContain("default-src 'none'");
  });
});
