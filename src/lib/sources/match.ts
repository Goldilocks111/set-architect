import { parseVersion } from '../search/version';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\bpts?\b\.?\s*(?=\d)/g, 'part ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Length/format cuts of the same recording that the version parser does not know ("Mixed", 12" version). */
const FORMAT_QUALIFIER = /^(?:mixed(?:\s+version)?|\d{1,2}\s*(?:["”″']{1,2}|inch)(?:\s*(?:version|mix|edit))?)$/i;
/** "X Remix - Radio Edit", "X Remix Edit", "X Remix (Original Mix)": cuts of a remix, still that remix. */
const REMIX_CUT_TAIL = /\b(remix|rework|bootleg|flip|refix)(?:\s*[-–—]\s*|\s+)(?:radio edit|radio mix|edit|extended mix|extended version|extended|original mix|club mix)(?=\s*[)\]]|\s*$)/gi;

function preclean(title: string): string {
  return title
    .replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (whole, p, b) => (FORMAT_QUALIFIER.test((p ?? b).trim()) ? '' : whole))
    .replace(/\s+[-–—]\s+([^-–—]*)$/, (whole, tail: string) => (FORMAT_QUALIFIER.test(tail.trim()) ? '' : whole))
    .replace(REMIX_CUT_TAIL, '$1');
}

/** Base title plus version identity: "orig" for the original family, "remix:<remixer>" for a remix, else kind + label. */
function identify(title: string, artist: string): { base: string; id: string } {
  const v = parseVersion(preclean(title), artist ? [artist] : []);
  const who = v.remixer ? fold(v.remixer) : '';
  const isArtist = !!who && !!artist && fold(artist).split(' ').join('').includes(who.split(' ').join(''));
  let id: string;
  if (v.kind === 'remix') id = `remix:${who || fold(v.label ?? '')}`;
  else if (['original', 'extended', 'radio', 'remaster'].includes(v.kind)) id = who && !isArtist ? `remix:${who}` : 'orig';
  else id = `${v.kind}:${fold(v.label ?? '')}`;
  return { base: fold(v.baseTitle), id };
}

/**
 * A search hit is the wanted recording, not another song by the same artist or a remix of it: the base titles agree
 * ("&"="and", "Pt."="Part", diacritics folded) AND the version identity agrees. Length/format qualifiers (Original,
 * Extended, Radio Edit, Mixed, 12" version, remaster, guest credits) are the same recording; for remixes the remixer
 * must match; "(X Extended Mix)" with X not the track artist is X's remix. Adapters take a hit only when this holds,
 * so a wrong song's preview, ISRC or Spotify id never reaches the cache (preview analysis and ReccoBeats read them).
 */
export const titleMatches = (wanted: string, got?: string, artist = ''): boolean => {
  if (!wanted.trim() || !got?.trim()) return false;
  const a = identify(wanted, artist);
  const b = identify(got, artist);
  return !!a.base && a.base === b.base && a.id === b.id;
};
