import fs from 'node:fs';
import path from 'node:path';

export type Cooldowns = Record<string, number>;

const cooldownFile = (root: string) => path.join(root, 'search', 'provider-cooldowns.json');

export function readCooldowns(root: string): Cooldowns {
  try {
    const parsed = JSON.parse(fs.readFileSync(cooldownFile(root), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Cooldowns = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeAtomic(root: string, data: Cooldowns): void {
  const file = cooldownFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Copies the real cooldown table into the temp root so the breaker sees real lockouts. Returns what was seeded. */
export function seedCooldowns(realRoot: string, tempRoot: string): Cooldowns {
  const seed = readCooldowns(realRoot);
  writeAtomic(tempRoot, seed);
  return seed;
}

/** Providers still cooling down at `now`. */
export function activeCooldowns(cd: Cooldowns, names: string[], now = Date.now()): string[] {
  return names.filter((n) => (cd[n] ?? 0) > now);
}

/** Providers whose cooldown the run raised or opened (compared with what was seeded). */
export function openedDuringRun(seed: Cooldowns, after: Cooldowns, now = Date.now()): string[] {
  return Object.keys(after).filter((k) => after[k] > now && after[k] > (seed[k] ?? 0));
}

/** Merges the temp run's cooldowns into the real file (max per provider), atomically. */
export function mergeCooldownsBack(tempRoot: string, realRoot: string): Cooldowns {
  const merged = readCooldowns(realRoot);
  for (const [k, v] of Object.entries(readCooldowns(tempRoot))) merged[k] = Math.max(merged[k] ?? 0, v);
  writeAtomic(realRoot, merged);
  return merged;
}
