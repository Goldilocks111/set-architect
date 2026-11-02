'use client';

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { arcLabel, DEFAULT_PLAY_FRACTION } from '@/lib/arc';
import type { Arc, Track } from '@/types/track';
import { buildCurveData, quarantineForCurve, type CurveRow } from './curveData';

export const CURVE_COLORS = {
  energy: '#F2B33D',
  target: '#7FA7D9',
  bpm: '#323a52',
  grid: '#232838',
  axis: '#8A8FA3',
};

interface Props {
  tracks: Track[];
  arc: Arc;
  playFraction?: number;
  height?: number;
}

function CurveTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: CurveRow }> }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-md border border-[#2A2F3F] bg-[#12141C]/95 px-3 py-2 text-xs text-[#E8E4DA] shadow-lg">
      <div className="font-[family-name:var(--font-display)] text-sm">
        #{row.position} {row.label ?? <span className="text-[#8A8FA3]">open slot</span>}
      </div>
      <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
        <span className="text-[#8A8FA3]">Energy</span>
        <span style={{ color: CURVE_COLORS.energy }}>{row.energy ?? (row.label ? 'unknown' : '–')}</span>
        <span className="text-[#8A8FA3]">Target</span>
        <span style={{ color: CURVE_COLORS.target }}>{row.target}</span>
        <span className="text-[#8A8FA3]">BPM</span>
        <span>{row.bpm ?? (row.label ? 'unknown' : '–')}</span>
      </div>
    </div>
  );
}

export default function EnergyCurve({ tracks, arc, playFraction = DEFAULT_PLAY_FRACTION, height = 260 }: Props) {
  const data = buildCurveData(quarantineForCurve(tracks), arc, playFraction);
  const bpms = data.map((d) => d.bpm).filter((b): b is number => b !== null);
  const bpmDomain: [number, number] = bpms.length
    ? [Math.floor(Math.min(...bpms) - 8), Math.ceil(Math.max(...bpms) + 2)]
    : [100, 140];

  return (
    <figure aria-label="Energy curve" className="w-full">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={CURVE_COLORS.grid} vertical={false} />
            <XAxis
              dataKey="position"
              tick={{ fill: CURVE_COLORS.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CURVE_COLORS.grid }}
              interval="preserveStartEnd"
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
            <Tooltip content={<CurveTooltip />} cursor={{ fill: 'rgba(242,179,61,0.06)' }} />
            <Bar yAxisId="bpm" dataKey="bpm" fill={CURVE_COLORS.bpm} radius={[2, 2, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            <Line
              yAxisId="energy"
              dataKey="target"
              stroke={CURVE_COLORS.target}
              strokeDasharray="5 5"
              strokeWidth={1.5}
              dot={false}
              type="monotone"
              isAnimationActive={false}
            />
            <Line
              yAxisId="energy"
              dataKey="energy"
              stroke={CURVE_COLORS.energy}
              strokeWidth={3}
              connectNulls={false}
              dot={{ r: 3.5, fill: CURVE_COLORS.energy, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              type="monotone"
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
      </figcaption>
    </figure>
  );
}
