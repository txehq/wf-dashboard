---
kind: brief
product: Magi Eval
feature: r-20261009-i6vxt1
updated: "2026-10-09"
---

# Brief: Offline web calculator for junior high classrooms
**Date:** 2026-10-10 · **Interviewed:** Grade 7 to Grade 9 math teachers (also in charge of the school computer lab and IT classes) · **By:** Claude (Opus 5.5), `/lfg` stage 1

## Problem & consumer

- **Who it is for:** Students in Grades 7 to 9, who use it to work out problems in computer-lab lessons at school and also at home; teachers demonstrate it to the whole class on a projector.
- **Problem to solve:** Calculators found online at random show `0.1+0.2` as `0.30000000000000004`, which students cannot understand; when an expression is written wrong there is no understandable hint either, so teachers have to explain each one individually.
- **Why now:** It must be used in class starting next semester, and school starts in about two months.

## Done means

All of the following must hold for acceptance:

1. All 10 acceptance questions from the teacher are answered correctly:
   - `0.1+0.2` → `0.3`
   - `(2+3)*4` → `20`
   - `2^10` → `1024`
   - `√16` → `4`
   - `50%*200` → `100`
   - `1/3` → `0.3333333333`
   - `-5+3` → `-2`
   - `(1+2)*(3+4)/7` → `3`
   - `5/0` → shows "Cannot divide by 0"
   - `(1+2` → shows "Unmatched brackets"
2. After disconnecting from the network, double-click to open the file in Chrome 109 (`file://`); all features work and the page makes no network requests.
3. The same file hosted on a website (`http://` or `https://`) also works when opened.
4. Each item in "Features to build" below has either an auto test or acceptance proof with a screenshot.

Minimum proof: automated tests for the 10 problems above and the seven error messages pass on Chrome 109; the page makes 0 network requests when opened offline; history still exists after closing and reopening the browser; screenshots before and after enlarging in projection mode.

### Features to build

1. **What it can calculate:** add, subtract, multiply, divide (`+ - × ÷`, also accepts `* /`), parentheses, percent sign, sign, power `^`, square root `√`.
2. **Operation rules follow the junior high textbook:**
   - `-2^2` = `-4`, exponentiation first, then the negative sign;
   - `200+10%` = `200.1`: the percent sign only means divide by 100 (`10%` is `0.1`, `50%` is `0.5`), not calculated like a phone calculator's "add 10% of 200";
   - `2^3^2` = `512`, repeated exponentiation is evaluated from right to left;
   - `2(3+4)` = `14`, writing without the multiplication sign is also recognized.
3. **Result display:** round to 10 decimal places and remove trailing zeros; extremely large or small numbers use scientific notation (in the form `1.1258999068×10^15`); `0.1+0.2` displays `0.3`.
4. **Error messages:** when the input is wrong or cannot be calculated, no result is shown; only one red Chinese error message is displayed, and the error position in the expression is marked red. There are seven error messages in total, which must be used verbatim:

   | Case | Verbatim message |
   |---|---|
   | Divide by 0 | Cannot divide by 0 |
   | Parentheses not paired | Parentheses do not match |
   | Square root of a negative number | Cannot take the square root of a negative number |
   | Two symbols together, for example `3++4`, `5×÷2` | Symbols run together |
   | Incomplete expression, for example `3+`, `√` | Expression is incomplete |
   | Character the calculator does not recognize, for example the letter `a` | Unknown character: a (the character written after the colon) |
   | Result out of displayable range | Number too large, cannot calculate |

5. **Input:** on-screen buttons and the keyboard both work, including the numeric keypad; press Enter to get the result; full-width symbols typed with the Chinese input method on (full-width parentheses, full-width digits, `×`, `÷`, etc.) are also recognized correctly.
6. **History:** keeps the last 20 solved problems; click a problem and its expression goes back into the input box so it can be edited and recalculated; there is a "Clear history" button; after closing and reopening the browser, the records still exist until "Clear history" is clicked.
7. **Projection mode:** click a button and the text and buttons are enlarged together, so students at the back of the classroom can see clearly; click again to restore the original size.
8. **Delivery format:** a single web page file; double-click to open it directly, and it also works directly when placed on a website. Both uses are the same file, and the file does not depend on any external resources.
9. **Devices:** mainly used on computers: the computer lab has Windows 7 with Chrome 109, and at home it is an ordinary computer browser. Phones and tablets can make do: the page displays fully and the buttons can be tapped.

