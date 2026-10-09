import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const bin = fileURLToPath(new URL('../../bin/wrap.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/notes.txt', import.meta.url));
const missing = fileURLToPath(new URL('./fixtures/missing.txt', import.meta.url));

function cli(args, input = '') {
  const proc = spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8' });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

describe('input and output', () => {
  test('reads stdin and ends the output with one newline', () => {
    expect(cli(['--width', '10'], 'the quick brown fox')).toEqual({
      code: 0,
      stdout: 'the quick\nbrown fox\n',
      stderr: '',
    });
  });

  test('short option -w', () => {
    expect(cli(['-w', '10'], 'the quick brown fox').stdout).toBe('the quick\nbrown fox\n');
  });

  test('--width=N form', () => {
    expect(cli(['--width=10'], 'the quick brown fox').stdout).toBe('the quick\nbrown fox\n');
  });

  test('reads a file given as an argument', () => {
    expect(cli(['--width', '20', fixture])).toEqual({
      code: 0,
      stdout: 'Meeting notes for\nthe release.\n\nShip on Friday after\nthe final review.\n',
      stderr: '',
    });
  });

  test('default width is 80', () => {
    const text = Array.from({ length: 20 }, () => 'word').join(' ');
    const lines = cli([], text).stdout.split('\n');
    expect(lines.map((l) => l.length)).toEqual([79, 19, 0]);
  });

  test('empty input prints nothing', () => {
    expect(cli(['--width', '10'], '   \n\n')).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe('errors', () => {
  test.each(['0', '-5', 'abc', '1.5', ''])('invalid width "%s" exits 2', (width) => {
    const result = cli(['--width', width], 'some text');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`wrap: invalid width: ${width}\n`);
  });

  test('missing file exits 1 and names the file', () => {
    const result = cli([missing]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith(`wrap: cannot read ${missing}`)).toBe(true);
  });

  test('unknown option exits 2', () => {
    const result = cli(['--colour'], 'text');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('wrap: ')).toBe(true);
  });
});
