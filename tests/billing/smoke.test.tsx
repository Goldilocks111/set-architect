import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/resolver', () => ({ adapterHealth: () => [{ name: 'getsongbpm', configured: true }, { name: 'lastfm', configured: false }] }));

import LoginPage from '@/app/(auth)/login/page';
import WelcomePage from '@/app/(auth)/welcome/page';
import AdminPage from '@/app/admin/AdminContent';
import { getAdapterHealth } from '@/lib/supabase/adapter-health';

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe('demo-mode pages render without env', () => {
  it('login shows demo notice', () => {
    render(<LoginPage />);
    expect(screen.getByText(/Demo mode — Supabase not configured/)).toBeInTheDocument();
  });

  it('welcome shows demo notice', () => {
    render(<WelcomePage />);
    expect(screen.getByText(/Demo mode — Supabase not configured/)).toBeInTheDocument();
  });

  it('admin renders placeholder users and adapter health', async () => {
    render(await AdminPage());
    expect(screen.getByText(/placeholder data/)).toBeInTheDocument();
    expect(screen.getByText('dj.alpha@example.com')).toBeInTheDocument();
    expect(screen.getByText(/getsongbpm: enabled/)).toBeInTheDocument();
    expect(screen.getByText(/lastfm: disabled/)).toBeInTheDocument();
  });

  it('adapter health falls back to [] when the resolver throws', async () => {
    vi.resetModules();
    vi.doMock('@/lib/resolver', () => {
      throw new Error('missing');
    });
    const { getAdapterHealth: fresh } = await import('@/lib/supabase/adapter-health');
    expect(await fresh()).toEqual([]);
    expect(typeof getAdapterHealth).toBe('function');
  });
});
