// Pure: Mixed In Key CSV parsing, shared by the import button. Do not import node modules here.

export interface MikRow {
  artist: string;
  title: string;
  bpm?: number;
  camelot?: string;
  energy?: number;
}

// Camelot number for each tonic. B = major (outer wheel), A = minor (inner wheel).
const MAJOR: Record<string, number> = {
  C: 8, G: 9, D: 10, A: 11, E: 12, B: 1, 'F#': 2, Gb: 2, 'C#': 3, Db: 3, 'G#': 4, Ab: 4, 'D#': 5, Eb: 5, 'A#': 6, Bb: 6, F: 7,
};
const MINOR: Record<string, number> = {
  A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12, 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7,
};

/** "F#m", "A minor", "Bbmaj", "8A", or Open Key ("1d" = C major = 8B, "1m" = A minor = 8A) to a Camelot code. */
export function musicalKeyToCamelot(input: string): string | undefined {
  const k = input.trim();
  const camelot = /^(1[0-2]|[1-9])([ab])$/i.exec(k);
  if (camelot) return `${camelot[1]}${camelot[2].toUpperCase()}`;
  const open = /^(1[0-2]|[1-9])([md])$/i.exec(k);
  if (open) return `${((Number(open[1]) + 6) % 12) + 1}${open[2].toLowerCase() === 'm' ? 'A' : 'B'}`;

  const m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(.*)$/.exec(k);
  if (!m) return undefined;
  const tonic = m[1].toUpperCase() + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]);
  const mode = m[3];
  let minor: boolean;
  if (mode === '' || mode === 'M' || /^(maj|major)$/i.test(mode)) minor = false;
  else if (mode === 'm' || /^(min|minor)$/i.test(mode)) minor = true;
  else return undefined;
  const n = (minor ? MINOR : MAJOR)[tonic];
  return n === undefined ? undefined : `${n}${minor ? 'A' : 'B'}`;
}

/** RFC-4180-ish: quoted fields, "" escapes, newlines inside quotes. */
function parseRecords(text: string, delim: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return records;
}

function detectDelimiter(header: string): string {
  let best = ',';
  let max = 0;
  for (const d of [',', ';', '\t']) {
    let n = 0;
    let q = false;
    for (const c of header) {
      if (c === '"') q = !q;
      else if (!q && c === d) n++;
    }
    if (n > max) { max = n; best = d; }
  }
  return best;
}

const HEADERS: Record<string, string[]> = {
  artist: ['artist'],
  title: ['title', 'name', 'track', 'track name'],
  key: ['key', 'key result', 'initial key', 'camelot', 'camelot key'],
  bpm: ['bpm', 'tempo'],
  energy: ['energy', 'energy level', 'energy rating'],
  comment: ['comment', 'comments'],
  file: ['file name', 'filename', 'file', 'file path'],
};

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const v = Number(s.trim().replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

function fromFileName(f: string): { artist: string; title: string } | undefined {
  const base = (f.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const i = base.indexOf(' - ');
  if (i < 1) return undefined;
  const artist = base.slice(0, i).trim();
  const title = base.slice(i + 3).trim();
  return artist && title ? { artist, title } : undefined;
}

export function parseMikCsv(text: string): { rows: MikRow[]; skipped: number } {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const records = parseRecords(clean, detectDelimiter(firstLine));
  if (records.length === 0) return { rows: [], skipped: 0 };

  const names = records[0].map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADERS)) {
    // an earlier alias wins ("key result" over a later "key")
    for (const a of aliases) {
      const i = names.indexOf(a);
      if (i >= 0) { col[field] = i; break; }
    }
  }
  const rows: MikRow[] = [];
  let skipped = 0;
  for (const rec of records.slice(1)) {
    const get = (f: string) => (col[f] === undefined ? undefined : rec[col[f]]?.trim());
    let artist = get('artist') ?? '';
    let title = get('title') ?? '';
    if (!artist || !title) {
      const parsed = fromFileName(get('file') ?? '');
      if (!artist && !title && parsed) ({ artist, title } = parsed);
      else if (!artist || !title) { skipped++; continue; }
    }
    const comment = get('comment') ?? '';
    const row: MikRow = { artist, title };
    const bpm = num(get('bpm'));
    if (bpm !== undefined) row.bpm = bpm;
    const keyCell = get('key');
    let camelot = keyCell ? musicalKeyToCamelot(keyCell) : undefined;
    if (!camelot) camelot = /(?:^|[^0-9A-Za-z])((?:1[0-2]|[1-9])[ABab])(?![0-9A-Za-z])/.exec(comment)?.[1]?.toUpperCase();
    if (camelot) row.camelot = camelot;
    let energy = num(get('energy'));
    if (energy === undefined) {
      const e = /energy\s*[:=]?\s*(\d+)/i.exec(comment);
      if (e) energy = Number(e[1]);
    }
    if (energy !== undefined) row.energy = energy;
    if (row.bpm === undefined && !row.camelot && row.energy === undefined) { skipped++; continue; }
    rows.push(row);
  }
  return { rows, skipped };
}
