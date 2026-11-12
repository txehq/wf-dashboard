---
kind: brief
product: Magi Eval
feature: r-20261009-a9piql
updated: "2026-10-09"
---

# Brief: Offline Chinese calculator (for middle school computer labs)
**Date:** 2026-10-09 · **Interviewed:** school teacher (requirement proposer) · **By:** Claude Opus 5.5 (/lfg Stage 1)

## Problem & consumer

- **Who it's for:** Junior high students (grades 7 to 9) who open it in Chrome on the Windows 7 computers uniformly installed in the school computer room; teachers demonstrate it with a projector during class; students may also open it on their own computers at home.
- **Problem:** The computer room often loses its network connection, so the online calculator web pages students use now won't open, and they can't do calculations.
- **Why now:** It needs to be usable two months from now, when school starts.

## Done means

Deliver a calculator web page that meets each of the following. Each one is a behavior that will be demonstrated item by item during acceptance.

**Runtime environment**

1. It can be opened and used with the network completely disconnected, and the page does not request any network resources.
2. Display and calculation both work correctly on Chrome 109 (the last Chrome version that can be installed on Windows 7).
3. All interface text is in Chinese.
4. The same HTML file works when double-clicked and opened via `file://`, and also works when placed on the school intranet website and opened by URL; two versions are not needed.

**Operations**

5. Supports addition, subtraction, multiplication, division, parentheses, negative numbers, decimals, percent sign, exponentiation (`^`), and square root (`√`).
6. Order of operations follows junior high school math: parentheses first, then exponentiation, then multiplication and division, and finally addition and subtraction; the negative sign is applied after exponentiation, so `-2^2` gives `-4`.
7. Exact decimal calculation: `0.1+0.2` gives `0.3`.
8. Results keep at most ten decimal places, rounding the eleventh place: `1÷3` gives `0.3333333333`, `2÷3` gives `0.6666666667`.
9. Trailing zeros at the end of results are not displayed: `1÷4` gives `0.25`.
10. The percent sign always means "divide by 100": `50%` gives `0.5`, `200+10%` gives `200.1`.
11. `√` applies only to the number or the pair of parentheses immediately following it: `√9+16` gives `19`, `√(9+16)` gives `5`.
12. Omitting the multiplication sign is not supported: `2(3+4)` and `2√9` are both treated as errors (see item 17).

**Input**

13. Keyboard input and on-screen buttons both work fully; students can use only the keyboard or only the mouse.
14. On the keyboard, use `*` to enter multiplication and `/` to enter division, which are displayed on screen as `×` and `÷`; the `r` key enters `√`; the on-screen buttons also include `√`.
15. Press Enter or `=` (on the keyboard or on-screen button) to show the result.

**Error messages**

16. When an error occurs, show a Chinese message that students can understand, and mark the error position in the expression.
17. At least include these four kinds of messages:
    - Division by 0: "Cannot divide by 0"
    - Unmatched parentheses: "Parentheses are not paired"
    - Square root of a negative number (e.g. `√-4`): "Negative numbers cannot take square roots"
    - Omitted multiplication sign (e.g. `2(3+4)`, `2√9`): "Multiplication sign is missing here"

**History**

18. Saves the most recent 20 expressions and results.
19. After closing the browser and shutting down, when reopened the next day, the history is still there.
20. Click a history entry to put that expression back into the input box, so students can keep editing it or calculate it again.
21. There is a "Clear history" button that clears all history at once (the lab computers are shared by several students in turn).

**Projection**

22. There is a "Projection mode" that enlarges the font with one click so students in the back rows can read it; click again to restore.

**Deliverables**

23. One HTML file that can be copied to a USB drive and opened by double-clicking.
24. One intranet placement instructions document (in Chinese) for the teacher who manages the school's computers.

**Minimum evidence:** For each item, a screenshot or automated test result showing it passing on offline Chrome 109; every example for items 6–12, 17 has a corresponding automated test.

## Where it lives

- **Repository:** `txehq/wfe-r-20261009-a9piql` (GitHub, an existing repo, currently only has `README.md` and one initial commit).
- **Product:** Magi Eval; feature slug: `r-20261009-a9piql`.
- **Where it is used:** local files on school lab computers; school intranet websites; students' home computers.
- **Authoritative source:** this brief. There are no earlier tickets or spec documents.
- **Prerequisites:** None.
- **Follow-up work:** Putting the HTML file on the school intranet server, done by the teacher who manages the school's computers according to the placement instructions, is not part of this work.

## Verified current behaviour

