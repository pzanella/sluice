import { describe, expect, it, vi } from 'vitest';
import { PAGE_READY } from '../../shared/page-status';
import { createBadges, type BadgeApi } from '../badge';

const ID = 'ext';
const sender = { id: ID, frameId: 0, tab: { id: 7 } };

function setup(answer: () => Promise<unknown>, granted = true) {
  const api = {
    askPage: vi.fn(answer),
    isGranted: vi.fn(() => Promise.resolve(granted)),
    tabIds: vi.fn(() => Promise.resolve([7])),
    show: vi.fn(() => Promise.resolve()),
  } satisfies BadgeApi;
  return { api, badges: createBadges(api, ID) };
}

const ready = { type: PAGE_READY };
const patched = () => Promise.resolve({ patched: true, origin: 'https://a.test' });
const shownText = (api: { show: ReturnType<typeof vi.fn> }): unknown => (api.show.mock.lastCall?.[1] as { text: string }).text;

describe('badge', () => {
  it('says ON when the page runs Sluice and the site has its grant', async () => {
    const { api, badges } = setup(patched);
    badges.onMessage(ready, sender);
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(api.isGranted).toHaveBeenCalledWith('https://a.test/*');
    expect(api.show.mock.lastCall?.[0 as never]).toBe(7);
    expect(shownText(api)).toBe('ON');
  });

  it('warns when the page still runs Sluice after the grant is gone', async () => {
    const { api, badges } = setup(patched, false);
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(shownText(api)).toBe('!');
  });

  it('is empty when the tab has no bridge', async () => {
    const { api, badges } = setup(() => Promise.reject(new Error('Receiving end does not exist')));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(shownText(api)).toBe('');
  });

  it('is empty when the MAIN script did not run', async () => {
    const { api, badges } = setup(() => Promise.resolve({ patched: false, origin: 'https://a.test' }));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(shownText(api)).toBe('');
  });

  it('is empty on an answer that makes no sense', async () => {
    const { api, badges } = setup(() => Promise.resolve({ patched: 'yes' }));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(shownText(api)).toBe('');
  });

  it('says ON for an opaque origin, which has no grant to check', async () => {
    const { api, badges } = setup(() => Promise.resolve({ patched: true, origin: 'null' }));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(api.isGranted).not.toHaveBeenCalled();
    expect(shownText(api)).toBe('ON');
    expect((api.show.mock.lastCall?.[1 as never] as unknown as { title: string }).title).toContain('until you close it');
  });

  it('is empty for an opaque origin with no patch', async () => {
    const { api, badges } = setup(() => Promise.resolve({ patched: false, origin: 'null' }));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalled());
    expect(shownText(api)).toBe('');
  });

  it.each([
    ['another extension', { ...sender, id: 'other' }],
    ['a frame', { ...sender, frameId: 3 }],
    ['no tab', { id: ID, frameId: 0 }],
  ])('ignores a message from %s', async (_name, from) => {
    const { api, badges } = setup(patched);
    badges.onMessage(ready, from);
    await Promise.resolve();
    expect(api.askPage).not.toHaveBeenCalled();
  });

  it('ignores another message type', () => {
    const { api, badges } = setup(patched);
    badges.onMessage({ type: 'wake' }, sender);
    badges.onMessage(null, sender);
    expect(api.askPage).not.toHaveBeenCalled();
  });

  it('does not let a hung page stop the other tabs', async () => {
    const { api, badges } = setup(patched);
    api.tabIds.mockResolvedValue([1, 2]);
    api.askPage.mockImplementationOnce(() => new Promise(() => undefined));
    await badges.updateAll();
    await vi.waitFor(() => expect(api.show).toHaveBeenCalledTimes(1));
    expect(api.show.mock.lastCall?.[0 as never]).toBe(2);
  });

  it('does not throw when the tab closes first', async () => {
    const { api, badges } = setup(patched);
    api.show.mockRejectedValue(new Error('No tab with id'));
    await expect(badges.updateAll()).resolves.toBeUndefined();
  });
});
