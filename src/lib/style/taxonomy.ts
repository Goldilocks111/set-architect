export const LANES = [
  'deep-house', 'house', 'tech-house', 'progressive-house', 'melodic-house', 'melodic-techno', 'techno', 'hard-techno',
  'minimal', 'afro-house', 'organic-house', 'disco-nu-disco', 'uk-garage', 'drum-and-bass', 'trance', 'electro',
  'breaks', 'downtempo', 'big-room', 'bass-house',
] as const;
export type Lane = (typeof LANES)[number];

export const MAX_LANES = 3;

/**
 * Normalized tag (lowercase, punctuation → single spaces, "&" → "and") → lane. Plain data: extend freely.
 * Tags absent here (moods, years, "seen live", the bare "electronic"/"dance") are not genres and are ignored.
 */
export const TAG_ALIASES: Record<string, Lane> = {
  // house family
  house: 'house', 'house music': 'house', 'club house': 'house', 'classic house': 'house', 'chicago house': 'house',
  'funky house': 'house', 'vocal house': 'house', 'jackin house': 'house', 'future house': 'house',
  'deep house': 'deep-house', 'deephouse': 'deep-house', 'soulful house': 'deep-house', 'lounge house': 'deep-house',
  'tech house': 'tech-house', techhouse: 'tech-house', 'minimal tech house': 'tech-house', 'groove house': 'tech-house',
  'progressive house': 'progressive-house', 'prog house': 'progressive-house', 'progressive': 'progressive-house',
  'melodic house': 'melodic-house', 'melodic house and techno': 'melodic-house', 'melodic deep house': 'melodic-house',
  'indie dance': 'melodic-house', 'indie dance nu disco': 'disco-nu-disco',
  'afro house': 'afro-house', afrohouse: 'afro-house', 'afro tech': 'afro-house', 'afro deep': 'afro-house',
  'organic house': 'organic-house', 'organic house downtempo': 'organic-house', 'organic': 'organic-house',
  'disco house': 'disco-nu-disco', 'nu disco': 'disco-nu-disco', nudisco: 'disco-nu-disco', disco: 'disco-nu-disco',
  'italo disco': 'disco-nu-disco', 'funk soul disco': 'disco-nu-disco',
  'bass house': 'bass-house', 'g house': 'bass-house', 'ghetto house': 'bass-house', 'speed house': 'bass-house',
  'big room': 'big-room', 'big room house': 'big-room', 'festival house': 'big-room', 'mainstage': 'big-room', 'progressive big room': 'big-room',
  // techno family
  techno: 'techno', 'peak time techno': 'techno', 'peak time driving': 'techno', 'driving techno': 'techno',
  'detroit techno': 'techno', 'raw techno': 'techno', 'dub techno': 'techno', 'berlin techno': 'techno', 'acid techno': 'techno',
  'melodic techno': 'melodic-techno', 'melodic progressive': 'melodic-techno', afterlife: 'melodic-techno',
  'melodic techno and progressive house': 'melodic-techno', 'progressive techno': 'melodic-techno',
  'hard techno': 'hard-techno', hardtechno: 'hard-techno', 'industrial techno': 'hard-techno', 'hard groove': 'hard-techno',
  hardcore: 'hard-techno', 'industrial hard techno': 'hard-techno', schranz: 'hard-techno',
  minimal: 'minimal', 'minimal techno': 'minimal', 'minimal house': 'minimal', microhouse: 'minimal', 'micro house': 'minimal',
  'deep tech': 'minimal', 'minimal deep tech': 'minimal',
  // other lanes
  'uk garage': 'uk-garage', ukg: 'uk-garage', '2 step': 'uk-garage', 'speed garage': 'uk-garage', 'garage house': 'uk-garage',
  garage: 'uk-garage', 'future garage': 'uk-garage',
  'drum and bass': 'drum-and-bass', 'drum n bass': 'drum-and-bass', dnb: 'drum-and-bass', 'd and b': 'drum-and-bass',
  drumandbass: 'drum-and-bass', liquid: 'drum-and-bass', 'liquid funk': 'drum-and-bass', jungle: 'drum-and-bass', neurofunk: 'drum-and-bass',
  trance: 'trance', 'progressive trance': 'trance', 'uplifting trance': 'trance', 'vocal trance': 'trance',
  psytrance: 'trance', 'psy trance': 'trance', 'goa trance': 'trance', 'tech trance': 'trance',
  electro: 'electro', 'electro house': 'electro', electroclash: 'electro', 'electro funk': 'electro', 'complextro': 'electro',
  breaks: 'breaks', breakbeat: 'breaks', 'break beat': 'breaks', 'nu skool breaks': 'breaks', 'big beat': 'breaks', 'uk breaks': 'breaks',
  downtempo: 'downtempo', chillout: 'downtempo', 'chill out': 'downtempo', chill: 'downtempo', ambient: 'downtempo',
  trip: 'downtempo', 'trip hop': 'downtempo', lounge: 'downtempo',
};

const normalize = (tag: string): string =>
  tag
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The lane a tag names, or undefined for non-genre tags. "drum'n'bass" → "drum n bass" so both spellings hit. */
export function laneOfTag(name: string): Lane | undefined {
  const n = normalize(name);
  return Object.hasOwn(TAG_ALIASES, n) ? TAG_ALIASES[n] : undefined;
}

/** Up to MAX_LANES lanes, ordered by summed tag weight (ties keep the LANES order). */
export function lanesFromTags(tags: Array<{ name: string; count: number }>): Lane[] {
  const weight = new Map<Lane, number>();
  for (const { name, count } of tags) {
    const lane = laneOfTag(name);
    if (!lane || !(count > 0)) continue;
    weight.set(lane, (weight.get(lane) ?? 0) + count);
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || LANES.indexOf(a[0]) - LANES.indexOf(b[0]))
    .slice(0, MAX_LANES)
    .map(([lane]) => lane);
}
