const DIGITS = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

// prompt 中的数量词：两个、四组；超过十个时用阿拉伯数字
export function chineseCount(n: number): string {
  return DIGITS[n] ?? String(n);
}
