---
kind: brief
product: Magi Eval
feature: r-20261009-dqva52
updated: "2026-10-09"
---

# Brief: Offline Web Calculator for the Junior High Computer Lab
**Date:** 2026-10-09 · **Interviewed:** school teacher (requirement submitter) · **By:** Claude Opus 5.5 (/lfg session)

## Problem & consumer

- **Users:** students from grade 7 to grade 9 at the school, who use it in the school computer lab (Windows 7, Chrome 109 installed by the school) and also on their own computers at home; the teacher projects it for the whole class during lessons.
- **Problem:** The computer lab currently has an ordinary calculator, students also use their phones to calculate, it is inconvenient to use, and phones are not allowed during class. The lab often loses its internet connection, so web pages that need to be online to open don't work.
- **Why now:** it needs to be usable before the semester starts, two months from now; the delivery date is **2026-12-09**.
- **Common confusion:** Computing `0.1+0.2` on a computer shows a long string of strange numbers that confuse students; numbers that don't divide evenly display untidily; dividing by 0, unmatched parentheses, and taking the square root of a negative number have no clear prompts.

## Done means

All of the teacher's prepared test questions calculate correctly, and the displayed results match exactly:

| Input | Display |
|---|---|
| `0.1+0.2` | `0.3` |
| `(2+3)*4` | `20` |
| `2^10` | `1024` |
| `√16` | `4` |
| `50%*200` | `100` |
| `1/3` | `0.3333333333` |
| `-5+3` | `-2` |
| `1/0` | Chinese prompt "Cannot divide by 0", error position marked in red |
| `(2+3` | Chinese prompt "Unmatched parentheses", marks the missing or extra parentheses |

In addition, each item under "Features to build" below can be demonstrated on Windows 7 + Chrome 109, offline, by double-clicking the web page file. The minimum evidence: a screenshot of each row in the table above, plus screenshots of history (still there after closing and reopening, click to put back, clear) and projector mode.

## Where it lives

- **Repo:** `txehq/wfe-r-20261009-dqva52` (GitHub), currently has just one commit, which contains only a single line in `README.md`.
- **Product:** Magi Eval; feature slug `r-20261009-dqva52`.
- **Deliverable:** a single web page file (`.html`); double-click to open in Chrome; fully offline, nothing to install; include a Chinese usage guide. Once done, the developer sends both files to the teacher via WeChat or email; the teacher does not register on any website. The teacher copies the file to the computer room PCs or a USB drive; students may also copy it home.
- **Basis:** this brief is the only requirements source; there is no corresponding ticket or spec document.
- **Prerequisites:** None.
- **Follow-up work:** No known follow-up.

### Features to build

1. **How to open:** a single `.html` file with all code, styles and fonts included; double-click to open in Chrome 109 (`file://`); it makes no network requests at any time.
2. **Input:** on-screen buttons, and you can also type directly on the keyboard; the whole expression is shown in the input box, and pressing "=" (or Enter) gives the result.
3. **Operations:** add `+`, subtract `-`, multiply `*`/`×`, divide `/`/`÷`, parentheses, negative numbers, decimals, percent, power `^`, square root `√`.
   - Percent: `50%` equals 0.5, `50%*200=100`, `200+10%=200.1`.
   - Order of operations follows the junior high textbook: parentheses first, then powers and square roots, then multiplication and division, and finally addition and subtraction.
   - `-2^2 = -4` (compute the power first, then negate).
   - `2^3^2 = 512` (exponentiation is evaluated from right to left).
   - Implicit multiplication is allowed: `2(3+4)=14`, `2√9=6`.
   - Decimal calculations are exact: `0.1+0.2` gives `0.3`.
4. **Result display:** First round to 10 decimal places, keep at most 12 significant digits, remove trailing 0s (`1/3` → `0.3333333333`). Nonzero results whose integer part exceeds 12 digits, or whose absolute value is less than 0.0000000001, are displayed in scientific notation, for example `2^50` → `1.12589990684×10^15`, `1/300000000000` → `3.33333333333×10^-12`.
5. **Error messages:** Explain the cause in Chinese, mark the error position in red within the expression, and keep the expression in the input box for editing:
   - Division by 0: "Cannot divide by 0"
   - Unmatched parentheses: "Parentheses don't match", marking the extra or missing parenthesis
   - Negative square root: "Cannot take the square root of a negative number"
   - Negative base with a fractional exponent, e.g. `(-8)^0.5`: "Cannot take this root of a negative number"
   - Incomplete expression, e.g. `3+`: "Expression is incomplete"
   - Absolute value of the result exceeds 10^100: "Result too large, can't compute"
   - Other syntax errors, e.g. `3..2`, `*5`: "Expression format is incorrect", marking the first incorrect character
   - `0^0`: "0 to the power of 0 has no meaning" (per the textbook, a⁰ = 1 requires a ≠ 0)
