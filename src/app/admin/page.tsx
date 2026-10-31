import { Suspense } from 'react';
import AdminContent from './AdminContent';

export default function AdminPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl p-8">Loading…</main>}>
      <AdminContent />
    </Suspense>
  );
}
