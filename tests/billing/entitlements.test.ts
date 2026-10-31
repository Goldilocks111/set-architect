import { describe, expect, it, vi } from 'vitest';
import {
  createEntitlements,
  EntitlementsUnavailableError,
  FREE_PLAYLIST_LIMIT,
  FREE_SUGGESTIONS_PER_DAY,
  startOfUtcDay,
  type EntitlementData,
} from '@/lib/billing/entitlements';

const data = (o: Partial<{ pro: boolean; playlists: number; suggestions: number }>): EntitlementData => ({
  isProUser: async () => o.pro ?? false,
  countPlaylists: async () => o.playlists ?? 0,
  countSuggestionsSince: vi.fn(async () => o.suggestions ?? 0),
});

describe('entitlements', () => {
  it('free: one playlist max', async () => {
    expect(await createEntitlements(data({ playlists: 0 }), { demo: false }).canCreatePlaylist('u')).toBe(true);
    expect(await createEntitlements(data({ playlists: FREE_PLAYLIST_LIMIT }), { demo: false }).canCreatePlaylist('u')).toBe(false);
  });

  it('free: 20 suggestions per day', async () => {
    expect(await createEntitlements(data({ suggestions: 19 }), { demo: false }).canSuggest('u')).toBe(true);
    expect(await createEntitlements(data({ suggestions: FREE_SUGGESTIONS_PER_DAY }), { demo: false }).canSuggest('u')).toBe(false);
  });

  it('counts suggestions since the start of the UTC day', async () => {
    const d = data({});
    await createEntitlements(d, { demo: false, now: () => new Date('2026-10-31T15:30:00Z') }).canSuggest('u');
    expect(d.countSuggestionsSince).toHaveBeenCalledWith('u', '2026-10-31T00:00:00.000Z');
    expect(startOfUtcDay(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10-31T00:00:00.000Z');
  });

  it('pro is unlimited', async () => {
    const e = createEntitlements(data({ pro: true, playlists: 50, suggestions: 500 }), { demo: false });
    expect(await e.canCreatePlaylist('u')).toBe(true);
    expect(await e.canSuggest('u')).toBe(true);
  });

  it('demo mode is unlimited and never touches data', async () => {
    const e = createEntitlements(null, { demo: true });
    expect(await e.canCreatePlaylist('u')).toBe(true);
    expect(await e.canSuggest('u')).toBe(true);
  });

  it('fails closed outside demo mode when the data source is missing', async () => {
    const e = createEntitlements(null, { demo: false });
    await expect(e.canCreatePlaylist('u')).rejects.toBeInstanceOf(EntitlementsUnavailableError);
    await expect(e.canSuggest('u')).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('fails closed when a count query errors', async () => {
    const broken: EntitlementData = {
      isProUser: async () => false,
      countPlaylists: async () => {
        throw new EntitlementsUnavailableError('boom');
      },
      countSuggestionsSince: async () => {
        throw new EntitlementsUnavailableError('boom');
      },
    };
    const e = createEntitlements(broken, { demo: false });
    await expect(e.canCreatePlaylist('u')).rejects.toThrow(/boom/);
    await expect(e.canSuggest('u')).rejects.toThrow(/boom/);
  });
});
