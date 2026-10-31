import { fetchJson } from "../http";
import type { SourceAdapter } from "./types";

export const youtubeSearchUrl = (artist: string, title: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title}`)}`;

export const youtubeAdapter: SourceAdapter = {
  name: "youtube",
  configured: () => true, // keyless mode constructs a search URL; the API key only upgrades it to a direct link
  async enrich(partial) {
    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
      try {
        const data = await fetchJson<{
          items?: Array<{ id?: { videoId?: string } }>;
        }>(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(
            `${partial.artist} ${partial.title}`,
          )}&key=${encodeURIComponent(key)}`,
        );
        const vid = data.items?.[0]?.id?.videoId;
        if (vid)
          return { youtubeUrl: `https://www.youtube.com/watch?v=${vid}` };
      } catch {
        // quota/API failure: fall back to the constructed search URL
      }
    }
    return { youtubeUrl: youtubeSearchUrl(partial.artist, partial.title) };
  },
};
