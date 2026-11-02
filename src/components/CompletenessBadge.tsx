import { missingEssentials, type Essential, type IncompleteReason } from '@/lib/completeness';
import type { Track } from '@/types/track';

export const REASON_COPY: Record<IncompleteReason, string> = {
  'not-found': 'No provider has this track',
  'no-preview': 'No preview to analyse — set values by hand',
  'analysis-failed': 'Couldn’t analyse the preview — set values by hand',
  'providers-unavailable': 'Providers busy — retrying automatically',
  timeout: 'Still looking — retrying automatically',
  exhausted: 'Couldn’t find full data after several tries — set values by hand',
};

const FIELD_LABEL: Record<Essential, string> = { bpm: 'BPM', camelot: 'key', energy: 'energy', danceability: 'danceability' };

interface Props {
  track: Track;
  resolving: boolean;
}

export default function CompletenessBadge({ track, resolving }: Props) {
  const missing = missingEssentials(track);
  if (missing.length === 0) {
    return <span className="shrink-0 text-[11.5px] text-[#7DD3A8]">Complete</span>;
  }
  if (resolving) {
    return (
      <span role="status" className="shrink-0 motion-safe:animate-pulse text-[11.5px] text-[#F2B33D]">
        Resolving…
      </span>
    );
  }
  // Without a verdict from the resolver yet, say we are still looking rather than guessing a permanent cause.
  const reason = track.unresolved?.reason ?? 'timeout';
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11.5px] text-[#EE8B7A]">
      <span>{`Incomplete — ${REASON_COPY[reason]}`}</span>
      <span className="text-[#8A8FA3]">Missing: {missing.map((f) => FIELD_LABEL[f]).join(', ')}</span>
    </span>
  );
}

/** Quiet mark for search hits and suggestion cards: informative, not an alarm. */
export function CompletenessMark({ track }: { track: Track }) {
  const missing = missingEssentials(track);
  if (missing.length === 0) return <span className="text-[11px] text-[#7DD3A8]">Complete</span>;
  return (
    <span className="text-[11px] text-[#8A8FA3]">
      Not yet analysed · missing {missing.map((f) => FIELD_LABEL[f]).join(', ')}
    </span>
  );
}
