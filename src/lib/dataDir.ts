import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All RUNTIME data (adjacency index, scraper cache, analysis cache, live state) lives
 * OUTSIDE the project tree: Turbopack has no watch-ignore, so any runtime write inside
 * the repo triggers an endless rebuild/Fast Refresh loop in dev (see next.config.ts).
 * Override with SETARCHITECT_DATA_DIR (tests point this at a temp dir).
 */
export function dataDir(...segments: string[]): string {
  const base = process.env.SETARCHITECT_DATA_DIR ?? path.join(os.homedir(), '.setarchitect');
  const dir = path.join(base, ...segments.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  return segments.length ? path.join(dir, segments[segments.length - 1]) : base;
}
