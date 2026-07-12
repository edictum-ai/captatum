# #157 — bulk: hosted `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` env knob (flavor-aware wall, #148 follow-up)

**Tier:** T2 (directed-DoS / egress-deadline control surface exposed via operator config).
**Kind:** Follow-up to #148 (the bulk global-wall lowering). Adds one **hosted** operator env knob
and documents its fail-closed validation semantics. Supersedes nothing in the contract.
**Spec / contract references:** `docs/contracts.md` §"Tool: `captatum_bulk`" → BulkGuard table +
"Operator config" note; `docs/threat-model.md` §"Bulk fan-out" → Browser-time/OOM row.
**Critique:** `docs/specs/157-bulk-wall-env-knob.critique.md` — 0 blocker / 0 high / 5 medium /
5 low / 3 nit; all folded into the decisions below.

---

## 1. Problem

#148 lowered the bulk global-deadline wall `maxGlobalWallMs` from 180 s → **55 s** for hosted prod
relief (MCP clients — chatgpt.com's hosted connector, the Claude Code SDK — hard-close a tool call
at ~60 s, so a taller wall assembles a structured partial the client never receives; the prod audit
showed 74–137 s bulks finishing orphaned → 124 `context canceled` drops).

The orphaning rationale is **hosted-only**: the local-binary stdio flavor has no competing client
timeout, so a longer wall is harmless there. #148's merge (`2596f9b`) already did the flavor split
**inside the domain + local wiring**:

- `src/domain/bulk-policy.ts` — `BULK_GUARD_DEFAULTS.maxGlobalWallMs = 55_000` (hosted default) and
  `BULK_GUARD_CEILINGS.maxGlobalWallMs = 180_000` (the ceiling was restored — NOT lowered to 55 s).
- `src/domain/bulk-config.ts:82-84` — `resolveBulkGuard` clamps an operator `maxGlobalWallMs`
  against `BULK_GUARD_CEILINGS` (so an operator may set the wall anywhere in `[1 ms, 180 s]`),
  **not** against `DEFAULTS`. Absent → the 55 s hosted default.
- `src/interfaces/mcp/local-server.ts:86` — the local-binary flavor passes
  `maxGlobalWallMs: BULK_GUARD_CEILINGS.maxGlobalWallMs` (180 s), so local keeps its pre-#148 wall.

**What is NOT done** (the remaining scope, per the issue comment — the local-binary part is
resolved): the **hosted** flavor has **no runtime lever** to raise the 55 s default. The hosted
bootstrap (`src/server.ts:79-95`) does not pass `maxGlobalWallMs` in the operator config, and
`src/config.ts` wires `CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT` / `CAPTATUM_BULK_CRAWL_DELAY_MS` /
`CAPTATUM_BULK_MAX_CONCURRENCY` but **not** `maxGlobalWallMs`. So a hosted deployment that later
learns its real client timeout is higher (e.g. post-deploy telemetry shows claude.ai tolerates
>60 s) has **no way** to recapture the 55–N s bulks currently truncated to partials — only a code
change + redeploy.

## 2. Scope

Wire one **hosted** operator env knob — `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` — through `config.ts`
into the hosted bulk operator config, so a hosted deployment can raise the 55 s default toward the
180 s ceiling without a code change.

**Hosted-only (decision, per critique row 3).** The local-binary flavor is **unchanged** — it keeps
its hardcoded `BULK_GUARD_CEILINGS.maxGlobalWallMs` (180 s). The critique flagged the "consistency
completion" (have local also read the env) as a behavior change with a narrowing footgun: an
operator who copies a hosted runbook line (`CAPTATUM_BULK_MAX_GLOBAL_WALL_MS=55000`) into a local
env would silently narrow the local wall 180 s→55 s. The domain already gives local its 180 s wall,
so an env the local operator has no reason to set adds a footgun for no local benefit. Dropped.
(Local operators who want to exercise the deadline path already do so directly in tests via
`operator: { maxGlobalWallMs: 1 }`.)

