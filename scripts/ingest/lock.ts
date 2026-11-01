import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export type IsAlive = (pid: number) => boolean;

/** Signal 0 probes for existence; EPERM means the process exists but belongs to someone else. */
export const pidAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(file: string): LockInfo | undefined {
  try {
    const l = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    return Number.isInteger(l.pid) ? l : undefined;
  } catch {
    return undefined;
  }
}

/** True while a live process holds the lock file. */
export function isLockHeld(file: string, isAlive: IsAlive = pidAlive): boolean {
  const l = readLock(file);
  return l !== undefined && isAlive(l.pid);
}

/** Takes the lock (exclusive create); a lock whose pid is dead or unreadable is stale and replaced. */
export function acquireLock(file: string, opts: { pid?: number; isAlive?: IsAlive; now?: () => number } = {}): boolean {
  const pid = opts.pid ?? process.pid;
  const body = JSON.stringify({ pid, startedAt: (opts.now ?? Date.now)() } satisfies LockInfo);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, body, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (isLockHeld(file, opts.isAlive)) return false;
    try {
      unlinkSync(file);
    } catch {
      /* raced with another taker: retry */
    }
  }
  return false;
}

/** Removes the lock only if this pid owns it. */
export function releaseLock(file: string, pid: number = process.pid): void {
  if (readLock(file)?.pid !== pid) return;
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
