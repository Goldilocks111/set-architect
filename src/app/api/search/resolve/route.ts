import { demoTracks } from '@/lib/demo';
import { ESSENTIALS, RETRYABLE_REASONS } from '@/lib/completeness';
import { mergeSeedMetadata } from '@/lib/seedMerge';
import { trackKeyOf, type Track } from '@/types/track';

const BUDGET_MS = 45_000; // under the 60 s acceptance criterion
const GRACE_MS = 2_000; // the resolver enforces the budget itself; this only guards a hung resolver

/** Full metadata (bpm/key/energy/preview) for one track: GET ?artist=…&title=… */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const artist = (params.get('artist') ?? '').trim().slice(0, 200);
  const title = (params.get('title') ?? '').trim().slice(0, 200);
  if (!artist || !title) return Response.json({ error: 'Pass both ?artist= and ?title=' }, { status: 400 });

  let track: Track | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isHung = false;
  try {
    const { resolveWithStatus } = await import('@/lib/resolver');
    const hung = new Promise<Track>((resolve) => {
      timer = setTimeout(() => {
        isHung = true;
        resolve({ id: trackKeyOf(artist, title), artist, title, sources: {}, unresolved: { reason: 'timeout', missing: [...ESSENTIALS] } });
      }, BUDGET_MS + GRACE_MS);
    });
    track = await Promise.race([resolveWithStatus(artist, title, { budgetMs: BUDGET_MS }), hung]);
  } catch {
    const key = trackKeyOf(artist, title);
    track = demoTracks().find((t) => trackKeyOf(t.artist, t.title) === key);
  } finally {
    clearTimeout(timer);
  }
  if (!track) return Response.json({ error: 'Track not found' }, { status: 404 });
  const merged = mergeSeedMetadata(track);
  if (track.unresolved) {
    // demo-seed fill may have completed it; keep the gate honest about what is still missing
    const missing = track.unresolved.missing.filter((f) => merged[f] === undefined);
    if (missing.length) {
      const { reason } = track.unresolved;
      let retryAt = track.unresolved.retryAt;
      // resolveWithStatus schedules its own retries; only a hung resolver never got that far
      if (isHung && RETRYABLE_REASONS.includes(reason) && retryAt === undefined) {
        const { scheduleRetry } = await import('@/lib/reresolve');
        retryAt = scheduleRetry(artist, title, reason);
      }
      merged.unresolved = { reason, missing, ...(retryAt !== undefined ? { retryAt } : {}) };
    } else delete merged.unresolved;
  }
  return Response.json({ track: merged });
}