**Out of scope (flagged, not fixed here — §6):** the other bulk env knobs
(`CAPTATUM_BULK_MAX_CONCURRENCY`, `CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT`,
`CAPTATUM_BULK_CRAWL_DELAY_MS`, `CAPTATUM_GLOBAL_FETCH_CONCURRENCY`, the two quota knobs) all use
`envPositiveInteger`, which **silently falls back to the default on a malformed value**. Migrating
those to strict boot-reject is a separate hardening pass — excluded to avoid scope creep and
boot-breakage of deployments with stray env vars.

## 3. Contract change

`docs/contracts.md` §BulkGuard — the `maxGlobalWallMs` row already documents the 55 s hosted
default / 180 s ceiling / flavor split; this change names the env lever. A new "**Operator config
(`CAPTATUM_BULK_*`)**" note states that `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` is the **hosted** runtime
lever to raise the wall in `[1 ms, 180 s]`; **unset/empty → the 55 s hosted default**; the
**local-binary flavor is unaffected** (keeps the 180 s ceiling regardless — it does not read this
env). A malformed / non-integer / non-positive / above-ceiling value is a **boot rejection**, not a
silent default (an operator who fat-fingers the value must learn it at boot, not discover a
still-truncated bulk in prod — there is no per-call receipt that discloses an operator clamp, so
boot is the only operator-facing signal).

`docs/threat-model.md` §Bulk fan-out → Browser-time/OOM row — append the env-knob existence, the
fail-closed validation, AND the **trust boundary**: this env is operator/deploy-time (k8s
ConfigMap/Secret), not request input — a remote MCP caller cannot set `process.env`, so
boot-rejection is an operator foot-gun (immediately diagnosable from the named error, immediately
fixable by correcting the env), not a remotely-exploitable DoS.

## 4. Design

### 4.1 `src/config.ts` — new accessor + strict validator

Add `config.bulk.maxGlobalWallMs(): number | undefined`:

- **unset / empty / whitespace-only → `undefined`** (the hosted path then omits the field and the
  domain applies the 55 s default). Empty-string-equals-unset is the fail-closed reading of "absent
  operator config."
- **a clean decimal integer of milliseconds in `[1, ceiling]` → that number.** The ceiling is read
  from `BULK_GUARD_CEILINGS.maxGlobalWallMs` (single-sourced from the domain — no magic `180_000`
  duplicated in config).
- **malformed → throw at boot** (a clear error naming the env var + the valid range). The check is
  `.trim()` first (so surrounding whitespace / a trailing heredoc newline on a valid value is
  accepted — the #1 real ConfigMap contamination), then the strict regex `^[0-9]+$` (decimal digits
  only — rejects non-numeric, hex `0x10`, scientific `1e5`, floats, signs, internal whitespace,
  unicode digits), then a `Number()` parse, then `>= 1` (rejects `0`/`000`) and `<= ceiling`
  (rejects above-ceiling). The regex accepts leading zeros (`055000`→55000) — alignment padding an
  operator might write — at no security cost (still decimal-only, still bounded).

A focused private helper `envBulkWallMs(name)` implements this. It is **not** generalized into a
shared `envStrictIntInRange` yet — least machinery; generalize when a second knob migrates (§6).
`config.ts` already imports from `./domain/policy.ts`, so importing `BULK_GUARD_CEILINGS` from
`./domain/bulk-policy.ts` is an established layering pattern (config reads domain constants as the
source of truth for bounds).

### 4.2 `src/server.ts` — hosted wiring (validate only when bulk is enabled)

The hosted bulk operator literal already sits inside the `config.bulk.enabled() ? … : undefined`
ternary (`server.ts:79-95`). The accessor call goes **inside the true branch**, alongside the other
operator fields — so a malformed `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` throws only when bulk is
actually enabled. A bulk-**disabled** hosted server (`CAPTATUM_BULK_ENABLED=false`) does not
validate (and cannot boot-reject on) a knob it never uses — consistent with §6's
avoid-boot-breakage stance. (The accessor is read once, for readability, next to the other fields;
there is no second call site.)

