'use client';

import type { ArcTemplate } from '@/types/track';

const OPTIONS: Array<{ value: ArcTemplate; label: string }> = [
  { value: '60min', label: '1 hour' },
  { value: '120min', label: '2 hours' },
];

export default function ArcTemplatePicker({ value, onChange }: { value: ArcTemplate; onChange: (t: ArcTemplate) => void }) {
  return (
    <div role="radiogroup" aria-label="Set length" className="inline-flex rounded-lg border border-[#2A2F3F] p-0.5">
      {OPTIONS.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#F2B33D] ${
              selected ? 'bg-[#E8E4DA] text-[#12141C]' : 'text-[#8A8FA3] hover:text-[#E8E4DA]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
