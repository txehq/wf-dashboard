import type { AskQuestion } from '../db/schema.js';

// AskUserQuestion 的一个回答：所选选项的编号（从 1 开始）与"其他"的文字
export interface QuestionSelection {
  optionNumbers: number[];
  otherAnswer: string;
}

// 写按键并读屏幕的终端（LivePty）
export interface MenuTerminal {
  write(data: string): void;
  viewport(): Promise<string[]>;
}

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';
// 每次按键后等屏幕变化的上限；超过时以屏幕内容报错
const SCREEN_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

// 一段文字作为粘贴写入（Claude Code 开启了 bracketed paste），换行不会提交
export function pasted(text: string): string {
  return `\u001b[200~${text}\u001b[201~`;
}

// 菜单中的一行：编号的选项（多选带勾选框），或多选最后的 Next / Submit
export interface MenuRow {
  number: number | null;
  label: string;
  checked: boolean | null;
}

export interface Menu {
  rows: MenuRow[];
  // 光标（❯）所在行在 rows 中的位置
  cursor: number;
}

const OPTION_ROW = /^\s*(❯)?\s*(\d+)\.\s+(?:\[([ ✔])\]\s*)?(.*?)\s*$/u;
const NEXT_ROW = /^\s*(❯)?\s*(Next|Submit)\s*$/u;
// 比较屏幕文字时去掉空白与竖线边框（问题文字左侧有时带"│ "）
const squeeze = (text: string) => text.replace(/[\s│]+/gu, '');

// 屏幕上这个问题的选项菜单（Reports/W30 第一步实测的界面）：最后一行标签栏（☐ / ☒ 加各问题的 header）之后紧接着问题文字，
// 再之后是选项，到"Chat about this"为止。屏幕上当前不是这个问题，或光标不在菜单中时为空
export function readMenu(lines: string[], question: AskQuestion): Menu | null {
  const tabs = lines.findLastIndex((line) => /[☐☒]/u.test(line));
  if (tabs < 0) return null;
  // 问题文字可能折成多行：去掉空白后逐行累积，直到包含整个问题的开头
  const needle = squeeze(question.question).slice(0, 24);
  let text = '';
  let start = tabs;
  while (text.length < needle.length && start + 1 < lines.length) {
    start += 1;
    text += squeeze(lines[start] ?? '');
  }
  if (needle === '' || !text.startsWith(needle)) return null;
  const rows: MenuRow[] = [];
  let cursor = -1;
  const optionCount = question.options.length;
  for (const line of lines.slice(start + 1)) {
    const option = OPTION_ROW.exec(line);
    if (option !== null) {
      const number = Number(option[2]);
      // 选项之后是"Type something"（编号为选项数 + 1），再之后的"Chat about this"不属于回答
      if (number > optionCount + 1) break;
      if (option[1] !== undefined) cursor = rows.length;
      rows.push({
        number,
        label: option[4] ?? '',
        checked: option[3] === undefined ? null : option[3] === '✔',
      });
      continue;
    }
    const next = NEXT_ROW.exec(line);
    if (next !== null) {
      if (next[1] !== undefined) cursor = rows.length;
      rows.push({ number: null, label: next[2] ?? '', checked: null });
    }
  }
  if (rows.filter((r) => r.number !== null).length !== optionCount + 1 || cursor < 0) return null;
  return { rows, cursor };
}

const isReview = (lines: string[]) =>
  lines.some((l) => l.includes('Review your answers')) &&
  lines.some((l) => /❯\s*1\.\s*Submit answers/u.test(l));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 把回答换成按键写进 Claude Code 的选项菜单。每一步先读屏幕：光标所在行、勾选状态，按键后等屏幕变化再走下一步，
