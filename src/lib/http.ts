export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export class HttpError extends Error {
  constructor(public status: number, url: string, public retryAfterMs?: number) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** Retry-After as milliseconds (delta-seconds or HTTP-date); undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export const DEFAULT_TIMEOUT_MS = 4000;

/** fetch with an abort timeout; retries once on network errors and 5xx (never on timeouts or 4xx). */
export async function fetchWithTimeout(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, headers, method, body } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers, method, body });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(res.status, url);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url, parseRetryAfter(res.headers.get('retry-after')));
      return res;
    } catch (err) {
      if (timedOut) throw new Error(`Timeout after ${timeoutMs}ms for ${url}`);
      if (err instanceof HttpError && err.status < 500) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithTimeout(url, opts);
  return (await res.json()) as T;
}

/** Rejects if `p` does not settle within `ms`, regardless of whether the underlying work honours abort. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
