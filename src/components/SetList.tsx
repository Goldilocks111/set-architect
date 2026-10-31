'use client';

import { Fragment, useState } from 'react';
import type { ArcTemplate, Track } from '@/types/track';
import SetRow from './SetRow';
import TransitionBadge from './TransitionBadge';

interface Props {
  tracks: Track[];
  template: ArcTemplate;
  plannedLength: number;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
}

export default function SetList({ tracks, template, plannedLength, onRemove, onMove }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  if (tracks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#2A2F3F] px-5 py-8 text-center text-sm text-[#8A8FA3]">
        <p className="text-[#E8E4DA]">Your set is empty.</p>
        <p className="mt-1">Search for an opener above, or add one of the suggested openers.</p>
      </div>
    );
  }

  return (
    <ol aria-label="Set list" className="flex flex-col">
      {tracks.map((track, i) => (
        <Fragment key={track.id}>
          {i > 0 && (
            <TransitionBadge from={tracks[i - 1]} to={track} position={i} template={template} plannedLength={plannedLength} />
          )}
          <SetRow
            track={track}
            index={i}
            count={tracks.length}
            onRemove={onRemove}
            onMove={onMove}
            dragOver={dragOver === i && dragFrom !== null && dragFrom !== i}
            onDragStart={setDragFrom}
            onDragOverRow={setDragOver}
            onDrop={(to) => {
              if (dragFrom !== null) onMove(dragFrom, to);
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
          />
        </Fragment>
      ))}
    </ol>
  );
}
