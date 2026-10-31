// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FetchError } from '../../scripts/scraper/fetchPage';
import { runCli } from '../../scripts/scraper/cli';
import { JsonAdjacencyStore } from '../../src/lib/adjacency/store';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const URL1 = 'https://www.1001tracklists.com/tracklist/9ycgytk/oliver-heldens-heldeep-radio-643-2026-10-30.html';

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(page: string) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      fetcher: {
        get: async (u: string) => (calls.push(u), page),
        search: async (q: string) => (calls.push(`search:${q}`), fx('search.sample.html')),
      },
      store: new JsonAdjacencyStore(path.join(dir, 'adj.json')),
      log: (l: string) => void lines.push(l),
    },
  };
}

describe('cli', () => {
  it('stats works on an empty index', async () => {
    const { d } = deps('');
    expect(await runCli(['stats'], d)).toBe(0);
    expect(lines.join('\n')).toMatch(/tracklists: 0[\s\S]*pairs: 0/);
  });

  it('tracklist indexes rows, and a second run skips', async () => {
    const { d } = deps(fx('tracklist.sample.html'));
    expect(await runCli(['tracklist', URL1], d)).toBe(0);
    expect((await d.store.stats()).pairCount).toBe(5);
    expect(await runCli(['tracklist', URL1], d)).toBe(0);
    expect((await d.store.stats()).pairCount).toBe(5);
    expect(lines.some((l) => l.startsWith('skipped 9ycgytk'))).toBe(true);
  });

  it('exits non-zero with the selector name on a mangled page and indexes nothing', async () => {
    const { d } = deps(fx('tracklist.mangled.html'));
    expect(await runCli(['tracklist', URL1], d)).toBe(1);
    expect(lines.join('\n')).toMatch(/\.trackValue/);
    expect((await d.store.stats()).tracklistCount).toBe(0);
  });

  it('search lists urls', async () => {
    const { d } = deps('');
    expect(await runCli(['search', 'Oliver', 'Heldens'], d)).toBe(0);
    expect(lines[0]).toContain(URL1);
  });

  it('crawl honours --max and parses the query around it', async () => {
    const { d, calls } = deps(fx('tracklist.sample.html'));
    expect(await runCli(['crawl', 'Oliver Heldens', '--max', '1'], d)).toBe(0);
    expect(calls).toEqual(['search:Oliver Heldens', URL1]);
  });

  it('crawl aborts immediately on 429 and exits non-zero', async () => {
    const { d } = deps('');
    let gets = 0;
    d.fetcher.get = async () => {
      gets++;
      throw new FetchError(429, URL1);
    };
    expect(await runCli(['crawl', 'Oliver Heldens'], d)).toBe(1);
    expect(gets).toBe(1);
    expect(lines.join('\n')).toMatch(/backing off/);
  });
});
