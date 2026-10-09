import fs from 'node:fs';
import { execa } from 'execa';
import { HttpError } from './errors.js';

export interface StepOptions {
  cwd: string;
  env: Record<string, string>;
}

// 把构建的每一步（命令、输出、退出码、耗时）追加到 build.log；命令失败时先调用 onFailure 记录状态再抛错
export class BuildLog {
  readonly timings: Record<string, number> = {};

  constructor(
    private readonly file: string,
    private readonly onStep: (step: string) => void,
    private readonly onFailure: (message: string) => void,
  ) {}

  append(text: string) {
    fs.appendFileSync(this.file, text);
  }

  async run(step: string, command: string, args: string[], options: StepOptions): Promise<string> {
    this.onStep(step);
    const shown = [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part));
    this.append(`\n$ [${step}] ${shown.join(' ')}\n`);
    const started = performance.now();
    const result = await execa(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
      all: true,
      reject: false,
      maxBuffer: 256 * 1024 * 1024,
    });
    const seconds = Math.round(performance.now() - started) / 1000;
    this.timings[step] = seconds;
    if (result.all !== '') this.append(result.all.endsWith('\n') ? result.all : `${result.all}\n`);
    const exit = result.signal ?? String(result.exitCode);
    this.append(`[${step}] exit ${exit}, ${String(seconds)} s\n`);
    if (result.failed) {
      const message = `构建步骤 ${step} 失败（exit ${exit}）`;
      this.onFailure(message);
      throw new HttpError(500, message);
    }
    return result.stdout;
  }

  // 不调用外部命令的步骤，只记录耗时与一行说明
  note(step: string, started: number, text: string) {
    const seconds = Math.round(performance.now() - started) / 1000;
    this.timings[step] = seconds;
    this.append(`\n[${step}] ${text}\n[${step}] ${String(seconds)} s\n`);
  }
}
