import Link from 'next/link';
import { isDemoMode } from '@/lib/demo';

export default function WelcomePage() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Welcome to Set Architect</h1>
      {isDemoMode() && <p>Demo mode — Supabase not configured. Everything below works without an account.</p>}
      <ol className="list-decimal pl-5">
        <li>Search for a track you love.</li>
        <li>Build your set along an energy arc.</li>
        <li>Preview suggestions that mix well by key, BPM and energy.</li>
      </ol>
      <p>The free plan includes 1 playlist and 20 suggestions per day.</p>
      <Link href="/" className="underline">
        Start building
      </Link>
    </main>
  );
}
