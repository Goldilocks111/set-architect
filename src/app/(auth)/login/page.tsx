import Link from 'next/link';
import { isDemoMode } from '@/lib/demo';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {isDemoMode() ? (
        <>
          <p>Demo mode — Supabase not configured. No login is needed.</p>
          <Link href="/" className="underline">
            Continue to the app
          </Link>
        </>
      ) : (
        <LoginForm />
      )}
    </main>
  );
}
