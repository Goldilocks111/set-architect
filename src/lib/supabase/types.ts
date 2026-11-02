// Hand-written row types mirroring supabase/migrations/0001_init.sql.
type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};

export type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
};

export type TrackRow = {
  id: string;
  artist: string;
  title: string;
  remix: string | null;
  bpm: number | null;
  camelot: string | null;
  energy: number | null;
  danceability: number | null;
  popularity: number | null;
  isrc: string | null;
  preview_url: string | null;
  itunes_url: string | null;
  artwork_url: string | null;
  youtube_url: string | null;
  year: number | null;
  sources: Json;
  created_at: string;
};

export type TrackFeaturesRow = { track_id: string; features: Json; source: string | null; updated_at: string };
export type TracklistRow = {
  id: string;
  source_url: string | null;
  dj: string | null;
  event: string | null;
  played_at: string | null;
  created_at: string;
};
export type TracklistEntryRow = { tracklist_id: string; position: number; track_id: string };
export type AdjacencyRow = { from_track_id: string; to_track_id: string; count: number };
/** arc_template holds lib/arc encodeArc text ("90min:journey"); rows saved before it hold '60min' / '120min'. */
export type PlaylistRow = { id: string; user_id: string; name: string; arc_template: string; created_at: string };
export type PlaylistTrackRow = { playlist_id: string; position: number; track_id: string };

export type SubscriptionStatus = string;
export type SubscriptionRow = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  plan: 'free' | 'pro';
  current_period_end: string | null;
  updated_at: string;
};
export type UsageEventRow = { id: number; user_id: string; kind: string; created_at: string };
export type ProcessedStripeEventRow = { event_id: string; processed_at: string };

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, Pick<ProfileRow, 'id'> & Partial<ProfileRow>>;
      tracks: Table<TrackRow, Pick<TrackRow, 'id' | 'artist' | 'title'> & Partial<TrackRow>>;
      track_features: Table<TrackFeaturesRow, Pick<TrackFeaturesRow, 'track_id'> & Partial<TrackFeaturesRow>>;
      tracklists: Table<TracklistRow, Pick<TracklistRow, 'id'> & Partial<TracklistRow>>;
      tracklist_entries: Table<TracklistEntryRow, TracklistEntryRow>;
      adjacency: Table<AdjacencyRow, Pick<AdjacencyRow, 'from_track_id' | 'to_track_id'> & Partial<AdjacencyRow>>;
      playlists: Table<PlaylistRow, Pick<PlaylistRow, 'user_id' | 'name'> & Partial<PlaylistRow>>;
      playlist_tracks: Table<PlaylistTrackRow, PlaylistTrackRow>;
      subscriptions: Table<SubscriptionRow, Pick<SubscriptionRow, 'user_id'> & Partial<SubscriptionRow>>;
      usage_events: Table<UsageEventRow, Pick<UsageEventRow, 'user_id' | 'kind'> & Partial<UsageEventRow>>;
      processed_stripe_events: Table<ProcessedStripeEventRow, Pick<ProcessedStripeEventRow, 'event_id'> & Partial<ProcessedStripeEventRow>>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
