import { scoreBpmTransition, scoreEnergyTransition, scoreKeyTransition } from '@/engine';
import type { Track } from '@/types/track';
import { QUALITY_CLASSES, quality } from './trackFormat';

interface Props {
  from: Track;
  to: Track;
  /** Arc energy target where `to` plays (engine trackTargets). */
  target: number;
}

interface Part {
  name: string;
  text: string;
  detail: string;
  score?: number;
}

const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function transitionParts({ from, to, target }: Props): Part[] {
  const key: Part =
    from.camelot && to.camelot
      ? (() => {
          const k = scoreKeyTransition(from.camelot, to.camelot);
          return { name: 'Key', text: `${from.camelot}→${to.camelot}`, detail: k.label, score: k.score };
        })()
      : { name: 'Key', text: 'key ?', detail: 'Key unknown' };

  const bpm: Part =
    finite(from.bpm) && finite(to.bpm)
      ? (() => {
          const b = scoreBpmTransition(from.bpm, to.bpm);
          const delta = Math.round((to.bpm - from.bpm) * 10) / 10;
          const text =
            b.relation === 'half-time' || b.relation === 'double-time'
              ? b.relation
              : `${delta > 0 ? '+' : ''}${delta} BPM`;
          return { name: 'Tempo', text, detail: b.relation === 'clash' ? 'Tempo clash' : `${b.relation} mix`, score: b.score };
        })()
      : { name: 'Tempo', text: 'BPM ?', detail: 'BPM unknown' };

  const energy: Part =
    finite(from.energy) && finite(to.energy)
      ? (() => {
          const e = scoreEnergyTransition(from.energy, to.energy, target);
          const d = Math.round(to.energy - from.energy);
          return { name: 'Energy', text: `E ${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}`, detail: e.label, score: e.score };
        })()
      : { name: 'Energy', text: 'E ?', detail: 'Energy unknown' };

  return [key, bpm, energy];
}

export default function TransitionBadge(props: Props) {
  const parts = transitionParts(props);
  const summary = parts.map((p) => `${p.name}: ${p.detail}`).join('; ');
  return (
    <div className="flex items-center gap-2 py-1 pl-[52px]" aria-label={`Transition: ${summary}`} title={summary}>
      <span aria-hidden className="h-3 w-px bg-[#2A2F3F]" />
      {parts.map((p) => (
        <span
          key={p.name}
          className={`rounded border px-1.5 text-[10.5px] leading-[18px] tabular-nums ${QUALITY_CLASSES[quality(p.score)]}`}
        >
          {p.text}
        </span>
      ))}
    </div>
  );
}
