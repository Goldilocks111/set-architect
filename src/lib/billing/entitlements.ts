import { isDemoMode } from '@/lib/demo';
import { createAdminClient } from '@/lib/supabase/admin';
import { isPro } from './subscription-store';

export const FREE_PLAYLIST_LIMIT = 1;
export const FREE_SUGGESTIONS_PER_DAY = 20;

export class EntitlementsUnavailableError extends Error {
  constructor(reason: string) {
    super(`Entitlements unavailable: ${reason}`);
    this.name = 'EntitlementsUnavailableError';
  }
}

export type EntitlementData = {
  isProUser(userId: string): Promise<boolean>;
  countPlaylists(userId: string): Promise<number>;
  countSuggestionsSince(userId: string, sinceIso: string): Promise<number>;
};

function supabaseData(): EntitlementData | null {
  const db = createAdminClient();
  if (!db) return null;
  return {
    async isProUser(userId) {
      const { data, error } = await db.from('subscriptions').select('status,plan').eq('user_id', userId).maybeSingle();
      if (error) throw new EntitlementsUnavailableError(error.message);
      return !!data && data.plan === 'pro' && isPro(data.status);
    },
    async countPlaylists(userId) {
      const { count, error } = await db.from('playlists').select('id', { count: 'exact', head: true }).eq('user_id', userId);
      if (error || count === null) throw new EntitlementsUnavailableError(error?.message ?? 'no count');
      return count;
    },
    async countSuggestionsSince(userId, sinceIso) {
      const { count, error } = await db
        .from('usage_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('kind', 'suggestion')
        .gte('created_at', sinceIso);
      if (error || count === null) throw new EntitlementsUnavailableError(error?.message ?? 'no count');
      return count;
    },
  };
}

export function startOfUtcDay(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function createEntitlements(data: EntitlementData | null, opts: { demo: boolean; now?: () => Date }) {
  // Fails closed outside demo mode: missing data source or a failed query throws EntitlementsUnavailableError.
  const source = (): EntitlementData => {
    if (!data) throw new EntitlementsUnavailableError('SUPABASE_SERVICE_ROLE_KEY not configured');
    return data;
  };
  const unlimited = async (userId: string) => opts.demo || (await source().isProUser(userId));
  return {
    async canCreatePlaylist(userId: string): Promise<boolean> {
      if (await unlimited(userId)) return true;
      return (await source().countPlaylists(userId)) < FREE_PLAYLIST_LIMIT;
    },
    async canSuggest(userId: string): Promise<boolean> {
      if (await unlimited(userId)) return true;
      const since = startOfUtcDay(opts.now?.());
      return (await source().countSuggestionsSince(userId, since)) < FREE_SUGGESTIONS_PER_DAY;
    },
  };
}

export function canCreatePlaylist(userId: string) {
  return createEntitlements(supabaseData(), { demo: isDemoMode() }).canCreatePlaylist(userId);
}

export function canSuggest(userId: string) {
  return createEntitlements(supabaseData(), { demo: isDemoMode() }).canSuggest(userId);
}

/** Records one suggestion call against the user's daily quota. Fails closed like the checks. */
export async function recordSuggestion(userId: string): Promise<void> {
  const db = createAdminClient();
  if (!db) throw new EntitlementsUnavailableError('SUPABASE_SERVICE_ROLE_KEY not configured');
  const { error } = await db.from('usage_events').insert({ user_id: userId, kind: 'suggestion' });
  if (error) throw new EntitlementsUnavailableError(error.message);
}
