import { demoTracks } from '@/lib/demo';
import { mergeSeedMetadata } from '@/lib/seedMerge';
import { trackKeyOf, type Track } from '@/types/track';

/** Full metadata (bpm/key/energy/preview) for one track: GET ?artist=…&title=… */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const artist = (params.get('artist') ?? '').trim().slice(0, 200);
  const title = (params.get('title') ?? '').trim().slice(0, 200);
  if (!artist || !title) return Response.json({ error: 'Pass both ?artist= and ?title=' }, { status: 400 });

  let track: Track | undefined;
  try {
    const { resolveTrack } = await import('@/lib/resolver');
    track = await resolveTrack(artist, title);
  } catch {
    const key = trackKeyOf(artist, title);
    track = demoTracks().find((t) => trackKeyOf(t.artist, t.title) === key);
  }
  if (!track) return Response.json({ error: 'Track not found' }, { status: 404 });
  return Response.json({ track: mergeSeedMetadata(track) });
}