- The repository `txehq/wfe-r-20261009-a9piql` has only one `README.md` whose content is `# wfe-r-20261009-a9piql`; its commit history has only `22a75e1 chore: initial commit`, with no reusable code, tests, or CI.
- The vault has no materials for this feature under `Project Magi Eval/`; searching Linear for "calculator" and "calculator" found no tickets related to this feature.

## Out of scope & constraints

**Not doing this time:**

- Trigonometric functions, logarithms
- Fractional results (such as showing `1/3`)
- Unit conversion
- Plotting function graphs
- Student account login
- Teachers viewing students' history records (history stays only on the student's own computer)
- Dedicated layout for phones
- English interface or any other language
- Notation that omits the multiplication sign (`2(3+4)`, `2√9`)
- Putting the file on the school intranet server (done by the teacher who manages the school's computers)

**Constraints:**

- Deadline: usable before the start of school in two months (before 2026-12-09).
- Must work fully offline: do not load any CDN, web fonts, or remote scripts; all dependencies are bundled into the same HTML file.
- Must be compatible with Chrome 109.
- Deliver only one HTML file, usable via both `file://` and `http(s)://` opening.

## Authority ceiling

**No need to ask first; you may do these yourself:**

- Create tickets in Linear
- In `txehq/wfe-r-20261009-a9piql`, create branches, write code, write tests, configure CI
- Open a PR; once the PR passes checks, merge it according to the repository's auto-merge rules
- Deliver the HTML file that can be copied to a USB drive and the intranet placement instructions

**Limit:** until the PR is merged and the files are delivered.

**Must ask first:**

- Changing the feature scope listed in this brief
- Any operation that will be placed on school servers or student computers

## Open questions

- How to do automated verification on Chrome 109 (for example, a pinned-version Chromium and end-to-end tests under offline conditions).
- Which library to use for exact decimal calculation, and how to implement rounding at the eleventh digit.
- Where history is stored under `file://` and intranet `http(s)://` respectively, and whether the behavior of `localStorage` under `file://` on Chrome 109 is reliable.
- How to bundle all dependencies into a single HTML file that can be used offline.
- Display of extremely large or small results (e.g. `2^100`, `0.00000000001`).

## Decision ledger

| # | Question | Conclusion | Status |
|---|---|---|---|
| 1 | How to put it on the lab computers | Both a single HTML file opened by double-click and an intranet website; one file used both ways | confirmed (approach delegated; default: one file, two ways to use it; user agreed) |
| 2 | Input method | Both keyboard and on-screen buttons | confirmed |
| 3 | Projection mode | Yes, one click to enlarge the font size | confirmed |
| 4 | Number of history entries | Latest 20 entries | confirmed |
| 5 | History saving | Still there after shutting down and reopening | confirmed |
| 6 | Clear history | Need a "Clear history" button | confirmed |
| 7 | Clicking a history entry | Put the expression back into the input box | confirmed |
| 8 | `0.1+0.2` | Shows `0.3` | confirmed |
| 9 | Decimal places | Up to ten places, round at the eleventh place | confirmed |
| 10 | `-2^2` | `-4` | confirmed |
| 11 | Omitted multiplication sign | Not supported; shows "Multiplication sign missing here" | confirmed |
| 12 | Percent sign | Always divides by 100; `200+10%` gives `200.1` | delegated (default stated, user agreed) |
| 13 | Scope of `√` | Applies only to the number or parenthesis immediately following | delegated (default stated, user agreed) |
| 14 | Error messages | Chinese-language messages with the position marked; the four message texts are in Done means item 17 | delegated (default stated, user agreed) |
| 15 | Trailing 0 | Not shown | delegated (default stated, user agreed) |
| 16 | Keyboard mapping | `*` `/` input, shows `×` `÷`; `r` inputs `√`; Enter or `=` gives the result | delegated (default stated, user agreed) |
| 17 | Out-of-scope items | See the Out of scope list | confirmed |
| 18 | Permission ceiling | Can go as far as PR auto-merge and delivering files; placing it on the intranet is done by the school teachers | confirmed |
| 19 | Delivery deadline | Before school starts in two months | confirmed |

## Inferred answers & sources

- **Chrome 109 is the last Chrome version installable on Windows 7:** Google's support for Windows 7 ended with Chrome 109; this matches the user's "Chrome 109 in the lab".
- **Deadline converted to 2026-12-09:** interview date 2026-10-09 plus two months.
- **Nothing in the repository is reusable:** from checking the repository (see Verified current behaviour).
- **Acceptance needs an offline test:** from the user's "must work fully offline".
- **All dependencies bundled into one file:** from the combination of the two requirements "just copy it via USB drive and double-click to open" and "fully offline".
