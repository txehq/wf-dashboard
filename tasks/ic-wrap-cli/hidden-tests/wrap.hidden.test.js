import { describe, expect, test } from 'vitest';
import { wrap } from '../../src/wrap.js';

const longest = (text) => Math.max(...text.split('\n').map((line) => [...line].length));

describe('line breaking', () => {
  test('greedy fill between words', () => {
    expect(wrap('the quick brown fox jumps over the lazy dog', 15)).toBe(
      'the quick brown\nfox jumps over\nthe lazy dog',
    );
  });

  test('a word that exactly fills the width', () => {
    expect(wrap('abcde fghij', 5)).toBe('abcde\nfghij');
  });

  test('the first word is not preceded by an empty line', () => {
    expect(wrap('abcde fg', 5)).toBe('abcde\nfg');
  });

  test('no line exceeds the width', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.';
    for (const width of [1, 3, 7, 12, 20]) expect(longest(wrap(text, width))).toBeLessThanOrEqual(width);
  });

  test('default width is 80', () => {
    const text = Array.from({ length: 20 }, () => 'word').join(' ');
    expect(wrap(text).split('\n').map((l) => l.length)).toEqual([79, 19]);
  });
});

describe('whitespace', () => {
  test('runs of spaces and tabs collapse to one space', () => {
    expect(wrap('a   b\t\tc', 80)).toBe('a b c');
  });

  test('single newlines inside a paragraph are re-flowed', () => {
    expect(wrap('one\ntwo\nthree four', 80)).toBe('one two three four');
  });

  test('leading and trailing whitespace is removed', () => {
    expect(wrap('   hello world   \n', 80)).toBe('hello world');
  });

  test('no line has trailing spaces', () => {
    const out = wrap('aa bb cc dd ee ff', 5);
    for (const line of out.split('\n')) expect(line).toBe(line.trim());
  });

  test('empty and whitespace-only input give an empty string', () => {
    expect(wrap('', 10)).toBe('');
    expect(wrap(' \n\t\n ', 10)).toBe('');
  });
});

describe('paragraphs', () => {
  test('blank lines separate paragraphs', () => {
    expect(wrap('first para\n\nsecond para', 80)).toBe('first para\n\nsecond para');
  });

  test('several blank lines collapse to one', () => {
    expect(wrap('a\n\n\n\nb', 80)).toBe('a\n\nb');
  });

  test('lines with only spaces count as blank', () => {
    expect(wrap('a\n   \n\t\nb', 80)).toBe('a\n\nb');
  });

  test('each paragraph is wrapped on its own', () => {
    expect(wrap('aaa bbb ccc\n\nddd eee', 7)).toBe('aaa bbb\nccc\n\nddd eee');
  });

  test('CRLF line endings', () => {
    expect(wrap('one\r\ntwo\r\n\r\nthree\r\n', 80)).toBe('one two\n\nthree');
  });
});

describe('long words', () => {
  test('a word longer than the width is split into full-width chunks', () => {
    expect(wrap('abcdefghij', 4)).toBe('abcd\nefgh\nij');
  });

  test('a long word starts on a new line', () => {
    expect(wrap('ab cdefghij', 4)).toBe('ab\ncdef\nghij');
  });

  test('words after a long word can join its last chunk', () => {
    expect(wrap('abcdefghij x', 4)).toBe('abcd\nefgh\nij x');
  });

  test('width 1 puts every character on its own line', () => {
    expect(wrap('ab c', 1)).toBe('a\nb\nc');
  });
});

describe('unicode', () => {
  test('width counts code points, not UTF-16 units', () => {
    expect(wrap('😀😀😀😀😀', 2)).toBe('😀😀\n😀😀\n😀');
  });

  test('accented words are not split early', () => {
    expect(wrap('héllo wörld', 5)).toBe('héllo\nwörld');
  });
});

describe('invalid width', () => {
  test.each([0, -3, 2.5, Number.NaN])('width %s throws RangeError', (width) => {
    expect(() => wrap('text', width)).toThrow(RangeError);
  });
});
