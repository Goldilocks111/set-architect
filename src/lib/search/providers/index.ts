import type { SearchProvider } from '@/lib/search/types';
import { spotifySearchProvider } from './spotify';
import { deezerSearchProvider } from './deezer';
import { itunesSearchProvider } from './itunes';
import { musicbrainzSearchProvider } from './musicbrainz';

export { spotifySearchProvider, deezerSearchProvider, itunesSearchProvider, musicbrainzSearchProvider };

export const searchProviders: SearchProvider[] = [
  spotifySearchProvider,
  deezerSearchProvider,
  itunesSearchProvider,
  musicbrainzSearchProvider,
];
