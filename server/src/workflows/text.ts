const DIGITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

// Counts in prompts as words (two, four); Arabic numerals above ten
export function countWord(n: number): string {
  return DIGITS[n] ?? String(n);
}
