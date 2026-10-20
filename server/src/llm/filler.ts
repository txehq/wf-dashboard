// gateway 不执行 strict tool 的约束，模型偶尔把需要填写的字符串字段整段填成占位内容
// （r-20261010-1iqzja 的 Confirm goal 回答为 placeholder；复现中还有空白、": "、"x"、"占位"，见 Reports/W21、W23）。
// 只判定整个字段：正文里可能正常出现 placeholder、todo 这些词
const FILLER =
  /^(placeholder|lorem ipsum|todo|tbd|n\/?a|none|null|undefined|x+|占位(符|内容)?|待(填|补|定|写)|此处省略)$/i;
// 不含任何字母、数字或汉字（空白、纯标点）
const NO_CONTENT = /^[^\p{L}\p{N}]*$/u;

export function isFiller(text: string): boolean {
  const words = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return NO_CONTENT.test(text) || FILLER.test(words);
}
