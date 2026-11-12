import fs from 'node:fs';
import { execa } from 'execa';
import { HttpError } from './errors.js';

export interface StepOptions {
  cwd: string;
  env: Record<string, string>;
}

// Appends every build step (command, output, exit code, duration) to build.log; on failure calls onFailure, then throws
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
      // Use only the given environment, without the parent process environment
      extendEnv: false,
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
      const message = `Build step ${step} failed (exit ${exit})`;
      this.onFailure(message);
      throw new HttpError(500, message);
    }
    return result.stdout;
  }

  // A step without an external command: records only its duration and one line of text
  note(step: string, started: number, text: string) {
    const seconds = Math.round(performance.now() - started) / 1000;
    this.timings[step] = seconds;
    this.append(`\n[${step}] ${text}\n[${step}] ${String(seconds)} s\n`);
  }

  // A step without an external command failed: records the message and status, then throws
  fail(step: string, message: string): never {
    this.append(`\n[${step}] ${message}\n`);
    this.onFailure(message);
    throw new HttpError(400, message);
  }
}
