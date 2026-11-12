// The gateway does not enforce strict tool constraints; the model sometimes fills a required string field with filler
// (r-20261010-1iqzja answered Confirm goal with placeholder; repros also had blanks, ": " and "x", see Reports/W21, W23).
// Judge only the whole field: words like placeholder or todo can appear normally in body text
const FILLER = /^(placeholder|lorem ipsum|todo|tbd|n\/?a|none|null|undefined|x+)$/i;
// No letters, digits or CJK characters at all (blank, punctuation only)
const NO_CONTENT = /^[^\p{L}\p{N}]*$/u;

export function isFiller(text: string): boolean {
  const words = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return NO_CONTENT.test(text) || FILLER.test(words);
}
