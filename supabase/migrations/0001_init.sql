-- Set Architect V1 — initial schema. Apply with `npx supabase db push` (see supabase/README.md).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.tracks (
  id text primary key,
  artist text not null,
  title text not null,
  remix text,
  bpm numeric,
  camelot text,
  energy numeric,
  danceability numeric,
  popularity numeric,
  isrc text,
  preview_url text,
  itunes_url text,
  artwork_url text,
  youtube_url text,
  year integer,
  sources jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index tracks_isrc_idx on public.tracks (isrc);
create index tracks_artist_title_idx on public.tracks (lower(artist), lower(title));

create table public.track_features (
  track_id text primary key references public.tracks (id) on delete cascade,
  features jsonb not null default '{}'::jsonb,
  source text,
  updated_at timestamptz not null default now()
);

create table public.tracklists (
  id text primary key,
  source_url text,
  dj text,
  event text,
  played_at date,
  created_at timestamptz not null default now()
);

create table public.tracklist_entries (
  tracklist_id text not null references public.tracklists (id) on delete cascade,
  position integer not null,
  track_id text not null references public.tracks (id) on delete cascade,
  primary key (tracklist_id, position)
);
create index tracklist_entries_track_idx on public.tracklist_entries (track_id);

create table public.adjacency (
  from_track_id text not null references public.tracks (id) on delete cascade,
  to_track_id text not null references public.tracks (id) on delete cascade,
  count integer not null default 1,
  primary key (from_track_id, to_track_id)
);

create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  arc_template text not null default '60min',
  created_at timestamptz not null default now()
);
create index playlists_user_idx on public.playlists (user_id);

create table public.playlist_tracks (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  position integer not null,
  track_id text not null references public.tracks (id) on delete cascade,
  primary key (playlist_id, position)
);

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  plan text not null default 'free',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);
create index usage_events_user_kind_time_idx on public.usage_events (user_id, kind, created_at desc);

-- Webhook idempotency ledger (service role only).
create table public.processed_stripe_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- Row level security ---------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.tracks enable row level security;
alter table public.track_features enable row level security;
alter table public.tracklists enable row level security;
alter table public.tracklist_entries enable row level security;
alter table public.adjacency enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table public.processed_stripe_events enable row level security;

-- profiles: read own (admins read all); users may only edit display_name.
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

-- shared catalogue: world-readable, written only by the service role.
create policy tracks_read on public.tracks for select using (true);
create policy track_features_read on public.track_features for select using (true);
create policy tracklists_read on public.tracklists for select using (true);
create policy tracklist_entries_read on public.tracklist_entries for select using (true);
create policy adjacency_read on public.adjacency for select using (true);

-- playlists: owner only.
create policy playlists_owner on public.playlists for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy playlist_tracks_owner on public.playlist_tracks for all
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));

-- subscriptions: read own (admins all); writes via service role (Stripe webhook) only.
create policy subscriptions_select on public.subscriptions for select
  using (user_id = auth.uid() or public.is_admin());

-- usage: owner reads/inserts own; admins read all.
create policy usage_select on public.usage_events for select using (user_id = auth.uid() or public.is_admin());
create policy usage_insert on public.usage_events for insert with check (user_id = auth.uid());
