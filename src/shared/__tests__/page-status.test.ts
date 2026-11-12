import { describe, expect, it } from 'vitest';
import { pageState, parsePageStatus } from '../page-status';

describe('pageState', () => {
  it.each([
    [true, true, 'running'],
    [true, false, 'stale'],
    [false, true, 'pending'],
    [false, false, 'off'],
    [null, true, 'unknown'],
    [null, false, 'unknown'],
  ] as const)('patched %s, granted %s is %s', (patched, granted, state) => {
    expect(pageState(patched, granted)).toBe(state);
  });
});

describe('parsePageStatus', () => {
  it('takes a valid status', () => {
    expect(parsePageStatus({ patched: true, origin: 'https://a.test' })).toEqual({ patched: true, origin: 'https://a.test' });
  });
  it.each([[null], [undefined], ['x'], [{}], [{ patched: 1, origin: 'a' }], [{ patched: true, origin: 1 }]])('rejects %j', (value) => {
    expect(parsePageStatus(value)).toBeNull();
  });
});
