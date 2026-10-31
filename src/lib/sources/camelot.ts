// Index = pitch class (0 = C ... 11 = B).
const MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/** Pitch class 0–11 + mode (1 = major, 0 = minor, Spotify convention) → Camelot code. */
export function toCamelot(key: number, mode: number): string | undefined {
  if (!Number.isInteger(key) || key < 0 || key > 11) return undefined;
  if (mode !== 0 && mode !== 1) return undefined;
  return (mode === 1 ? MAJOR : MINOR)[key];
}

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parses names like "C♯m", "Bb", "F#", "Am" into Camelot. */
export function keyNameToCamelot(name: string): string | undefined {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major)?\s*$/.exec(name);
  if (!m) return undefined;
  let pc = NOTE_PC[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  pc = (pc + 12) % 12;
  const minor = m[3] === 'm' || m[3] === 'min' || m[3] === 'minor';
  return toCamelot(pc, minor ? 0 : 1);
}

/** 0..1 energy → Mixed In Key 1..10 scale. */
export function energyTo10(e: number): number | undefined {
  if (typeof e !== 'number' || !Number.isFinite(e)) return undefined;
  return Math.min(10, Math.max(1, Math.round(e * 9) + 1));
}