```ts
const bulk = config.bulk.enabled()
  ? createCaptatumBulkUseCase({
    executor: captatum,
    adapters: createAdapterRegistry(),
    clock,
    operator: {
      maxPerHostInflight: config.bulk.maxPerHostInflight(),
      crawlDelayMs: config.bulk.crawlDelayMs(),
      maxConcurrency: config.bulk.maxConcurrency(),
      // #157: hosted runtime lever to raise the 55 s default toward the 180 s ceiling. Undefined
      // when CAPTATUM_BULK_MAX_GLOBAL_WALL_MS is unset → the domain applies the 55 s hosted default.
      // The domain clamps to the ceiling as defense-in-depth (config already rejected above-ceiling).
      ...(config.bulk.maxGlobalWallMs() !== undefined
        ? { maxGlobalWallMs: config.bulk.maxGlobalWallMs() }
        : {}),
    },
    quota: new InMemoryBulkQuotaPort({ ... }),
  })
  : undefined;
```

(The local-binary flavor — `local-server.ts:86` — is **unchanged**: it keeps
`maxGlobalWallMs: BULK_GUARD_CEILINGS.maxGlobalWallMs` and does not read the env. §2.)

### 4.3 Domain — one stale-docstring fix (NOT "no domain edit")

The spec's first draft said "domain unchanged." That was wrong (critique row 2): the docstring on
the exact field #157 wires is stale. `src/domain/bulk-config.ts:20-23` documents
`BulkOperatorConfig.maxGlobalWallMs` as *"Optional operator tightening … (lowering only — clamped
DOWN to the default … never lengthen it past the hard server cap)"* — that is the **pre-#148**
semantics. `resolveBulkGuard` at `:82-84` clamps to `BULK_GUARD_CEILINGS` (180 s), **not** the 55 s
default, and an operator may **raise** from 55 s toward 180 s — precisely the path #157 exposes via
env. Shipping a raise-lever while the field doc says "never lengthen" is a direct contradiction.
(The sibling fields `maxPerHostInBulk`/`maxRenderedSeeds` at `:86-92` still clamp down to default,
so their "lowering only" docs stay accurate — only `maxGlobalWallMs` is stale.) Rewrite the `:20-23`
docstring to mirror the `:78-81` comment ("operator may set the wall anywhere in [1 ms, CEILING];
absent → the 55 s hosted default; the local-binary flavor passes the ceiling"). No domain
**behavior** edit — the clamp at `:82-84` is already correct.

**Parser-differential reconciliation (critique row 9).** Config will **throw** on above-ceiling
while the domain `resolveBulkGuard` will silently **clamp** the same above-ceiling value to 180000
(`bulk-config.ts:82-84`, pinned by `test/bulk-policy.test.ts:183`). Two components parsing the same
input differently is normally its own vulnerability class — this divergence is safe because the
**bound is identical** (both source `BULK_GUARD_CEILINGS`): config is the boundary that validates +
throws; the domain is the interior fail-safe that clamps for any caller that bypasses config (a new
flavor, a CLI flag, a test, `local-server.ts` passing the exact ceiling). The non-frozen domain test
pins that silent-clamp for those non-config callers.

## 5. Security analysis

- **The ceiling is the hard cap (bounded DoS surface).** `BULK_GUARD_CEILINGS.maxGlobalWallMs =
  180_000` is the directed-DoS / egress-deadline bound. The env knob may move the *effective* wall
  anywhere in `[1 ms, ceiling]`; it can **never** raise the ceiling itself (config boot-rejects
  above-ceiling; the domain clamps as defense-in-depth). The attack surface does not grow.
- **Trust boundary (critique row 5).** `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` is an operator/deploy-time
  env var (k8s ConfigMap/Secret), **not request input** — a remote MCP caller has no path to
  `process.env`. So boot-rejection is an operator foot-gun (immediately diagnosable from the named
  error, immediately fixable by correcting the env), not a remotely-exploitable DoS.
- **Fail-closed on untrusted config.** Empty/unset → the restrictive hosted default (55 s), not a
  widened wall. Malformed/out-of-range → boot rejection, never `value || default` on a security
  selector. An operator can never accidentally widen past the ceiling via a malformed value.
- **Why boot-reject over silent-clamp for operator config (critique row 12).** For *caller* cost
  overrides the domain clamps + discloses in the per-call receipt (the caller learns). For
  *operator* config there is no per-call disclosure channel to the operator — a silent clamp is
  invisible. Boot rejection is the only operator-facing signal. We considered **clamp-to-default +
  a loud boot warning** (availability-preserving — no `CrashLoopBackOff` on an operator typo like
  `55s`) and **rejected it**: boot-reject is the strict reading of the fail-closed rule, the error
  names the env + range so the fix is immediate (seconds), the knob is operator-only so the blast
  radius is self-inflicted, and — most decisively — the operator wrote a *value*, not "default"; if
  they wrote `120000s` (intending 120 s) and we clamp to the 55 s default, their intent is silently
  replaced with its opposite. Refusing to start forces them to fix the typo, after which they get
  exactly what they intended. The asymmetry vs the silent-clamp sibling `envPositiveInteger` knobs
  is deliberate: **this is the DoS wall; they are not.**
- **`Number()` shape hardening.** A security selector must not accept `0x10` / `1e5` / `12.0` as a
  value the operator did not literally type. The strict decimal-integer regex makes the accepted set
  exactly what an operator would write (plus leading-zero padding), then the bound check enforces
  the ceiling and the floor.
- **No SSRF / egress-path change.** The wall is a deadline, not an egress route; it fires via the
  existing `AbortController` in `execute()`. Raising it does not add egress — it lets already-bounded
  work run longer, still under `maxGlobalEgressBytes`, the per-host caps, and `LimitingFetcher`.

## 6. Siblings (swept, flagged — NOT fixed in this PR)

The sibling env knobs use `envPositiveInteger` (silent fallback to the default on malformed). Their
**fail directions differ** (critique row 6 corrected the first draft):

- **`CAPTATUM_BULK_MAX_CONCURRENCY`** — `resolveBulkGuard` (`bulk-config.ts:53-55`) does
  `Math.min(DEFAULTS.maxConcurrency=4, op)` → **narrowing-only** (an operator may set 1–4, never
  wider). `envPositiveInteger`'s malformed fallback returns the default **4** (the *widest*). So an
  operator who means to **narrow** (e.g. to 2) and fat-fingers gets **4 = fail-wide** on a narrows
  intent. (The first draft inverted this — corrected.)
- **`CAPTATUM_GLOBAL_FETCH_CONCURRENCY`** — the only **true widening** knob (passed straight to
  `LimitingFetcher` at `server.ts:67`, no clamp); malformed → default 24.
- `CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT`, `CAPTATUM_BULK_CRAWL_DELAY_MS`, the two quota knobs —
  raising/tightening knobs; malformed → safe default.

All share the confused-operator shape (a fat-fingered value is silently replaced). Migrating them
to strict boot-reject is recorded here as a **separate hardening pass** — excluded from #157 to
avoid scope creep and boot-breakage. (When done, `envBulkWallMs` generalizes to a shared
`envStrictIntInRange`.) `src/dev/bulk-probe.ts` (a third `createCaptatumBulkUseCase` caller, dev-only)
is **out of scope**: it does not read `config.ts` at all, hardcodes its operator literals, keeps the
55 s default, and is unaffected by #157 (named here so it is not a review-round discovery — critique
row 7).

