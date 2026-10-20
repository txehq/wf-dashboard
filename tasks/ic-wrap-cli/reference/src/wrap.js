/**
 * Re-flow text so that no line is longer than `width` characters.
 *
 * - Paragraphs are separated by blank lines and stay separated by exactly one blank line.
 * - Inside a paragraph, runs of whitespace (including single newlines) collapse to one space.
 * - Words longer than `width` are broken into chunks of `width` characters.
 * - Width is counted in Unicode code points.
 *
 *   wrap('the quick brown fox', 10) // => 'the quick\nbrown fox'
 */
export function wrap(text, width = 80) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`width must be a positive integer, got ${String(width)}`);
  }
  return text
    .split(/\r?\n(?:[ \t\r]*\r?\n)+/)
    .map((paragraph) => wrapParagraph(paragraph, width))
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

function wrapParagraph(paragraph, width) {
  const words = paragraph.split(/\s+/).filter((word) => word !== '');
  const lines = [];
  let line = [];
  for (const word of words) {
    const chars = [...word];
    if (line.length > 0 && line.length + 1 + chars.length <= width) {
      line.push(' ', ...chars);
      continue;
    }
    if (line.length > 0) lines.push(line.join(''));
    // A word longer than the width is split into full-width chunks; its tail starts the next line.
    while (chars.length > width) lines.push(chars.splice(0, width).join(''));
    line = chars;
  }
  if (line.length > 0) lines.push(line.join(''));
  return lines.join('\n');
}
