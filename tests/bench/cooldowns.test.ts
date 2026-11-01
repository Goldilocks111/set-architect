import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeCooldowns, mergeCooldownsBack, openedDuringRun, readCooldowns, seedCooldowns } from '../../bench/data/cooldowns';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-'));
  dirs.push(d);
  return d;
};
const put = (root: string, data: unknown) => {
  fs.mkdirSync(path.join(root, 'search'), { recursive: true });
  fs.writeFileSync(path.join(root, 'search', 'provider-cooldowns.json'), JSON.stringify(data));
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('cooldown seeding and merge-back', () => {
  it('copies the real table into the temp root', () => {
    const real = tmp();
    const t = tmp();
    put(real, { spotify: 5000 });
    expect(seedCooldowns(real, t)).toEqual({ spotify: 5000 });
    expect(readCooldowns(t)).toEqual({ spotify: 5000 });
  });
  it('seeds an empty table when the real file is missing or corrupt', () => {
    const real = tmp();
    const t = tmp();
    expect(seedCooldowns(real, t)).toEqual({});
    fs.mkdirSync(path.join(real, 'search'), { recursive: true });
    fs.writeFileSync(path.join(real, 'search', 'provider-cooldowns.json'), '{nope');
    expect(seedCooldowns(real, t)).toEqual({});
  });
  it('merges back with max per provider and keeps real-only entries', () => {
    const real = tmp();
    const t = tmp();
    put(real, { spotify: 9000, deezer: 100 });
    put(t, { spotify: 4000, deezer: 700, musicbrainz: 50 });
    mergeCooldownsBack(t, real);
    expect(readCooldowns(real)).toEqual({ spotify: 9000, deezer: 700, musicbrainz: 50 });
    expect(fs.readdirSync(path.join(real, 'search')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('creates the real file when none existed', () => {
    const real = tmp();
    const t = tmp();
    put(t, { deezer: 1 });
    mergeCooldownsBack(t, real);
    expect(readCooldowns(real)).toEqual({ deezer: 1 });
  });
});

describe('cooldown queries', () => {
  it('activeCooldowns lists only still-active named providers', () => {
    expect(activeCooldowns({ spotify: 2000, deezer: 500, itunes: 9000 }, ['spotify', 'deezer'], 1000)).toEqual(['spotify']);
  });
  it('openedDuringRun reports new or extended active cooldowns only', () => {
    const seed = { itunes: 5000, spotify: 100 };
    const after = { itunes: 5000, spotify: 100, deezer: 3000, musicbrainz: 400 };
    expect(openedDuringRun(seed, after, 1000)).toEqual(['deezer']);
    expect(openedDuringRun(seed, { ...after, itunes: 6000 }, 1000)).toEqual(['itunes', 'deezer']);
  });
});
