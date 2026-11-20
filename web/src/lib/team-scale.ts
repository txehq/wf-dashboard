import { formatInteger, formatNoun } from '@/lib/format';

// The People table's Total | Per day switch (Contracts 37.4): Per day divides a cumulative number by the range's calendar
// days, weekends included, shown with one decimal. Sorting uses the number as shown; the hover gives the total, the per
// day and the divisor
export interface Scale {
  // The value as shown, for sorting
  value: (n: number) => number;
  format: (n: number) => string;
  // Hover text; empty for a one-day range, where total and per day are the same
  title: (n: number) => string;
}

const oneDecimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function scale(days: number, perDay: boolean): Scale {
  const daily = (n: number) => Math.round((n * 10) / days) / 10;
  return {
    value: (n) => (perDay ? daily(n) : n),
    format: (n) => (perDay ? oneDecimal.format(daily(n)) : formatInteger(n)),
    title: (n) =>
      days <= 1
        ? ''
        : `${formatInteger(n)} in ${formatNoun(days, 'day')} · ${oneDecimal.format(daily(n))} per day`,
  };
}
