import { useState } from 'react';
import type { LiveSummary } from '@/lib/live-api';

// 交互项的用途（Contracts 14.3、26.1）：标签文字与列表上方的筛选；筛选的选择记在 localStorage

export function purposeLabel(live: Pick<LiveSummary, 'purpose'>): string {
  if (live.purpose === 'interaction') return '交互';
  if (live.purpose === 'optimize') return '优化';
  if (live.purpose === 'agent') return 'Magi Agent';
  return '设计';
}

export const purposeFilters = [
  { value: 'all', label: '全部' },
  { value: 'interaction', label: '交互' },
  { value: 'design', label: '设计' },
  { value: 'optimize', label: '优化' },
  { value: 'agent', label: 'Magi Agent' },
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
