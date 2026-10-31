import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class EntitlementsUnavailableError extends Error {}
  return {
    EntitlementsUnavailableError,
    demo: false,
    getCurrentUser: vi.fn(),
    canSuggest: vi.fn(),
    recordSuggestion: vi.fn(),
    assemble: vi.fn(),
  };
});

vi.mock('@/lib/demo', () => ({ isDemoMode: () => m.demo }));
vi.mock('@/lib/supabase/auth', () => ({ getCurrentUser: m.getCurrentUser }));
vi.mock('@/lib/billing/entitlements', () => ({
  canSuggest: m.canSuggest,
  recordSuggestion: m.recordSuggestion,
  EntitlementsUnavailableError: m.EntitlementsUnavailableError,
}));
vi.mock('@/app/api/suggest/assemble', () => ({
  assembleSuggestions: m.assemble,
  loadSuggestDeps: async () => ({}),
}));

import { POST } from '@/app/api/suggest/route';

const req = () =>
  new Request('http://x/api/suggest', { method: 'POST', body: JSON.stringify({ playlist: [], template: '60min' }) });

describe('/api/suggest entitlements gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.demo = false;
    m.assemble.mockResolvedValue({ suggestions: [] });
  });

  it('does not gate demo mode', async () => {
    m.demo = true;
    expect((await POST(req())).status).toBe(200);
    expect(m.canSuggest).not.toHaveBeenCalled();
  });

  it('does not gate anonymous users', async () => {
    m.getCurrentUser.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(200);
    expect(m.canSuggest).not.toHaveBeenCalled();
  });

  it('returns 429 over the limit and does not run or record', async () => {
    m.getCurrentUser.mockResolvedValue({ id: 'u1' });
    m.canSuggest.mockResolvedValue(false);
    expect((await POST(req())).status).toBe(429);
    expect(m.assemble).not.toHaveBeenCalled();
    expect(m.recordSuggestion).not.toHaveBeenCalled();
  });

  it('records usage after a successful call', async () => {
    m.getCurrentUser.mockResolvedValue({ id: 'u1' });
    m.canSuggest.mockResolvedValue(true);
    expect((await POST(req())).status).toBe(200);
    expect(m.recordSuggestion).toHaveBeenCalledWith('u1');
  });

  it('returns 503 when entitlements are unavailable', async () => {
    m.getCurrentUser.mockResolvedValue({ id: 'u1' });
    m.canSuggest.mockRejectedValue(new m.EntitlementsUnavailableError('down'));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'entitlements unavailable' });
  });
});