6. **History:** Keep the most recent 20 entries (expressions and results); older ones are deleted automatically. Records remain after closing and reopening the page, and are only deleted when you click "Clear". Clicking an entry puts that expression back into the input box so students can edit it before recalculating. The lab computers have restore cards and are restored periodically; after a reboot the history is cleared. This is the restore card's doing, and the web page cannot keep it, so state this in the usage instructions. Students' home computers are not affected.
7. **Projection mode:** One button enlarges the font so the whole class can see; click it again to restore the original font size.

## Verified current behaviour

- Repo `txehq/wfe-r-20261009-dqva52` has only the commit `09d22b2 chore: initial commit`, whose content is one `README.md` line (`# wfe-r-20261009-dqva52`), with no code, tests, or CI config.
- The Obsidian vault `Project Magi Eval/Features/` has no folder for this slug; Linear has no ticket for this calculator.

## Out of scope & constraints

**Not doing this time:**

- Trigonometric functions, logarithms
- Fraction calculations, and displaying results as fractions
- Plotting function graphs
- Solving equations
- Showing calculation steps
- Use on phones and tablets
- Memory keys such as M+
- Any online features (online updates, statistics, uploads, external fonts or scripts)
- Installers or browser extensions
- Copying files to the computer room PCs (the teacher does this)

**Constraints:**

- Must work fully offline on Windows 7 + Chrome 109.
- Delivery date: 2026-12-09 (before the start of term).
- The developer decides the technical choices; the teacher only checks whether the results are correct and whether students can understand them.
- All interface text and prompts are in Chinese, so middle-school students can understand them.

## Authority ceiling

- **The session can handle these itself:** split tickets, choose technology, write code, test, open PRs, revise per review comments; merging follows the repo's automatic merge rules.
- **Ceiling:** Work ends when the PR is merged into the repo. There is no production environment; copying files to the computer room PCs is done by the teacher.
- **Must ask the teacher first:** Anything that would change the features, display rules, error messages, or the "Not doing this time" list in this brief.

## Open questions

- Which approach to use for exact decimal arithmetic (choice of decimal math library), and how to implement the display rules (10 decimal places, 12 significant digits, scientific notation).
- How to bundle all code, styles, and dependencies into a single `.html` file that runs under `file://`, and prove it makes no network requests.
- How to save history under `file://` (the behavior of `localStorage` for `file://` pages in Chrome 109 needs to be verified).
- How expressions are parsed: implicit multiplication, `√` followed by a number or parentheses, percent signs, precedence of negation and exponentiation, and how error positions are located.
- How much to enlarge in projection mode, and the layout of the on-screen keys.
- How to verify on Windows 7 + Chrome 109 (preparing the test environment).

## Decision ledger

| Question | Answer | Status |
|---|---|---|
| Delivery format | A standalone web page file, opened by double-clicking, no network | confirmed |
| Input method | On-screen keys and keyboard both work; shows the whole expression; press "=" to get the result | confirmed |
| Result display | Round to 10 decimal places, at most 12 significant digits, drop trailing zeros; fractions not shown | confirmed |
| Very large and very small numbers | Scientific notation (`×10^n`) | delegated (teacher chose the recommended approach) |
| `-2^2` | -4 | confirmed |
| `2^3^2` | 512 | delegated |
| `200+10%` | 200.1 | confirmed |
| Omit multiplication sign | Allowed, `2(3+4)=14`, `2√9=6` | confirmed |
| History | Last 20 entries, still there after closing the page, deleted only when you click "Clear", click to put back into the input box | confirmed |
| Projector mode | One click to enlarge the font size, click again to restore | confirmed |
| Error message text | Eight Chinese messages (see feature 5), mark the error position in red, keep the expression | confirmed |
| Syntax error message | "Expression format is incorrect", marking the first incorrect character | confirmed |
| `0^0` | Show "0 to the power of 0 has no meaning" | confirmed |
| Delivery method | Send the file to the teacher via WeChat or email; the teacher does not register on a website | confirmed |
| Computer room restore card | Computer room PCs have restore cards; history is cleared after restart; written into the usage guide | confirmed |
| Out-of-scope features | See "Not doing this time" list | confirmed |
| Session permissions | Break down tickets yourself and open PRs; merge per repo rules | confirmed |
| Copy files to the computer lab | Teacher does it themselves | confirmed |
| Delivery date | 2026-12-09 | confirmed |
| Technical choices | Decided by the development side | delegated |

## Inferred answers & sources

- **Do not collect or send student information:** Inferred from "fully offline"; the teacher has confirmed the summary draft.
- **Home computers also use Chrome, version 109 or higher:** Inferred from the computer lab environment; the teacher has confirmed the summary draft.
- **Delivery date 2026-12-09:** Inferred from "two months before the start of school" and today's date 2026-10-09; confirmed by the teacher.
- **"=" can also be triggered with the keyboard Enter key:** Inferred from "the keyboard must also work"; this is a default practice that can be changed.
