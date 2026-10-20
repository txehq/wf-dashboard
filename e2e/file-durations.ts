import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// 基础档单个 e2e 文件不超过 60 秒：结束时打印每个文件的耗时，从文件中第一个用例开始（含 beforeAll）到最后一个用例结束，
// 降序；不含服务启动。超过 45 秒的标出
const limitMs = 45_000;

export default class FileDurations implements Reporter {
  private readonly spans = new Map<string, { start: number; end: number }>();

  onTestEnd(test: TestCase, result: TestResult) {
    const file = path.relative(process.cwd(), test.location.file);
    const start = result.startTime.getTime();
    const end = start + result.duration;
    const span = this.spans.get(file);
    this.spans.set(file, {
      start: Math.min(span?.start ?? start, start),
      end: Math.max(span?.end ?? end, end),
    });
  }

  onEnd() {
    if (this.spans.size === 0) return;
    const rows = [...this.spans]
      .map(([file, { start, end }]) => ({ file, ms: end - start }))
      .sort((a, b) => b.ms - a.ms);
    console.log('\n每个 e2e 文件的耗时：');
    for (const { file, ms } of rows) {
      const over = ms > limitMs ? `  超过 ${String(limitMs / 1000)} 秒` : '';
      console.log(`${(ms / 1000).toFixed(1).padStart(7)} 秒  ${file}${over}`);
    }
  }

  printsToStdio() {
    return false;
  }
}
