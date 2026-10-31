// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let user: { id: string } | null;
let isAdmin: boolean | null;

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: isAdmin === null ? null : { is_admin: isAdmin } }) }) }),
    }),
  }),
}));

import { middleware } from '@/middleware';

const call = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  user = { id: 'u1' };
  isAdmin = false;
});

describe('middleware (non-demo)', () => {
  it('redirects anonymous /admin to /login', async () => {
    user = null;
    const res = await call('/admin');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?next=%2Fadmin');
  });

  it('404s a signed-in non-admin on /admin and nested routes', async () => {
    expect((await call('/admin')).status).toBe(404);
    expect((await call('/admin/users')).status).toBe(404);
  });

  it('lets a profile-less user through to nothing on /admin (404)', async () => {
    isAdmin = null;
    expect((await call('/admin')).status).toBe(404);
  });

  it('allows an admin through', async () => {
    isAdmin = true;
    expect((await call('/admin')).status).toBe(200);
  });

  it('allows any signed-in user on / (the builder)', async () => {
    expect((await call('/')).status).toBe(200);
  });

  it('returns JSON 401/403 for /api/admin', async () => {
    expect((await call('/api/admin/health')).status).toBe(403);
    user = null;
    expect((await call('/api/admin/health')).status).toBe(401);
  });

  it('is open in demo mode', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await call('/admin')).status).toBe(200);
  });
});
