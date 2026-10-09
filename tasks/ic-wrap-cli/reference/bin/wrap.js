#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { wrap } from '../src/wrap.js';

function fail(message, code) {
  process.stderr.write(`wrap: ${message}\n`);
  process.exit(code);
}

// strict: false keeps parseArgs from throwing; unknown options are reported below.
const { values, positionals } = parseArgs({
  options: { width: { type: 'string', short: 'w', default: '80' } },
  allowPositionals: true,
  strict: false,
});

const unknown = Object.keys(values).filter((name) => name !== 'width');
if (unknown.length > 0) fail(`unknown option: --${unknown[0]}`, 2);
if (positionals.length > 1) fail('expected at most one file', 2);
const rawWidth = String(values.width);
if (!/^[1-9]\d*$/.test(rawWidth)) fail(`invalid width: ${rawWidth}`, 2);
const width = Number(rawWidth);

const file = positionals[0];
if (file !== undefined && !(existsSync(file) && statSync(file).isFile())) {
  fail(`cannot read ${file}`, 1);
}
const input = readFileSync(file ?? 0, 'utf8');

const output = wrap(input, width);
if (output !== '') process.stdout.write(`${output}\n`);
