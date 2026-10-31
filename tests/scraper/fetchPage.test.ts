// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFetcher, USER_AGENT } from '../../scripts/scraper/fetchPage';

const TL = 'https://www.1001tracklists.com/tracklist/abc123/some-set.html';
const TL2 = 'https://www.1001tracklists.com/tracklist/def456/other-set.html';

let dir: string;
let clock: number;
let sleeps: number[];
const mkResponse = (body: string, status = 200, cookies: string[] = [], location?: string) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: { getSetCookie: () => cookies, get: (n: string) => (n === 'location' ? location : null) },
  }) as unknown as Response;

function make(fetchImpl: ReturnType<typeof vi.fn>) {
  return createFetcher({
    cacheDir: path.join(dir, 'cache'),
    cookiePath: path.join(dir, 'cookies.json'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0, // minimum jitter
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fetch-'));
  clock = 1_000_000;
  sleeps = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fetchPage', () => {
  it('sends the project user agent and caches the body', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('<html>one</html>'));
    const fetcher = make(f);
    expect(await fetcher.get(TL)).toBe('<html>one</html>');
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'User-Agent': USER_AGENT });
    expect(USER_AGENT).toBe('SetArchitect/0.1 (personal research tool)');
  });

  it('cache hit skips the network, even from a fresh fetcher instance', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('<html>one</html>'));
    await make(f).get(TL);
    const f2 = vi.fn();
    expect(await make(f2).get(TL)).toBe('<html>one</html>');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f2).not.toHaveBeenCalled();
  });

  it('enforces a 2-4s delay between live requests but not before the first', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('x'));
    const fetcher = make(f);
    await fetcher.get(TL);
    expect(sleeps).toEqual([]);
    await fetcher.get(TL2);
    expect(sleeps).toEqual([2000]); // random()=0 -> minimum jitter
  });

  it('counts time already elapsed toward the delay, and spans separate processes', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('x'));
    await make(f).get(TL);
    clock += 500;
    await make(f).get(TL2); // new fetcher = new CLI process, delay is persisted
    expect(sleeps).toEqual([1500]);
  });

  it('does not sleep when a cache hit comes between live requests', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('x'));
    const fetcher = make(f);
    await fetcher.get(TL);
    await fetcher.get(TL);
    expect(sleeps).toEqual([]);
  });

  it('persists cookies (guid) and replays them', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(mkResponse('a', 200, ['guid=abc123; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT']))
      .mockResolvedValueOnce(mkResponse('b'));
    const fetcher = make(f);
    await fetcher.get(TL);
    await fetcher.get(TL2);
    expect((f.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Cookie: 'guid=abc123' });
    const saved = JSON.parse(readFileSync(path.join(dir, 'cookies.json'), 'utf8'));
    expect(saved.cookies.guid).toBe('abc123');
  });

  it('refuses /track/ urls without touching the network', async () => {
    const f = vi.fn();
    await expect(make(f).get('https://www.1001tracklists.com/track/pvmdfcnp/x/index.html')).rejects.toThrow(
      /captcha-gated/
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses other hosts', async () => {
    const f = vi.fn();
    await expect(make(f).get('https://example.com/tracklist/abc/x.html')).rejects.toThrow(/host/);
    expect(f).not.toHaveBeenCalled();
  });

  it('does not cache or retry non-200 responses', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('captcha', 401));
    const fetcher = make(f);
    await expect(fetcher.get(TL)).rejects.toThrow(/401/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
    await expect(fetcher.get(TL)).rejects.toThrow(/401/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('search POSTs main_search + search_selection=9 and caches per query', async () => {
    const f = vi.fn().mockResolvedValue(mkResponse('<html>results</html>'));
    const fetcher = make(f);
    expect(await fetcher.search('Oliver Heldens')).toBe('<html>results</html>');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.1001tracklists.com/search/result.php');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('main_search=Oliver+Heldens&search_selection=9');
    await fetcher.search('Oliver Heldens');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each(['/Track/x/index.html', '//track/x', '/TRACK/x', '/%74rack/x', '//Track//x'])(
    'guard rejects %s',
    async (p) => {
      const f = vi.fn();
      await expect(make(f).get(`https://www.1001tracklists.com${p}`)).rejects.toThrow();
      await expect(make(f).get(p)).rejects.toThrow();
      expect(f).not.toHaveBeenCalled();
    }
  );

  it('blocks a redirect into /track/ and a redirect to another host', async () => {
    const f1 = vi.fn().mockResolvedValue(mkResponse('', 302, [], '/Track/abc/x/index.html'));
    await expect(make(f1).get(TL)).rejects.toThrow(/Blocked redirect/);
    expect(f1).toHaveBeenCalledTimes(1);
    expect((f1.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
    const f2 = vi.fn().mockResolvedValue(mkResponse('', 301, [], 'https://evil.example/x'));
    await expect(make(f2).get(TL)).rejects.toThrow(/Blocked redirect/);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('follows a safe redirect and applies the delay to the extra hop', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(mkResponse('', 301, [], '/tracklist/def456/other-set.html'))
      .mockResolvedValueOnce(mkResponse('final'));
    expect(await make(f).get(TL)).toBe('final');
    expect(f.mock.calls[1][0]).toBe(TL2);
    expect(sleeps).toEqual([2000]);
  });
});
