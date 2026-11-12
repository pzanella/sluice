import { describe, expect, it, vi } from 'vitest';
import { PAGE_READY } from '../../shared/page-status';
import { announcePage } from '../page-ready';

function env(prerendering = false) {
  const handlers = new Map<string, (event: never) => void>();
  const send = vi.fn();
  announcePage({ prerendering, send, on: (type: string, handler: (event: never) => void) => void handlers.set(type, handler) });
  const fire = (type: string, event?: unknown): void => handlers.get(type)?.(event as never);
  return { send, fire };
}

describe('announcePage', () => {
  it('sends once for a normal load', () => {
    const { send } = env();
    expect(send.mock.calls).toEqual([[{ type: PAGE_READY }]]);
  });

  it('sends again when the page comes back from the back/forward cache', () => {
    const { send, fire } = env();
    fire('pageshow', { persisted: true, isTrusted: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores a normal pageshow, because the first send covers it', () => {
    const { send, fire } = env();
    fire('pageshow', { persisted: false, isTrusted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores a pageshow that the page made', () => {
    const { send, fire } = env();
    fire('pageshow', { persisted: true, isTrusted: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits while the page is prerendered', () => {
    const { send, fire } = env(true);
    expect(send).not.toHaveBeenCalled();
    fire('prerenderingchange', { isTrusted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends once at activation, so the page cannot use the event to keep the worker busy', () => {
    const { send, fire } = env(true);
    fire('prerenderingchange', { isTrusted: true });
    fire('prerenderingchange', { isTrusted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores a prerenderingchange that the page made, and still sends at the real one', () => {
    const { send, fire } = env(true);
    fire('prerenderingchange', { isTrusted: false });
    expect(send).not.toHaveBeenCalled();
    fire('prerenderingchange', { isTrusted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
