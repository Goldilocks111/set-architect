import type { SearchProvider } from '@/lib/search/types';
import { spotifySearchProvider } from './spotify';
import { deezerSearchProvider } from './deezer';
import { itunesSearchProvider } from './itunes';

export { spotifySearchProvider, deezerSearchProvider, itunesSearchProvider };

export const searchProviders: SearchProvider[] = [spotifySearchProvider, deezerSearchProvider, itunesSearchProvider];
