# AGENTS.md

Thin front door for AI coding agents (Codex and others that read `AGENTS.md`).
The canonical house rules, architecture, and "when you start work" checklist live
in [`CLAUDE.md`](CLAUDE.md) — read it. The contract lives in
[`docs/contracts.md`](docs/contracts.md) and wins over code and inference.

## This repo is governed (Engineering OS)

tier: S
Reference: https://github.com/acartag7/engineering-os

Non-negotiables — CI enforces these; this block just saves you a red build:

- Acceptance tests under test/acceptance/ are FROZEN. Editing any of them turns CI
  red (hash check). Turn finished phases on via test/acceptance/phases.json only.
  If a test looks wrong: STOP and report. That's a contract change, not a patch.
  (No acceptance suite exists yet — the repo carries a `.process-guard-exempt`
  marker until the first frozen suite lands.)
- Contract first: docs/contracts.md wins over the code and over your inference.
  Never implement while the contract has open decisions or points at files outside
  this repo. (This reinforces the existing contract-first house rule in CLAUDE.md.)
- Trust-boundary decisions are allowlists, never blocklists. Empty config counts
  as missing config: fail closed. Type-check every externally-sourced value before
  using it. Malformed input fails closed, never best-effort.
- Build the least machinery the contract asks for. No unrequested parsers,
  validators, or abstractions. If the simple approach feels insufficient, stop and
  ask — don't build.
- After fixing any defect, sweep sibling code paths BEFORE re-requesting review.
  Partial fixes are the top review-round multiplier.
- Never weaken a check to get green. Never push to protected branches. PRs carry a
  `Spec: <path>` trailer and conventional commit subjects.
- Review verifies; it never discovers. If review is teaching us what the spec
  should have said, say so — that's a process failure to record, not a grind to
  endure.
