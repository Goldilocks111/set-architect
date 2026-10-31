import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import SpotifyConnect from "@/components/SpotifyConnect";
import type { Track } from "@/types/track";

const track = (over: Partial<Track> = {}): Track => ({
  id: "t1",
  artist: "A",
  title: "T",
  sources: {},
  ...over,
});

function mockFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).startsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : {}), {
        status: key ? 200 : 404,
      });
    }),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpotifyConnect", () => {
  it("shows a Connect link when disconnected", async () => {
    mockFetch({ "/api/spotify/status": { connected: false } });
    render(<SpotifyConnect tracks={[]} onAdd={() => {}} />);
    const link = await screen.findByRole("link", { name: "Connect Spotify" });
    expect(link).toHaveAttribute("href", "/api/spotify/login");
  });

  it("disables Save with a tooltip when no track has a Spotify id", async () => {
    mockFetch({
      "/api/spotify/status": { connected: true, displayName: "DJ Zed" },
    });
    render(<SpotifyConnect tracks={[track()]} onAdd={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "DJ Zed" }));
    const save = screen.getByRole("menuitem", { name: "Save set to Spotify" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title");
  });

  it("imports: pick playlist, add one, add all", async () => {
    mockFetch({
      "/api/spotify/status": { connected: true, displayName: "DJ Zed" },
      "/api/spotify/playlists/p1/tracks": {
        tracks: [
          { artist: "A", title: "One", spotifyId: "id1" },
          { artist: "B", title: "Two", spotifyId: "id2" },
        ],
      },
      "/api/spotify/playlists": {
        playlists: [{ id: "p1", name: "Warmup", trackCount: 2 }],
      },
    });
    const onAdd = vi.fn();
    render(<SpotifyConnect tracks={[]} onAdd={onAdd} />);
    fireEvent.click(await screen.findByRole("button", { name: "DJ Zed" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import playlist…" }));
    fireEvent.click(await screen.findByRole("button", { name: /Warmup/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add One" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "spotify-id1",
        spotifyId: "id1",
        artist: "A",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add all (2)" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(3));
  });
});
