import { searchDemoTracks } from '@/lib/demo';
import { mergeSeedMetadata } from '@/lib/seedMerge';
import type { Track } from '@/types/track';

const MAX_RESULTS = 20;

export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 200);
  if (!q) return Response.json({ tracks: [] });

  let tracks: Track[];
  try {
    const { searchTracks } = await import('@/lib/resolver');
    tracks = await searchTracks(q);
  } catch {
    tracks = searchDemoTracks(q);
  }
  return Response.json({ tracks: tracks.slice(0, MAX_RESULTS).map(mergeSeedMetadata) });
}
