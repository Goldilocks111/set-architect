import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_URL } from './parseSearch';

export const USER_AGENT = 'SetArchitect/0.1 (personal research tool)';
export const MIN_DELAY_MS = 2000;
export const MAX_DELAY_MS = 4000;

const HOST = new URL(BASE_URL).host;
const SEARCH_URL = `${BASE_URL}/search/result.php`;

export interface FetcherOptions {
  cacheDir?: string;
  cookiePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface Fetcher {
  get(url: string): Promise<string>;
  search(query: string): Promise<string>;
}

interface CookieFile {
  cookies: Record<string, string>;
  lastRequestAt?: number; // persisted so the delay also holds across separate CLI runs
}

export class FetchError extends Error {
  constructor(
    public readonly status: number,
    url: string,
    detail?: string
  ) {
    super(detail ?? `HTTP ${status} for ${url}`);
    this.name = 'FetchError';
  }
}

export const BLOCK_STATUSES = [401, 403, 429];
const MAX_REDIRECTS = 5;

export function createFetcher(opts: FetcherOptions = {}): Fetcher {
  const cacheDir = opts.cacheDir ?? path.join(process.cwd(), 'data', 'cache', '1001tl');
  const cookiePath = opts.cookiePath ?? path.join(process.cwd(), 'data', 'cache', 'cookies.json');
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  const readJar = (): CookieFile => {
    if (!existsSync(cookiePath)) return { cookies: {} };
    try {
      return JSON.parse(readFileSync(cookiePath, 'utf8')) as CookieFile;
    } catch {
      return { cookies: {} };
    }
  };
  const writeJar = (jar: CookieFile) => {
    mkdirSync(path.dirname(cookiePath), { recursive: true });
    const tmp = `${cookiePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(jar, null, 2));
    renameSync(tmp, cookiePath);
  };

  /** Resolves against the base, then enforces host + no /track/ on the normalized path. */
  const guard = (url: string): string => {
    const u = new URL(url, BASE_URL);
    if (u.host !== HOST) throw new Error(`Refusing to fetch host ${u.host}; only ${HOST} is allowed`);
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep raw path */
    }
    p = p.toLowerCase().replace(/\/{2,}/g, '/');
    if (p === '/track' || p.startsWith('/track/')) {
      throw new Error(`Refusing to fetch ${u.pathname}: /track/ pages are captcha-gated`);
    }
    return u.toString();
  };

  const cachePath = (key: string) =>
    path.join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.html`);

  const live = async (startUrl: string, startInit: RequestInit): Promise<string> => {
    const jar = readJar();
    let url = startUrl;
    let init = startInit;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (jar.lastRequestAt !== undefined) {
        const gap = MIN_DELAY_MS + random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        const wait = jar.lastRequestAt + gap - now();
        if (wait > 0) await sleep(wait);
      }
      jar.lastRequestAt = now();
      writeJar(jar);

      const cookie = Object.entries(jar.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      const res = await doFetch(url, {
        ...init,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          ...(init.headers as Record<string, string> | undefined),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });

      for (const line of res.headers.getSetCookie?.() ?? []) {
        const m = line.match(/^([^=;\s]+)=([^;]*)/);
        if (m) jar.cookies[m[1]] = m[2];
      }
      writeJar(jar);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get?.('location');
        if (!location) throw new FetchError(res.status, url, `HTTP ${res.status} without Location for ${url}`);
        try {
          url = guard(new URL(location, url).toString());
        } catch (err) {
          throw new FetchError(res.status, url, `Blocked redirect from ${url} to ${location}: ${(err as Error).message}`);
        }
        if ([301, 302, 303].includes(res.status)) init = { method: 'GET' };
        continue;
      }
      if (res.status !== 200) throw new FetchError(res.status, url);
      return res.text();
    }
    throw new FetchError(310, startUrl, `Too many redirects for ${startUrl}`);
  };

  const cached = async (key: string, run: () => Promise<string>): Promise<string> => {
    const file = cachePath(key);
    if (existsSync(file)) return readFileSync(file, 'utf8');
    const body = await run();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, body);
    return body;
  };

  return {
    async get(url) {
      const safe = guard(url);
      return cached(`GET ${safe}`, () => live(safe, { method: 'GET' }));
    },
    async search(query) {
      const body = new URLSearchParams({ main_search: query, search_selection: '9' }).toString();
      return cached(`POST ${SEARCH_URL} ${body}`, () =>
        live(SEARCH_URL, {
          method: 'POST',
          body,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE_URL}/`,
          },
        })
      );
    },
  };
}
