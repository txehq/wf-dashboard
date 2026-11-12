import { useState } from 'react';
import type { LiveSummary } from '@/lib/live-api';

// Purpose of an interaction item (Contracts 14.3, 26.1): tag text and the filter above the list; the
// filter choice is kept in localStorage

export function purposeLabel(live: Pick<LiveSummary, 'purpose'>): string {
  if (live.purpose === 'interaction') return 'Interaction';
  if (live.purpose === 'optimize') return 'Optimize';
  if (live.purpose === 'agent') return 'Magi Agent';
  if (live.purpose === 'orca') return 'Orca';
  return 'Design';
}

export const purposeFilters = [
  { value: 'all', label: 'All' },
  { value: 'interaction', label: 'Interaction' },
  { value: 'design', label: 'Design' },
  { value: 'optimize', label: 'Optimize' },
  { value: 'agent', label: 'Magi Agent' },
  { value: 'orca', label: 'Orca' },
] as const;
export type PurposeFilter = (typeof purposeFilters)[number]['value'];

const FILTER_KEY = 'live.purposeFilter';

export function usePurposeFilter(): [PurposeFilter, (next: PurposeFilter) => void] {
  const [value, setValue] = useState<PurposeFilter>(() => {
    const saved = localStorage.getItem(FILTER_KEY);
    return purposeFilters.find((f) => f.value === saved)?.value ?? 'all';
  });
  return [
    value,
    (next) => {
      localStorage.setItem(FILTER_KEY, next);
      setValue(next);
    },
  ];
}
