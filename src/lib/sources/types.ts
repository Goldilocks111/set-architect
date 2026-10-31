import type { Track } from '@/types/track';

export interface SourceAdapter {
  name: string;
  /** Overrides the resolver's default per-adapter timeout (slow, rate-limited sources). */
  timeoutMs?: number;
  /** Provenance label to record instead of the adapter name for specific fields (e.g. estimates). */
  fieldLabels?: Partial<Record<keyof Track, string>>;
  configured(): boolean;
  enrich(partial: Track): Promise<Partial<Track>>;
}