Other sibling axes verified clean (no change): the bulk budget tracker
(`src/application/use-cases/bulk-budget.ts`) consumes `guard.maxGlobalWallMs` opaquely; the
per-host caps and admission are untouched; the wall-firing path (`captatum-bulk.ts:83`) is
unchanged.

## 7. Tests

**Domain clamp — already pinned (non-frozen),** `test/bulk-policy.test.ts:165-191`: hosted default
55 s; ceiling 180 s; operator may set `[1 ms, ceiling]`; above-ceiling clamps down; absent → default;
floor 1 ms. These are the regression guards for verify (a) "hosted default unchanged when env unset"
and the parser-differential silent-clamp for non-config callers.

**New non-frozen `test/bulk-config-env.test.ts`** — the config accessor (the new security-critical
code). Cases:
- unset / empty / whitespace-only → `undefined`.
- valid in-range: `55000`, `180000` (ceiling boundary — must PASS), `1` (floor — must PASS),
  `055000` (leading-zero padding → 55000), `  55000\n` / `"\t55000\t"` (surrounding whitespace →
  trim works → 55000).
- malformed → throws, and the error names the env var + the valid range: non-numeric (`abc`);
  internal whitespace (`55 000`, `55\t000`); float (`55000.5`); hex (`0x10`); scientific (`1e5`);
  signed (`+55000`, `-5000`); unicode digits (`٥٥٠٠٠`); zero / all-zeros (`0`, `000`); above-ceiling
  (`180001`); huge (`999999999999999999999999`).
