import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SuggestionBox from '@/components/SuggestionBox';
import { mergeSeedMetadata } from '@/lib/seedMerge';
import { assembleSuggestions, loadSuggestDeps } from '@/app/api/suggest/assemble';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf } from '@/types/track';

const mocks = vi.hoisted(() => ({
  resolver: { searchTracks: vi.fn(), resolveTrack: vi.fn(), resolveWithStatus: vi.fn(), getSimilarTracks: vi.fn() },
  adjacency: {
    loadAdjacency: vi.fn(),
    readData: vi.fn(),
    ADJACENCY_PATH: '/index/adjacency.json',
    DEMO_ADJACENCY_PATH: '/seed/adjacency.demo.json',
  },
  stripe: { getStripe: vi.fn(), billingNotConfigured: vi.fn(), appUrl: () => 'https://app.test' },
  server: { createClient: vi.fn() },
}));
vi.mock('@/lib/resolver', () => mocks.resolver);
vi.mock('@/lib/adjacency', () => mocks.adjacency);
vi.mock('@/lib/billing/stripe', () => mocks.stripe);
vi.mock('@/lib/supabase/server', () => mocks.server);

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('seed metadata merge (I1)', () => {
  it('/api/search/resolve fills Glue from the seed when adapters return nothing', async () => {
    mocks.resolver.resolveWithStatus.mockResolvedValue({ id: 'live-1', artist: 'Bicep', title: 'Glue', sources: {} });
    const { GET } = await import('@/app/api/search/resolve/route');
    const { track } = await (await GET(new Request('http://x/api/search/resolve?artist=Bicep&title=Glue'))).json();
    expect(track).toMatchObject({ id: 'live-1', bpm: 128, camelot: '9A', energy: 6 });
    expect(track.sources).toEqual({ bpm: 'demo-seed', camelot: 'demo-seed', energy: 'demo-seed' });
  });

  it('does not overwrite fields an adapter already supplied', () => {
    const t = mergeSeedMetadata({ id: 'x', artist: 'Bicep', title: 'Glue', bpm: 130, sources: { bpm: 'getsongbpm' } });
    expect(t.bpm).toBe(130);
    expect(t.sources.bpm).toBe('getsongbpm');
    expect(t.camelot).toBe('9A');
  });

  it('/api/search results are merged too', async () => {
    mocks.resolver.searchTracks.mockResolvedValue([{ id: 's', artist: 'Bicep', title: 'Glue', sources: {} }]);
    const { GET } = await import('@/app/api/search/route');
    const { tracks } = await (await GET(new Request('http://x/api/search?q=glue'))).json();
    expect(tracks[0].bpm).toBe(128);
  });
});

describe('co-occurrence provenance (I4)', () => {
  const seed = demoTracks();
  const last = seed[0];
  const target = seed[1];
  const handle = (getNeighbors: (k: string) => Promise<unknown[]>) =>
    ({ pairCount: 1, trackCount: 1, getNeighbors }) as never;

  it('labels demo-adjacency counts as sample sets', async () => {
    const res = await assembleSuggestions(
      { playlist: [last], arc: { minutes: 60, shape: 'build' } },
      {
        loadAdjacency: async () =>
          handle(async () => [{ trackKey: trackKeyOf(target.artist, target.title), count: 3, direction: 'after', sample: true }]),
      }
    );
    const label = res.suggestions.find((s) => s.track.id === target.id)!.reasons.find((r) => r.kind === 'cooccurrence')!.label;
    expect(label).toMatch(/in 3 sample sets$/);
  });

  it('keeps "real sets" for scraped neighbors', async () => {
    const res = await assembleSuggestions(
      { playlist: [last], arc: { minutes: 60, shape: 'build' } },
      {
        loadAdjacency: async () =>
          handle(async () => [{ trackKey: trackKeyOf(target.artist, target.title), count: 2, direction: 'after' }]),
      }
    );
    const label = res.suggestions.find((s) => s.track.id === target.id)!.reasons.find((r) => r.kind === 'cooccurrence')!.label;
    expect(label).toMatch(/in 2 real sets$/);
  });

  it('outside demo mode never falls back to the demo adjacency', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    const demoNeighbors = vi.fn(async () => [{ trackKey: 'a|b', count: 4, direction: 'after' }]);
    mocks.adjacency.readData.mockReturnValue({ names: {} });
    mocks.adjacency.loadAdjacency.mockImplementation(async (p?: string) =>
      p ? { pairCount: 1, trackCount: 1, getNeighbors: demoNeighbors } : { pairCount: 0, trackCount: 0, getNeighbors: async () => [] }
    );
    const deps = await loadSuggestDeps();
    const h = await deps.loadAdjacency!();
    expect(await h.getNeighbors('x|y')).toEqual([]);
    expect(demoNeighbors).not.toHaveBeenCalled();
  });

  it('in demo mode falls back and flags the neighbors as sample', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    mocks.adjacency.readData.mockReturnValue({ names: {} });
    mocks.adjacency.loadAdjacency.mockImplementation(async (p?: string) =>
      p
        ? { pairCount: 1, trackCount: 1, getNeighbors: async () => [{ trackKey: 'a|b', count: 4, direction: 'after' }] }
        : { pairCount: 0, trackCount: 0, getNeighbors: async () => [] }
    );
    const h = await (await loadSuggestDeps()).loadAdjacency!();
    expect(await h.getNeighbors('x|y')).toEqual([{ trackKey: 'a|b', count: 4, direction: 'after', sample: true }]);
  });
});

describe('Stripe return URLs (I3)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.STRIPE_PRICE_PRO = 'price_1';
    mocks.server.createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.c' } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { stripe_customer_id: 'cus_1' } }) }) }) }),
    });
  });

  it('checkout success and cancel return to the builder at /', async () => {
    const create = vi.fn(async () => ({ url: 'https://stripe.test/c' }));
    mocks.stripe.getStripe.mockReturnValue({ checkout: { sessions: { create } } });
    const { POST } = await import('@/app/api/stripe/checkout/route');
    await POST();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ success_url: 'https://app.test/?upgraded=1', cancel_url: 'https://app.test/' })
    );
  });

  it('portal returns to /', async () => {
    const create = vi.fn(async () => ({ url: 'https://stripe.test/p' }));
    mocks.stripe.getStripe.mockReturnValue({ billingPortal: { sessions: { create } } });
    const { POST } = await import('@/app/api/stripe/portal/route');
    await POST();
    expect(create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://app.test/' });
  });
});

describe('<SuggestionBox /> daily limit (I3)', () => {
  it('shows the 429 message distinctly, not the generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Daily suggestion limit reached. Upgrade for unlimited suggestions.' }), { status: 429 }))
    );
    render(<SuggestionBox tracks={[]} arc={{ minutes: 60, shape: 'build' }} onAdd={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Daily suggestion limit reached'));
    expect(screen.queryByText(/Couldn.t load suggestions/)).toBeNull();
  });
});
