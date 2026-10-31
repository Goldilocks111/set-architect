import { createFetcher, FetchError, BLOCK_STATUSES, type Fetcher } from './fetchPage';
import { parseSearch } from './parseSearch';
import { parseTracklist, ParseError } from './parseTracklist';
import { ADJACENCY_PATH, JsonAdjacencyStore, buildDemoAdjacency, DEMO_ADJACENCY_PATH } from '../../src/lib/adjacency';
import type { AdjacencyStore } from '../../src/lib/adjacency';

export interface CliDeps {
  fetcher: Fetcher;
  store: AdjacencyStore;
  log: (line: string) => void;
}

const USAGE = `Usage: npm run scrape -- <subcommand>
  search "artist or event"            list matching tracklist URLs
  tracklist <url> [<url>...]          fetch, parse and index tracklists
  crawl "<query>" [--max N]           search, then index the top N tracklists (default 20)
  stats                               index summary
  demo                                regenerate data/seed/adjacency.demo.json`;

async function ingestUrl(deps: CliDeps, url: string): Promise<void> {
  const html = await deps.fetcher.get(url);
  const tl = parseTracklist(html);
  const added = await deps.store.ingest(tl.id, tl.tracks);
  deps.log(
    added
      ? `indexed ${tl.id}: ${tl.tracks.length} tracks - ${tl.title}`
      : `skipped ${tl.id}: already indexed - ${tl.title}`
  );
}

const isBlock = (err: unknown) => err instanceof FetchError && BLOCK_STATUSES.includes(err.status);

/** Returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'search': {
        const query = rest.join(' ').trim();
        if (!query) throw new Error('search needs a query');
        const results = parseSearch(await deps.fetcher.search(query));
        for (const r of results) deps.log(`${r.url}\t${r.date ?? ''}\t${r.title}`);
        if (results.length === 0) deps.log('no results');
        return 0;
      }
      case 'tracklist': {
        if (rest.length === 0) throw new Error('tracklist needs at least one url');
        for (const url of rest) await ingestUrl(deps, url);
        return 0;
      }
      case 'crawl': {
        const maxIdx = rest.indexOf('--max');
        const max = maxIdx >= 0 ? parseInt(rest[maxIdx + 1], 10) : 20;
        if (!Number.isFinite(max) || max < 1) throw new Error('--max needs a positive number');
        const query = rest.filter((_, i) => i !== maxIdx && i !== maxIdx + 1 || maxIdx < 0).join(' ').trim();
        if (!query) throw new Error('crawl needs a query');
        const results = parseSearch(await deps.fetcher.search(query)).slice(0, max);
        let failed = 0;
        for (const r of results) {
          if (await deps.store.hasTracklist(r.id)) {
            deps.log(`skipped ${r.id}: already indexed`);
            continue;
          }
          try {
            await ingestUrl(deps, r.url);
          } catch (err) {
            if (isBlock(err)) throw err;
            failed++;
            deps.log(`failed ${r.url}: ${(err as Error).message}`);
          }
        }
        return failed > 0 ? 1 : 0;
      }
      case 'stats': {
        const s = await deps.store.stats();
        deps.log(`tracklists: ${s.tracklistCount}\ntracks: ${s.trackCount}\npairs: ${s.pairCount}`);
        return 0;
      }
      case 'demo': {
        buildDemoAdjacency();
        deps.log(`wrote ${DEMO_ADJACENCY_PATH}`);
        return 0;
      }
      default:
        deps.log(USAGE);
        return cmd ? 2 : 0;
    }
  } catch (err) {
    if (isBlock(err)) {
      deps.log(`backing off - site is rate-limiting/captcha-gating (${(err as Error).message}). Stopping; try again much later.`);
      return 1;
    }
    deps.log(`${err instanceof ParseError ? '' : 'error: '}${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('scraper/cli.ts')) {
  runCli(process.argv.slice(2), {
    fetcher: createFetcher(),
    store: new JsonAdjacencyStore(ADJACENCY_PATH),
    log: (line) => console.log(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