- (Process-env hygiene: save/restore `process.env[name]` around each case; tests are
  order-independent. The accessor is imported directly from `src/config.ts`.)

**Wiring — verified by typecheck + the real bulk run** (§8). `server.ts` is a hosted-only bootstrap
that opens a listener (not unit-testable without starting the network); the operator field flows
through `resolveBulkGuard`, already exhaustively tested. The **domain docstring fix** (§4.3) has no
test surface (it is a comment) — verified by reading.

### Frozen-suite decision: **no new frozen suite** (recorded, deliberate — reworded per critique row 10)

The ceiling (the actual DoS bound) is pinned by the non-frozen domain test
(`bulk-policy.test.ts:165-191`); the env validation (boot-reject-on-malformed) is pinned by the new
non-frozen config test. Boot-reject IS a contract semantic (promised in `contracts.md` prose), but
its freeze-worthy *direction* — fail-closed on malformed — is already pinned by those non-frozen
tests, the repo has **no precedent** of freezing operator-config validation (the frozen suites
146/151/152/153 are all classification-outcome contracts at trust boundaries, not operator knobs),
and the T2 process calls for "proportionate depth." The regex/range mechanics are the impl detail.
Authoring a frozen suite + separate PR + manifest hash for a config knob would be disproportionate.
#148 (the same control surface) shipped the underlying contract without a frozen suite — same
precedent applies. If review disagrees, a frozen suite can land as a follow-up without reworking the
runtime change.

## 8. Verify bar

- **(a) Hosted default unchanged when env unset** — `config.bulk.maxGlobalWallMs()` returns
  `undefined`; `server.ts` omits the field; `resolveBulkGuard` → 55 s. (Pinned by
  `bulk-policy.test.ts:165-191` + the new config test's unset case.)
- **(b) A hosted deployment can raise via env up to the ceiling** — set
  `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` to a value in `(55000, 180000]`; the effective wall is that
  value. (Pinned by the new config test + the domain test at `:183-184`.)
- **(c) Above-ceiling / malformed is rejected fail-closed** — boot throws; no widening past the
  ceiling is possible. (Pinned by the new config test's throw cases.)
- **Real bulk run.** `pnpm run smoke` is **single-fetch regression only** — it never calls
  `captatum_bulk` (`smoke-stdio.ts` calls only the `captatum` tool; `smoke-stdio-process.ts` does
  only `tools/list`; `smoke-test.ts` drives `captatum.execute` directly) — so it does NOT exercise
  this change (critique row 4). The real-bulk verify is a **manual** step: the wall IS readable from
  every bulk receipt at `result.guard.maxGlobalWallMs` (verified: `bulk-result.ts:76` +
  `bulk-assemble.ts:62` + `captatum-bulk.ts:91`). Run a tiny `captatum_bulk` via the local bridge
  (or `src/dev/bulk-probe.ts` — note it does not read the env, §6) with the env unset and read the
  wall from the receipt; set the env to a valid value, confirm the wall tracks it; set a malformed
  value, confirm boot rejection.
- **Gates** — `pnpm run check` (syntax + line-limit + typecheck), `pnpm test`, `pnpm run smoke`
  (single-fetch regression) all green; `.process-guard-exempt` is gone so `process-guard`
  (freeze-hash · mixed-diff · stage-artifact) must stay green — no edit under `test/acceptance/**`.

## 9. Process

Contract-first (this spec + `contracts.md` + `threat-model.md`) → independent critique
(`157-*.critique.md`, 3-lens Workflow, done) → decisions resolved above → implement → independent
review (different model family) → real-input verify → PR off `origin/main`, conventional subject
(`feat(bulk):` — a new operator knob, user-visible), `Spec: docs/contracts.md` trailer → codex
review → **wait for a review object on the exact head commit, not a 👀/👍 reaction**
([[captatum-merge-gate-policy]]); paginate the thread. No Claude co-author trailer
([[no-claude-commits-trailer]]).
