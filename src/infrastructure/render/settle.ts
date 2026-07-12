import type { PlaywrightPage } from "./playwright-types.ts";

export interface SettleOptions {
  /** Hard cap on the settle (ms). */
  capMs: number;
  /** Minimum time to keep watching even if the page looks stable — a page that
   *  appears settled at 200ms may still inject content at 1.5s (setTimeout /
   *  hydration). Must exceed the latest "quiet-then-change" delay you want to catch. */
  minDwellMs: number;
  /** How long the content length must hold steady before trusting it (ms). */
  stableMs: number;
  /** Poll interval (ms). */
  intervalMs?: number;
}

/**
 * After `networkidle`, watch the rendered content for further changes. `networkidle`
 * fires the instant there's no network activity — so content loaded via a plain
 * `setTimeout`/hydration callback (no XHR, no fetch) is missed: the callback hasn't
 * run yet when `page.content()` is captured (the cerebralvalley.ai regression).
 *
 * Polls `page.content().length` and only trusts stability once it has held for
 * `stableMs` AND `minDwellMs` has elapsed, capped at `capMs`. A page that keeps
 * mutating resets the stability timer; a genuinely-settled page exits as soon as
 * both thresholds pass. Never throws — best-effort, capped, non-fatal.
 *
 * `page.content()` (not `evaluate`) keeps this within the existing PlaywrightPage
 * surface; serialization cost is bounded by the page size and the ~capMs/interval
 * poll count.
 */
export async function waitForBodyStable(page: PlaywrightPage, opts: SettleOptions): Promise<void> {
  const interval = opts.intervalMs ?? 150;
  const start = Date.now();
  let lastLen = -1;
  let stableSince = start;

  for (;;) {
    const now = Date.now();
    if (now - start >= opts.capMs) return;

    let len = 0;
    try {
      len = (await page.content()).length;
    } catch {
      len = lastLen < 0 ? 0 : lastLen;
    }
    const checkedAt = Date.now();
    if (len !== lastLen) {
      lastLen = len;
      stableSince = checkedAt;
    }
    if (checkedAt - start >= opts.minDwellMs && checkedAt - stableSince >= opts.stableMs) return;

    await page.waitForTimeout(interval);
  }
}

/** The browser's LIVE DOM text length (document.body.innerText.length) — captures shadow-DOM /
 *  computed-visible text that `page.content()` (serialized HTML) cannot carry (shadow roots aren't
 *  serialized), so it splits a page whose DOM HAS text the extractor dropped (shadow-DOM / parser
 *  gap) from a wall/stub (#154 renderDiagnostics). Best-effort: undefined if the page is gone or
 *  `evaluate` is unsupported (test mocks). */
export async function liveDomTextLength(page: PlaywrightPage): Promise<number | undefined> {
  try {
    if (!page.evaluate) return undefined;
    // document.body.innerText does NOT traverse open shadow roots (verified empirically: a page
    // whose visible content sits in an open shadow root yields innerText "" — codex P2). Walk open
    // shadow roots for their text so a shadow-DOM render_empty still surfaces a high domTextLength
    // (→ extraction-gap) instead of a misleading 0 (→ empty-dom). Closed roots are inaccessible.
    return (await page.evaluate((): number => {
      let len = (document.body?.innerText ?? "").length;
      const stack: Element[] = Array.from(document.body?.querySelectorAll("*") ?? []);
      while (stack.length) {
        const el = stack.pop() as Element;
        const sr = el.shadowRoot;
        if (sr) {
          len += (sr.textContent ?? "").length;
          stack.push(...Array.from(sr.querySelectorAll("*")));
        }
      }
      return len;
    })) ?? 0;
  } catch {
    return undefined; // page gone / evaluate failed — best-effort
  }
}