## Where it lives

- **Repository:** `txehq/wfe-r-20261009-i6vxt1` (private, default branch `main`). Currently it only has a `README.md` with one line and one initial commit; the calculator is written from scratch.
- **Product:** Magi Eval; feature ID `r-20261009-i6vxt1`.
- **Deliverable:** a single `.html` file.
- **Source of truth:** this brief. There is no corresponding Linear ticket yet; the ticket will be created in step 4 of `/lfg`.
- **Prerequisites:** none.
- **Later (not doing this time):**
  - After the file is delivered, the teacher will find time to try it on the lab computers and give feedback if problems come up;
  - The teacher who manages the school network is responsible for putting the file on the school intranet website.

## Verified current behaviour

- Repository `txehq/wfe-r-20261009-i6vxt1` has only `README.md` (content `# wfe-r-20261009-i6vxt1`) and commit `825053b chore: initial commit`. The repository has no code, build, tests or CI (2026-10-10, checked with `ls`, `git log` and `gh repo view`).
- In the vault, `Project Magi Eval/Features/r-20261009-i6vxt1/` does not exist; there is no Linear ticket for this feature ID (searched 2026-10-10).
- Runtime environment (provided by the teacher):
  - The lab computers run Windows 7, the school has Chrome 109 installed uniformly, and the network often goes down;
  - The lab computers have a restore system installed, which clears local data after a restart;
  - The school intranet can only be accessed from inside the school; it cannot be opened at home.

## Out of scope & constraints

**Not doing this time:**

- Accounts and login;
- Collecting any student data or usage, including statistics and log reporting;
- Fraction and root-form results; all results are shown as decimals;
- Trigonometric functions, logarithms, and other scientific calculator features;
- Printing;
- Languages other than Chinese;
- Putting the files on the school intranet website, which is handled by the teacher in charge of the school network;
- Designing pages specifically for phones and tablets, or specifically testing phones and tablets;
- Testing on real Windows 7 machines, and a test checklist for the teacher;
- Keeping history after the lab computers restart;
- Remotely operating lab computers.

**Constraints:**

- **Fully offline:** The page must not make any network requests, including fonts, images, analytics, and update checks.
- **Browser:** All features work on Chrome 109 (the last version Windows 7 can install), and also work on the current versions of Chrome and Edge.
- **Both ways of opening work:** Double-clicking to open via `file://` and opening from the website must both work, using the same file.
- **Delivery date:** Before 2026-12-09, before the start of next semester.
- **The whole interface is in Chinese, ** Prompt messages use the wording from the table above word for word.

## Authority ceiling

- **No need to ask, just do it:**
  - Writing code, writing auto tests, setting up builds and CI;
  - Opening PRs; once code checks and CI pass, merging them into `main` via the repo's Auto Merge (each dev lane does not merge its own PR);
  - Generating the final web page file and publishing it in the repo.
- **Must ask first:**
  - Sending the files to the teacher's email. The teacher will provide the email address after the files are done;
  - Anything sent to people outside the organization.
- **Limit:** Files are delivered to the teacher's email. Putting them on the school intranet website is handled by the teacher in charge of the school network, not part of this feature, and there is no other online environment.
- **Hard requirement:** The page makes 0 network requests; it collects no data.

## Open questions

- How to build the calculator into a single `.html` file that does not depend on external resources, so it runs on both `file://` and the website in Chrome 109 (choose the build tool, and confirm JavaScript and CSS syntax is compatible with Chrome 109).
- Which decimal exact-arithmetic library to use, to guarantee results like `0.1+0.2=0.3`, and the precision and rounding mode for square roots and powers.
- What exactly is the limit for "number too large to calculate"; when to switch to scientific notation (how large, how small), and the format of scientific notation.
- Whether a minus sign right after an operator, such as `3×-2` or `2^-1`, is calculated normally or shows the message "signs are stuck together". This changes what students see, so the teacher needs to confirm.
- Precedence of `√` relative to other operations, and several notations: `√16^2`, `√(9+7)`, `2√9` (omitted multiplication sign).
- How percent signs combine with parentheses and powers: `(1+2)%`, `50%^2`, `10%%`.
- When an expression has several errors, which message to show and which position to mark in red.
- A lookup table of full-width characters and other similar characters (full-width digits, full-width brackets, `×`, `÷`, `-`, `()`, `...`, `,` etc.).
- How to type `√`, `^`, `%` with the keyboard, and what keys such as `Backspace` and `Esc` do.
- Whether history is saved in `localStorage` on `file://` and on the website; what the effect is when all local files share the same storage area when opened by double-clicking.
- The zoom factor for projection mode, and at what projection resolution scrollbars must be avoided.
- How to run Chrome 109 auto tests in CI, and which current browser version to test.
- The file name (for example `calculator.html`) and how the file is published after each merge.