// 人在终端里动过的光标与勾选也照常处理（Reports/W30 第一步的按键实测）：
// - 单选：光标移到所选选项（"其他"为"Type something"，写文字）后回车，进入下一题；
// - 多选：逐个选项把勾选状态改成回答（回车切换），"其他"在"Type something"中写文字，再移到 Next / Submit 回车；
// - 多于一个问题，或唯一的问题是多选时，最后出现 Review 页，按 1（Submit answers）提交。
export async function answerMenu(
  terminal: MenuTerminal,
  questions: AskQuestion[],
  selections: QuestionSelection[],
  signal: AbortSignal,
): Promise<void> {
  if (selections.length !== questions.length) {
    throw new Error(`${String(questions.length)} 个问题，回答了 ${String(selections.length)} 个`);
  }
  const waitFor = async <T>(what: string, read: (lines: string[]) => T | null): Promise<T> => {
    const deadline = Date.now() + SCREEN_TIMEOUT_MS;
    for (;;) {
      signal.throwIfAborted();
      const lines = await terminal.viewport();
      const found = read(lines);
      if (found !== null) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `终端中等不到${what}，屏幕内容：\n${lines.filter((l) => l.trim() !== '').join('\n')}`,
        );
      }
      await sleep(POLL_MS);
    }
  };
  const press = (key: string) => {
    signal.throwIfAborted();
    terminal.write(key);
  };

  for (const [i, question] of questions.entries()) {
    const selection = selections[i];
    if (selection === undefined) throw new Error(`问题 ${String(i + 1)} 没有回答`);
    const count = question.options.length;
    for (const n of selection.optionNumbers) {
      if (!Number.isInteger(n) || n < 1 || n > count) {
        throw new Error(`问题 ${String(i + 1)} 没有选项 ${String(n)}`);
      }
    }
    // 输入框中的回车会提交，"其他"的文字写成一行
    const other = selection.otherAnswer.replace(/\s+/gu, ' ').trim();
    const menuOf = (lines: string[]) => readMenu(lines, question);
    const rowIndex = (menu: Menu, number: number | null) => {
      const index = menu.rows.findIndex((r) => r.number === number);
      if (index < 0) throw new Error(`问题 ${String(i + 1)} 的菜单中没有第 ${String(number)} 行`);
      return index;
    };
    // 光标逐行移到目标行，每次按键后等光标真的移动
    const moveTo = async (number: number | null) => {
      let menu = await waitFor(`问题「${question.question}」的菜单`, menuOf);
      const target = rowIndex(menu, number);
      while (menu.cursor !== target) {
        const from = menu.cursor;
        press(from < target ? DOWN : UP);
        menu = await waitFor('光标移动', (lines) => {
          const next = menuOf(lines);
          return next !== null && next.cursor !== from ? next : null;
        });
      }
      return menu;
    };

    if (question.multiSelect !== true) {
      if (other !== '' && selection.optionNumbers.length > 0) {
        throw new Error(`单选问题 ${String(i + 1)} 既选了选项又写了回答`);
      }
      const [n, ...rest] = selection.optionNumbers;
      if (other === '' && (n === undefined || rest.length > 0)) {
        throw new Error(
          `单选问题 ${String(i + 1)} 要选一项：${JSON.stringify(selection.optionNumbers)}`,
        );
      }
      await moveTo(other === '' ? (n ?? null) : count + 1);
      if (other !== '') {
        press(other);
        await waitFor('"其他"的文字', (lines) =>
          squeeze(lines.join('')).includes(squeeze(other)) ? true : null,
        );
      }
      press(ENTER);
    } else {
      for (let n = 1; n <= count; n++) {
        const want = selection.optionNumbers.includes(n);
        const menu = await moveTo(n);
        if (menu.rows[rowIndex(menu, n)]?.checked === want) continue;
        press(ENTER);
        await waitFor(`选项 ${String(n)} 的勾选`, (lines) => {
          const next = menuOf(lines);
          return next !== null && next.rows[rowIndex(next, n)]?.checked === want ? true : null;
        });
      }
      if (other !== '') {
        await moveTo(count + 1);
        press(other);
        await waitFor('"其他"的文字', (lines) => {
          const next = menuOf(lines);
          const row = next === null ? undefined : next.rows[rowIndex(next, count + 1)];
          return row !== undefined && squeeze(row.label).includes(squeeze(other)) ? true : null;
        });
      }
      await moveTo(null);
      press(ENTER);
    }
    // 这一题离开屏幕：进入下一题、Review 页，或菜单关闭
    await waitFor(`问题 ${String(i + 1)} 提交`, (lines) => {
      if (isReview(lines)) return true;
      const menu = menuOf(lines);
      return menu === null ? true : null;
    });
  }
  const first = questions[0];
  if (questions.length > 1 || first?.multiSelect === true) {
    await waitFor('Review 页', (lines) => (isReview(lines) ? true : null));
    press('1');
  }
}
