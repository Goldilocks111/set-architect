'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { arcLabel, DEFAULT_PLAY_FRACTION } from '@/lib/arc';
import { formatMinutes } from '@/lib/duration';
import type { Arc, Track } from '@/types/track';
import { buildCurveData, quarantineForCurve, type CurvePoint } from './curveData';

export const CURVE_COLORS = {
  energy: '#F2B33D',
  target: '#7FA7D9',
  bpm: '#323a52',
  grid: '#232838',
  axis: '#8A8FA3',
  overrun: '#EE8B7A',
};

interface Props {
  tracks: Track[];
  arc: Arc;
  playFraction?: number;
  height?: number;
}

function CurveTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: CurvePoint }> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border border-[#2A2F3F] bg-[#12141C]/95 px-3 py-2 text-xs text-[#E8E4DA] shadow-lg">
      <div className="text-[#8A8FA3] tabular-nums">
        {formatMinutes(p.minute * 60_000)}
        {p.overrun && <span style={{ color: CURVE_COLORS.overrun }}> · past the planned length</span>}
      </div>
      <div className="font-[family-name:var(--font-display)] text-sm">
        {p.position !== null ? (
          <>
            #{p.position} {p.label}
          </>
        ) : (
          <span className="text-[#8A8FA3]">no track yet</span>
        )}
      </div>
      <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
        <span className="text-[#8A8FA3]">Energy</span>
        <span style={{ color: CURVE_COLORS.energy }}>{p.energy ?? (p.position !== null ? 'unknown' : '–')}</span>
        <span className="text-[#8A8FA3]">Target</span>
        <span style={{ color: CURVE_COLORS.target }}>{p.target ?? '–'}</span>
        <span className="text-[#8A8FA3]">BPM</span>
        <span>{p.bpm ?? (p.position !== null ? 'unknown' : '–')}</span>
      </div>
    </div>
  );
}

/** A tick every 5/10/15/30/60 minutes, about eight across the axis. */
function minuteTicks(max: number): number[] {
  const step = [5, 10, 15, 30, 60].find((s) => max / s <= 8) ?? 60;
  const out: number[] = [];
  for (let m = 0; m <= max + 1e-9; m += step) out.push(m);
  return out;
}

export default function EnergyCurve({ tracks, arc, playFraction = DEFAULT_PLAY_FRACTION, height = 260 }: Props) {
  const { points, plannedMin, maxMin, overrun } = buildCurveData(quarantineForCurve(tracks), arc, playFraction);
  const bpms = points.map((d) => d.bpm).filter((b): b is number => b !== null);
  const bpmDomain: [number, number] = bpms.length
    ? [Math.floor(Math.min(...bpms) - 8), Math.ceil(Math.max(...bpms) + 2)]
    : [100, 140];

  return (
    <figure aria-label="Energy curve" className="w-full">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={CURVE_COLORS.grid} vertical={false} />
            <XAxis
              dataKey="minute"
              type="number"
              domain={[0, maxMin]}
              ticks={minuteTicks(maxMin)}
              tickFormatter={(m: number) => `${m}′`}
              tick={{ fill: CURVE_COLORS.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CURVE_COLORS.grid }}
            />
            <YAxis
              yAxisId="energy"
              domain={[0, 10]}
              ticks={[0, 2, 4, 6, 8, 10]}
              tick={{ fill: CURVE_COLORS.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="bpm"
              orientation="right"
              domain={bpmDomain}
              tick={{ fill: CURVE_COLORS.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={36}
            />
            {overrun && (
              <ReferenceArea
                yAxisId="energy"
                x1={overrun.from}
                x2={overrun.to}
                fill={CURVE_COLORS.overrun}
                fillOpacity={0.1}
                stroke="none"
                ifOverflow="hidden"
                label={{ value: 'over', position: 'insideTopRight', fill: CURVE_COLORS.overrun, fontSize: 11 }}
              />
            )}
            {overrun && <ReferenceLine yAxisId="energy" x={plannedMin} stroke={CURVE_COLORS.overrun} strokeOpacity={0.6} strokeDasharray="2 3" />}
            <Tooltip content={<CurveTooltip />} cursor={{ stroke: 'rgba(242,179,61,0.35)' }} />
            <Area
              yAxisId="bpm"
              dataKey="bpm"
              type="stepAfter"
              stroke="none"
              fill={CURVE_COLORS.bpm}
              fillOpacity={0.9}
              connectNulls={false}
              baseValue="dataMin"
              isAnimationActive={false}
            />
            <Line
              yAxisId="energy"
              dataKey="target"
              stroke={CURVE_COLORS.target}
              strokeDasharray="5 5"
              strokeWidth={1.5}
              dot={false}
              type="linear"
              isAnimationActive={false}
            />
            <Line
              yAxisId="energy"
              dataKey="energy"
              stroke={CURVE_COLORS.energy}
              strokeWidth={3}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4 }}
              type="stepAfter"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#8A8FA3]">
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-5 rounded" style={{ background: CURVE_COLORS.energy }} />
          Your set&apos;s energy
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: CURVE_COLORS.target }} />
          Target arc ({arcLabel(arc)})
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CURVE_COLORS.bpm }} />
          BPM (right axis)
        </span>
        {overrun && (
          <span className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CURVE_COLORS.overrun, opacity: 0.4 }} />
            Past the planned length
          </span>
        )}
        <span>Across: minutes played</span>
      </figcaption>
    </figure>
  );
}
