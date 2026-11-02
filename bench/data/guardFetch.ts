import { isRateLimited, type RequestGate } from '../search/guard';

export const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)deezer\.com$/, 'deezer'],
  [/(^|\.)dzcdn\.net$/, 'deezer-cdn'], // preview audio; uncounted
  [/(^|\.)spotify\.com$/, 'spotify'],
  [/(^|\.)musicbrainz\.org$/, 'musicbrainz'],
  [/(^|\.)reccobeats\.com$/, 'reccobeats'],
  [/(^|\.)audioscrobbler\.com$/, 'lastfm'],
];

/** Thrown (not an HttpError) so the app's persisted breaker never sees bench refusals. */
export class BenchRefused extends Error {}

export interface FetchGuard {
  fetch: typeof fetch;
  /** provider -> reason; a provider here receives no further calls this run. */
  stopped: Map<string, string>;
  /** provider -> calls the guard refused (stopped or over budget). */
  refused: Record<string, number>;
}

/** Deezer reports quota errors as HTTP 200 with {"error":{"code":4,...}}. */
async function deezerQuotaBody(res: Response): Promise<boolean> {
  try {
    const j = (await res.clone().json()) as { error?: { code?: number } };
    return j?.error?.code === 4;
  } catch {
    return false;
  }
}

export function createFetchGuard(o: {
  real: typeof fetch;
  gates: Map<string, RequestGate>;
  gapMs: Record<string, number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): FetchGuard {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stopped = new Map<string, string>();
  const refused: Record<string, number> = {};
  const lastCall = new Map<string, number>();
  const refuse = (provider: string, why: string): never => {
    refused[provider] = (refused[provider] ?? 0) + 1;
    throw new BenchRefused(`${provider} ${why}`);
  };

  const guarded = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    const provider = HOSTS.find(([re]) => re.test(host))?.[1];
    if (!provider) return o.real(input, init);
    if (stopped.has(provider)) refuse(provider, `stopped for this run (${stopped.get(provider)})`);
    const wait = (lastCall.get(provider) ?? -Infinity) + (o.gapMs[provider] ?? 0) - now();
    if (wait > 0) await sleep(wait);
    const gate = o.gates.get(provider);
    if (gate && !gate.take()) refuse(provider, 'budget exhausted');
    lastCall.set(provider, now());
    const res = await o.real(input, init);
    if (isRateLimited(provider, { status: res.status })) {
      stopped.set(provider, `HTTP ${res.status}, retry-after ${res.headers.get('retry-after') ?? 'n/a'}`);
    } else if (provider === 'deezer' && res.ok && (await deezerQuotaBody(res))) {
      stopped.set(provider, 'quota error body (code 4)');
    }
    return res;
  }) as typeof fetch;

  return { fetch: guarded, stopped, refused };
}
