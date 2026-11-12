import { describe, expect, it, vi } from 'vitest';
import { createSyncQueue, keepGrantedWorkerSites, syncContentScripts, type ContentScriptApi } from '../content-scripts';

function api(origins: string[] | undefined, registered: string[] = [], workerSites: string[] = []) {
  return {
    getWorkerSites: vi.fn(() => Promise.resolve(workerSites)),
    getAll: vi.fn(() => Promise.resolve(origins === undefined ? {} : { origins })),
    getRegistered: vi.fn(() => Promise.resolve(registered.map((id) => ({ id })))),
    register: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
  } satisfies ContentScriptApi;
}

const IDS = ['sluice-bridge', 'sluice-main'];

describe('syncContentScripts', () => {
  it('registers both scripts for the first origin', async () => {
    const a = api(['https://a.test/*']);
    await syncContentScripts(a);
    expect(a.update).not.toHaveBeenCalled();
    expect(a.register).toHaveBeenCalledWith([
      {
        id: 'sluice-bridge',
        js: ['bridge.js'],
        matches: ['https://a.test/*'],
        excludeMatches: [],
        world: 'ISOLATED',
        runAt: 'document_start',
        allFrames: true,
        matchOriginAsFallback: true,
      },
      {
        id: 'sluice-main',
        js: ['inject.js'],
        matches: ['https://a.test/*'],
        excludeMatches: [],
        world: 'MAIN',
        runAt: 'document_start',
        allFrames: true,
        matchOriginAsFallback: true,
      },
    ]);
  });

  it('updates the scripts when the origins change, and does not unregister them', async () => {
    const a = api(['https://a.test/*', 'https://b.test/*'], IDS);
    await syncContentScripts(a);
    expect(a.register).not.toHaveBeenCalled();
    expect(a.unregister).not.toHaveBeenCalled();
    expect(a.update.mock.calls[0]).toEqual([
      expect.arrayContaining([expect.objectContaining({ id: 'sluice-main', matches: ['https://a.test/*', 'https://b.test/*'] })]),
    ]);
  });

  it('unregisters when the last origin is removed', async () => {
    const a = api([], IDS);
    await syncContentScripts(a);
    expect(a.unregister).toHaveBeenCalledWith(IDS);
    expect(a.register).not.toHaveBeenCalled();
  });

  it('does nothing with no origins and no scripts, also if Chrome leaves out the list', async () => {
    for (const a of [api([]), api(undefined)]) {
      await syncContentScripts(a);
      expect(a.unregister).not.toHaveBeenCalled();
      expect(a.register).not.toHaveBeenCalled();
    }
  });

  it('repairs a half-registered state', async () => {
    const a = api(['https://a.test/*'], ['sluice-main']);
    await syncContentScripts(a);
    expect(a.update.mock.calls[0]).toEqual([[expect.objectContaining({ id: 'sluice-main' })]]);
    expect(a.register.mock.calls[0]).toEqual([[expect.objectContaining({ id: 'sluice-bridge' })]]);
  });

  it('gives a site with the worker switch the bigger runtime in place of the normal one', async () => {
    const a = api(['https://a.test/*', 'https://b.test/*'], [], ['https://a.test/*']);
    await syncContentScripts(a);
    const scripts = (a.register.mock.calls[0] as unknown as [{ id: string; js: string[]; matches: string[]; excludeMatches: string[] }[]])[0];
    expect(scripts.find((s) => s.id === 'sluice-main')).toMatchObject({
      js: ['inject.js'],
      matches: ['https://a.test/*', 'https://b.test/*'],
      excludeMatches: ['https://a.test/*'],
    });
    expect(scripts.find((s) => s.id === 'sluice-main-workers')).toMatchObject({ js: ['inject-workers.js'], matches: ['https://a.test/*'] });
  });

  it('removes the bigger runtime when the last switch goes off, and keeps the others', async () => {
    const a = api(['https://a.test/*'], [...IDS, 'sluice-main-workers']);
    await syncContentScripts(a);
    expect(a.unregister).toHaveBeenCalledWith(['sluice-main-workers']);
    expect(a.update.mock.calls[0]).toEqual([expect.arrayContaining([expect.objectContaining({ id: 'sluice-main', excludeMatches: [] })])]);
  });

  it('removes all three when the last origin goes, with a switch still set', async () => {
    const a = api([], [...IDS, 'sluice-main-workers'], ['https://a.test/*']);
    await syncContentScripts(a);
    expect(a.unregister).toHaveBeenCalledWith([...IDS, 'sluice-main-workers']);
  });

  it('still registers the normal scripts if the switches cannot be read', async () => {
    const a = api(['https://a.test/*']);
    a.getWorkerSites.mockRejectedValueOnce(new Error('storage'));
    await syncContentScripts(a);
    expect(a.register.mock.calls.flat(2).map((s) => (s as unknown as { id: string }).id)).toEqual(IDS);
  });

  it('drops a pattern that Chrome rejects, and keeps the others', async () => {
    const save = vi.fn(() => Promise.resolve());
    const kept = await keepGrantedWorkerSites(['bad', 'https://a.test/*'], (site) => (site === 'bad' ? Promise.reject(new Error('Invalid')) : Promise.resolve(true)), save);
    expect(kept).toEqual(['https://a.test/*']);
    expect(save).toHaveBeenCalledWith(['https://a.test/*']);
  });

  it('reads the switches also with no grant left, because that read ends them', async () => {
    const a = api([], [], ['https://a.test/*']);
    await syncContentScripts(a);
    expect(a.getWorkerSites).toHaveBeenCalled();
    expect(a.register).not.toHaveBeenCalled();
  });

  it('leaves scripts of other ids alone', async () => {
    const a = api([], ['other']);
    await syncContentScripts(a);
    expect(a.unregister).not.toHaveBeenCalled();
  });
});

describe('keepGrantedWorkerSites', () => {
  it('drops a site with no grant, and saves the list', async () => {
    const save = vi.fn(() => Promise.resolve());
    const kept = await keepGrantedWorkerSites(['https://a.test/*', 'https://b.test/*'], (site) => Promise.resolve(site.includes('a.test')), save);
    expect(kept).toEqual(['https://a.test/*']);
    expect(save).toHaveBeenCalledWith(['https://a.test/*']);
  });

  it('does not write when nothing changed, so a write cannot start another sync for ever', async () => {
    const save = vi.fn(() => Promise.resolve());
    await keepGrantedWorkerSites(['https://a.test/*'], () => Promise.resolve(true), save);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('createSyncQueue', () => {
  it('runs one sync at a time, in order', async () => {
    const order: string[] = [];
    let release = (): void => undefined;
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        order.push('first start');
        release = () => {
          order.push('first end');
          resolve();
        };
      }))
      .mockImplementationOnce(() => {
        order.push('second');
        return Promise.resolve();
      });
    const sync = createSyncQueue(run, () => undefined);
    const done = [sync(), sync()];
    await vi.waitFor(() => expect(order).toEqual(['first start']));
    release();
    await Promise.all(done);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('reports a failure and keeps working', async () => {
    const report = vi.fn();
    const error = new Error('bad pattern');
    const run = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValueOnce();
    const sync = createSyncQueue(run, report);
    await sync();
    await sync();
    expect(report).toHaveBeenCalledWith(error);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
