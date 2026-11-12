import type { AskQuestion } from '../db/schema.js';

// One AskUserQuestion answer: the chosen option numbers (from 1) and the "Other" text
export interface QuestionSelection {
  optionNumbers: number[];
  otherAnswer: string;
}

// A terminal that takes keys and reads its screen (LivePty)
export interface MenuTerminal {
  write(data: string): void;
  viewport(): Promise<string[]>;
}

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';
// How long to wait for the screen to change after each key; on timeout fail with the screen content
const SCREEN_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

// Write text as a paste (Claude Code enables bracketed paste) so newlines do not submit
export function pasted(text: string): string {
  return `\u001b[200~${text}\u001b[201~`;
}

// One menu row: a numbered option (with a checkbox for multi-select), or the trailing Next / Submit of multi-select
export interface MenuRow {
  number: number | null;
  label: string;
  checked: boolean | null;
}

export interface Menu {
  rows: MenuRow[];
  // Index in rows of the row holding the cursor (❯)
  cursor: number;
}

const OPTION_ROW = /^\s*(❯)?\s*(\d+)\.\s+(?:\[([ ✔])\]\s*)?(.*?)\s*$/u;
const NEXT_ROW = /^\s*(❯)?\s*(Next|Submit)\s*$/u;
// Compare screen text without whitespace and vertical borders (question text sometimes starts with "│ ")
const squeeze = (text: string) => text.replace(/[\s│]+/gu, '');

// This question's option menu on screen (the UI measured in step one of Reports/W30): the question text follows the last tab bar
// (☐ / ☒ plus each question's header), then the options up to "Chat about this". Null when the screen shows another question or the cursor is outside the menu
export function readMenu(lines: string[], question: AskQuestion): Menu | null {
  const tabs = lines.findLastIndex((line) => /[☐☒]/u.test(line));
  if (tabs < 0) return null;
  // The question text may wrap: accumulate squeezed lines until they contain the start of the question
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
      // After the options comes "Type something" (number = option count + 1); the later "Chat about this" is not an answer
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

// Turn answers into keys for Claude Code's option menu. Each step reads the screen first (cursor row, checkboxes) and waits
// for the screen to change after a key, so a cursor or checkbox a human moved is handled too (keys measured in step one of Reports/W30):
// - single-select: move the cursor to the chosen option ("Other" is "Type something", type the text), Enter, next question;
// - multi-select: set each option's checkbox to the answer (Enter toggles), type "Other" into "Type something", then Enter on Next / Submit;
// - with more than one question, or a single multi-select question, a Review page comes last; press 1 (Submit answers).
export async function answerMenu(
  terminal: MenuTerminal,
  questions: AskQuestion[],
  selections: QuestionSelection[],
  signal: AbortSignal,
): Promise<void> {
  if (selections.length !== questions.length) {
    throw new Error(`${String(questions.length)} questions, ${String(selections.length)} answered`);
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
          `Timed out waiting for ${what} in the terminal, screen:\n${lines.filter((l) => l.trim() !== '').join('\n')}`,
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
    if (selection === undefined) throw new Error(`Question ${String(i + 1)} has no answer`);
    const count = question.options.length;
    for (const n of selection.optionNumbers) {
      if (!Number.isInteger(n) || n < 1 || n > count) {
        throw new Error(`Question ${String(i + 1)} has no option ${String(n)}`);
      }
    }
    // Enter in the input box submits, so the "Other" text goes on one line
    const other = selection.otherAnswer.replace(/\s+/gu, ' ').trim();
    const menuOf = (lines: string[]) => readMenu(lines, question);
    const rowIndex = (menu: Menu, number: number | null) => {
      const index = menu.rows.findIndex((r) => r.number === number);
      if (index < 0) {
        throw new Error(`Question ${String(i + 1)}'s menu has no row ${String(number)}`);
      }
      return index;
    };
    // Move the cursor row by row to the target, waiting after each key until it actually moved
    const moveTo = async (number: number | null) => {
      let menu = await waitFor(`the menu of question "${question.question}"`, menuOf);
      const target = rowIndex(menu, number);
      while (menu.cursor !== target) {
        const from = menu.cursor;
        press(from < target ? DOWN : UP);
        menu = await waitFor('the cursor to move', (lines) => {
          const next = menuOf(lines);
          return next !== null && next.cursor !== from ? next : null;
        });
      }
      return menu;
    };

    if (question.multiSelect !== true) {
      if (other !== '' && selection.optionNumbers.length > 0) {
        throw new Error(
          `Single-select question ${String(i + 1)} has both an option and a written answer`,
        );
      }
      const [n, ...rest] = selection.optionNumbers;
      if (other === '' && (n === undefined || rest.length > 0)) {
        throw new Error(
          `Single-select question ${String(i + 1)} needs exactly one option: ${JSON.stringify(selection.optionNumbers)}`,
        );
      }
      await moveTo(other === '' ? (n ?? null) : count + 1);
      if (other !== '') {
        press(other);
        await waitFor('the "Other" text', (lines) =>
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
        await waitFor(`option ${String(n)}'s checkbox`, (lines) => {
          const next = menuOf(lines);
          return next !== null && next.rows[rowIndex(next, n)]?.checked === want ? true : null;
        });
      }
      if (other !== '') {
        await moveTo(count + 1);
        press(other);
        await waitFor('the "Other" text', (lines) => {
          const next = menuOf(lines);
          const row = next === null ? undefined : next.rows[rowIndex(next, count + 1)];
          return row !== undefined && squeeze(row.label).includes(squeeze(other)) ? true : null;
        });
      }
      await moveTo(null);
      press(ENTER);
    }
    // This question leaves the screen: the next question, the Review page, or the menu closes
    await waitFor(`question ${String(i + 1)} to be submitted`, (lines) => {
      if (isReview(lines)) return true;
      const menu = menuOf(lines);
      return menu === null ? true : null;
    });
  }
  const first = questions[0];
  if (questions.length > 1 || first?.multiSelect === true) {
    await waitFor('the Review page', (lines) => (isReview(lines) ? true : null));
    press('1');
  }
}