## Decision ledger

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | Who uses it, and where | Grade 7 to 9 students use it in the computer lab and at home, the teacher demonstrates it by projection | confirmed |
| 2 | Calculator type | Basic calculator, with power `^` and square root `√`; no trig functions or logarithms | confirmed |
| 3 | Running format | Web page; Windows 7 plus Chrome 109; must be fully offline, with no network requests at all | confirmed |
| 4 | Result display | Round to 10 decimal places, removing trailing 0s; very large or very small numbers use scientific notation | confirmed |
| 5 | `-2^2` | `-4` | confirmed |
| 6 | `2^3^2` | `512`, calculated right to left | delegated (default: right-associative, the usual mathematical convention) |
| 7 | `200+10%` | `200.1`, a percent sign means dividing by 100 | confirmed |
| 8 | `2(3+4)` | Recognised, calculated as `14` | delegated (default: implicit multiplication supported) |
| 9 | Exact wording of the three error messages | "Cannot divide by 0", "Parentheses don't match", "Cannot take the square root of a negative number" | confirmed |
| 10 | Other four error messages | "Symbols run together", "Expression is incomplete", "Unknown character: a", "Number too large to calculate" | confirmed |
| 11 | Red highlight scope | Both the message and the error position in the expression are highlighted in red | confirmed |
| 12 | Input method | On-screen buttons and keyboard (including numeric keypad, Enter shows the result); recognises full-width symbols | confirmed |
| 13 | Delivery format | One web page file: double-click to open, or place it on the school intranet website | confirmed |
| 14 | Devices used at home | Mainly computers; phones and tablets just need to be usable | confirmed |
| 15 | Can the intranet be opened at home | No; students use the file sent to them at home | confirmed |
| 16 | Who uploads to the intranet website | The teacher in charge of the school network; we are not responsible | confirmed |
| 17 | History | Last 20 entries; click an item to put it back in the input box; "Clear history" button; still there after closing and reopening the browser | confirmed |
| 18 | Whether expressions with errors go into history | No, only problems that produced a result are recorded | confirmed (inferred, confirmed in playback) |
| 19 | Projection mode | One click enlarges text and buttons; click again to restore | confirmed |
| 20 | Delivery date | Before 2026-12-09 (before the start of next semester, about two months from now) | confirmed |
| 21 | Acceptance questions | 10 questions provided by the teacher | confirmed |
| 22 | Out-of-scope list | Account login, data collection, fractional roots, logarithms of trig functions, printing, other languages; nothing to add | confirmed |
| 23 | Computer room restore system | Installed; restarts wipe data; history is lost with it, and the teacher accepts this | confirmed |
| 24 | Real-machine trial in the computer room after delivery | The teacher will not test by checklist; after delivery they will try it themselves and give feedback | confirmed |
| 25 | Who receives delivery | Send to the teacher's email; the address is provided by the teacher once the file is ready; ask before sending | confirmed |
| 26 | Merge permission | Auto-merge after code checks and CI pass, without asking the teacher | confirmed |

## Inferred answers & sources

- **Home browsers** support the current versions of Chrome and Edge. Source: the teacher said "mainly use computers at home" and did not specify a browser; listed in playback and confirmed by the teacher.
- **Delivery date 2026-12-09.** Source: derived from the teacher's statement "about two months from now, the start of next semester"; listed in playback and confirmed by the teacher.
- **The whole interface is in Chinese.** Source: the teacher agreed to "not do other languages".
- **There is no prerequisite ticket, and no existing code to reuse.** Source: repository and Linear query results (see Verified current behaviour).
- **Multiplication and division both accept `* /` and `× ÷`.** Source: the teacher's acceptance questions are written with `*` and `/`; listed in playback and confirmed by the teacher.
