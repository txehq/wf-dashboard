// 测试中取必须存在的值：没有时直接失败
export function must<T>(value: T | null | undefined, what = '值'): T {
  if (value === null || value === undefined) throw new Error(`缺少${what}`);
  return value;
}
