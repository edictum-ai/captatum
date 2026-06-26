# Captatum docs

| Doc | What it is |
| --- | --- |
| [contracts.md](./contracts.md) | **The spec** — tool I/O, ports, provenance, OAuth, errors. Update *before* changing any tool/port/schema/error shape. |
| [threat-model.md](./threat-model.md) | Security reasoning — SSRF, the browser sandbox, OAuth, required controls. Update on any egress/browser/auth change. |
| [dependency-ledger.md](./dependency-ledger.md) | Dependency pins + supply-chain rationale (15-day `minimumReleaseAge`). |
| [architecture.md](./architecture.md) | Adaptive-tier architecture and the Transform stage. |
| [extraction.md](./extraction.md) | Raw-HTML structured extraction (JSON-LD / OG / meta / app-state, shell-gate). |
| [deploy.md](./deploy.md) | Notes on the production ECS/Fargate topology. For self-hosting, see [`../deploy/README.md`](../deploy/README.md). |
| [brand/](./brand/) | The Captatum mark (eye/lens `(·)`, monochrome + Capture Violet variants). |

Scratch / session notes (not canonical): `handoff-session-fixes.md`, `test-urls.md`.

## Brand

- **Mark:** the eye/lens `(·)` — two curved lids + a center dot (the captured unit
  of evidence). [`brand/captatum-mark.svg`](./brand/captatum-mark.svg) is the
  canonical monochrome (`currentColor`) version; [`captatum-mark-violet.svg`](./brand/captatum-mark-violet.svg)
  is the Capture Violet (`#7C5CFC`) variant for light surfaces.
- **Accent:** Capture Violet `#7C5CFC` (bright `#9B7CF6` on dark).
- **Voice:** sceptical, receipted — never takes a page at face value; states what
  was tried and how the result was produced.
