// What a page really runs, as opposed to what is granted. The script of a page stays until the page reloads, so the
// two can differ in both directions. The answer comes from the bridge of the top frame.
export const GET_PAGE_STATUS = 'get-page-status';
export const PAGE_READY = 'page-ready';

export interface PageStatus {
  /** The MAIN script took the nonce, so it ran. */
  patched: boolean;
  /**
   * `self.origin`, for an about:blank page: it has the origin of its opener there and 'null' in `location.origin`. Else
   * `location.origin`, for a sandboxed page: grants match its URL, so that is the site that can turn it off. 'null' = neither.
   */
  origin: string;
}

/** 'unknown' = the page did not answer. A hung page cannot answer, and the popup must still work on it. */
export type PageState = 'running' | 'stale' | 'pending' | 'off' | 'unknown';

/** @param patched Null when the page did not answer. */
export function pageState(patched: boolean | null, granted: boolean): PageState {
  if (patched === null) return 'unknown';
  if (patched) return granted ? 'running' : 'stale';
  return granted ? 'pending' : 'off';
}

export function parsePageStatus(value: unknown): PageStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const { patched, origin } = value as Partial<PageStatus>;
  return typeof patched === 'boolean' && typeof origin === 'string' ? { patched, origin } : null;
}
