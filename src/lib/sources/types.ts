import type { Track } from '@/types/track';

export interface SourceAdapter {
  name: string;
  configured(): boolean;
  enrich(partial: Track): Promise<Partial<Track>>;
}
