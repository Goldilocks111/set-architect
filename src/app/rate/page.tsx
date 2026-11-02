import { notFound } from 'next/navigation';
import RatingSession from '@/components/RatingSession';

/** Dev/demo only: the owner's blind rating session for the recommendation bench. */
export default function RatePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <RatingSession />;
}
