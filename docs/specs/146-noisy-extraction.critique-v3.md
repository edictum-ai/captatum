# Critique v3 (focused, (C)-only): #146

Independent focused re-critique (single harness, correctness + REDOS + sibling lens) of the v3 spec after scope was narrowed to the (C) `stripHtmlTags` quote-aware fix + the `charset.ts` same-class sibling. Re-traced every case by hand as a real interpreter (not trusting the spec's own table) plus a battery of new edge cases.

## Verdict

**READY** (for the (C) `stripHtmlTags` core). No content-loss, no markup-leak vs current on any input constructible.

Key invariant proved: **on the malformed path v3 computes `legacy = html.indexOf(">", start+1)` — exactly current's `end` — and advances `cursor = legacy+1` identically, so the malformed path is provably byte-identical to current.** v3 can only diverge on the well-formed path, where divergence strips a *longer* span whose extra region is in-quote attribute value (markup, not content). v3 is never worse than current on any input. The v2 `quote !== null` gate is removed in v3 (unconditional legacy recovery on `end === -1`), which resolves v2 blocker #1 (terminated-quote-no-close leak) and the content-loss variant.

## Case trace (v3 output | current output | verdict)

| case | v3 | current | |
|---|---|---|---|
| `<div x-init="…if(a>b)…">REAL PROSE` | `REAL PROSE` | leaks JS | FIXED |
| `<a title="foo>bar">REAL</a>` | `REAL` | leaks `bar">` | FIXED |
| `<a title="foo>bar" REAL</a>` (v2 content-loss) | `bar" REAL` | `bar" REAL` | == current (REAL preserved; breaks at unquoted `<` → legacy) |
| `<a x="abc>REAL CONTENT</a>` (v1 defect 1) | `REAL CONTENT` | `REAL CONTENT` | == current |
| `<a x="abc>REAL CONTENT` (v1 defect 2) | `REAL CONTENT` | `REAL CONTENT` | == current, no markup leak |
| lone `<`, `<b>text`, `<b>` EOF, `<>`, `<div<span>` | == current | — | == current |
| `<div data-x="a'b>c'">x</div>`, `<div data-x='a">b'>x</div>` | `x` | leaks | FIXED |

## New edge cases (none v3 gets wrong)

`title="a>">x` → FIXED; `<a x=">" y="z">` (multi-attr) → FIXED; `<a x="<">` (`<` inside open quote — correctly NOT a tag boundary, passes) → == current; `<a x="">y` (empty quote) → == current; `<a title="a>b">X<b title="c>d">Y` (multiple) → `X Y` FIXED; deeply alternating quotes → FIXED; `<a title="x>"><b>` (quoted `>` before the `<` break) → == current. The in-quote `<` correctness check (the `<` break is in the non-quote `else` branch) is the critical one and passes.

## REDOS / linearity

Linear, O(n), ≤~2× per char. Text between tags 1× (outer `indexOf("<")`); chars in a well-formed tag 1× (inner loop); chars in a malformed tag ≤2× (inner loop + the legacy `indexOf(">")` rescan of `[start+1, legacy]`). Worst case (one open-quote run to EOF) = 2N, well under `LIN_RATIO=40` / `MULTI_CEILING_MS`. No quadratic. (Docstring must say "bounded ≤~2× on the malformed tail", NOT "every char scanned once / no rescans" — the latter is false on the malformed path.)

## charset.ts

`prescanMetaCharset` L35 `lower.indexOf(">", at)` is the only quote-blind spot (the `<meta` finder, boundary check, `stripHtmlCommentsAscii`, `parseTagAttrs` are quote-aware/quote-free). Replacing L35 with `findTagEnd` is correct. **Sentinel pin:** use `if (tagEnd >= lower.length && lower[lower.length-1] !== ">") return undefined;` — NOT a naive `tagEnd >= lower.length`, which would mis-classify a well-formed meta ending at EOF / the 1024-byte window edge as unterminated → charset undetected → mojibake (the exact bug, reintroduced at a boundary). Importing `findTagEnd` from `extract/html.ts` into `http/charset.ts` is layering-acceptable (both infrastructure, no cycle).

## Residuals (non-blocking)

1. (charset sibling) lock the char-check sentinel above before coding — one-line decision, recorded in the spec v3 charset section.
2. (cosmetic) adopt the docstring reword — recorded in the spec v3 REDOS note.

No blockers. (C) `stripHtmlTags` is READY to code as written in spec v3 (L40-62); the malformed-fallback design (unconditional legacy on `end===-1` + unquoted-`<` break) resolves both prior critiques' defects with zero regression vs current on every constructible malformed shape.
