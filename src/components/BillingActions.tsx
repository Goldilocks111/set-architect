'use client';

import { useState } from 'react';

type Action = 'checkout' | 'portal';

/** Upgrade / Manage billing; only rendered when Supabase is configured (non-demo). */
export default function BillingActions() {
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const go = async (action: Action) => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch(`/api/stripe/${action}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (res.status === 401) setMessage('Sign in to manage your plan.');
      else if (res.status === 404 && action === 'portal') setMessage('No active subscription yet. Upgrade first.');
      else if (res.status === 503) setMessage('Billing is not available right now.');
      else setMessage('Something went wrong. Try again.');
    } catch {
      setMessage('Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const btn =
    'rounded-md px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-[#F2B33D] disabled:opacity-50';
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => go('checkout')}
        className={`${btn} bg-[#F2B33D] font-medium text-[#12141C]`}
      >
        {busy === 'checkout' ? 'Opening…' : 'Upgrade'}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => go('portal')}
        className={`${btn} text-[#8A8FA3] hover:text-[#E8E4DA]`}
      >
        {busy === 'portal' ? 'Opening…' : 'Manage billing'}
      </button>
      {message && (
        <span role="status" className="text-[12px] text-[#EE8B7A]">
          {message}
        </span>
      )}
    </div>
  );
}
