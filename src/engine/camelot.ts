export interface CamelotKey {
  num: number;
  letter: 'A' | 'B';
}

export function parseCamelot(key: string | undefined): CamelotKey | null {
  const m = /^(1[0-2]|[1-9])([AB])$/i.exec((key ?? '').trim());
  return m ? { num: Number(m[1]), letter: m[2].toUpperCase() as 'A' | 'B' } : null;
}

const mod12 = (n: number) => ((n % 12) + 12) % 12;

// Rulebook §1 transition table. Step is (to - from) mod 12 on the wheel.
export function scoreKeyTransition(from: string, to: string): { score: number; label: string } {
  const a = parseCamelot(from);
  const b = parseCamelot(to);
  if (!a || !b) return { score: 0, label: 'Key unknown' };
  const step = mod12(b.num - a.num);
  if (a.letter === b.letter) {
    if (step === 0) return { score: 1, label: 'Perfect' };
    if (step === 1 || step === 11) return { score: 0.9, label: 'Smooth' };
    if (step === 2) return { score: 0.6, label: 'Energy boost' };
    if (step === 9) return { score: 0.2, label: 'Pay attention' };
    if (step === 7) return { score: 0.15, label: 'Jaws' };
    return { score: 0, label: 'Clash' };
  }
  if (step === 0) return { score: 0.85, label: 'Relative major/minor' };
  if (step === 1 || step === 11) return { score: 0.3, label: 'Risky' };
  return { score: 0, label: 'Clash' };
}

export function isEnergyBoostKey(from: string, to: string): boolean {
  const a = parseCamelot(from);
  const b = parseCamelot(to);
  return !!a && !!b && a.letter === b.letter && mod12(b.num - a.num) === 2;
}
