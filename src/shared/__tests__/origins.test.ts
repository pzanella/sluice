import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { originPattern } from '../origins';

describe('originPattern', () => {
  it.each([
    ['https://example.com/a?b#c', 'https://example.com/*'],
    ['https://example.com:8443/', 'https://example.com/*'],
    ['https://user:pw@example.com/', 'https://example.com/*'],
    ['http://localhost:8080/', 'http://localhost/*'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1/*'],
    ['http://[::1]:8080/', 'http://[::1]/*'],
    ['https://chrome.google.com/other', 'https://chrome.google.com/*'],
  ])('%s gives %s', (url, pattern) => {
    expect(originPattern(url)).toBe(pattern);
  });

  it.each([
    [undefined],
    [''],
    ['not a url'],
    ['http://example.com/'],
    ['http://localhost.example.com/'],
    ['chrome://extensions/'],
    ['chrome-extension://abc/page.html'],
    ['file:///tmp/a.html'],
    ['about:blank'],
    ['data:text/html,x'],
    ['https://*/'],
    ['https://*.example.com/'],
    ['https://chromewebstore.google.com/detail/x'],
    ['https://chrome.google.com/webstore/detail/x'],
  ])('%s gives null', (url) => {
    expect(originPattern(url)).toBeNull();
  });

  it('every pattern it can give is one the manifest can grant', () => {
    const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8')) as { optional_host_permissions: string[] };
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*']);
  });
});
