'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setState('error');
      setMessage(error.message);
    } else {
      setState('sent');
    }
  }

  if (state === 'sent') return <p>Check {email} for your sign-in link.</p>;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded border px-3 py-2"
      />
      <button type="submit" disabled={state === 'sending'} className="rounded bg-black px-3 py-2 text-white">
        {state === 'sending' ? 'Sending...' : 'Email me a magic link'}
      </button>
      {state === 'error' && <p role="alert">{message}</p>}
    </form>
  );
}
