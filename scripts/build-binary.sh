#!/usr/bin/env bash
# Compile the self-contained local-binary flavor of captatum.
#
# The local flavor is the stdio MCP bridge (src/interfaces/mcp/stdio-bridge.ts)
# compiled into one executable with `bun build --compile`. Bun is an EXTERNAL
# tool, not an npm dependency, so this script never adds a package. It also never
# pretends to succeed: it fails loudly when Bun is missing, when the compile
# fails, or when the produced binary does not actually start (a startup self-check).
#
# Known packaging blocker on this repo's deps (see docs/architecture.md):
#   - Playwright's bundled core statically references optional `chromium-bidi`
#     paths Bun cannot resolve. Tier-3 render is a lazy/optional `import("playwright")`
#     (gated by allowRender, default false), so it is marked --external here.
#   - `wreq-js` (the Tier-1 egress primitive) loads a native `.node` prebuilt via a
#     relative require that `bun --compile` does not embed, so the binary aborts at
#     startup with "Failed to load native module". Until wreq-js native assets can
#     be embedded/shipped alongside the binary, the self-check below fails on
#     purpose and no broken artifact is left behind. The stdio bridge still runs
#     under the pinned Node 24 toolchain via the stdio-safe command
#     `node --no-warnings src/interfaces/mcp/stdio-bridge.ts`.
set -uo pipefail

ENTRY="src/interfaces/mcp/stdio-bridge.ts"
OUT="dist/captatum"
# Tier-3 render deps are lazy/optional; keep them external so the compile reaches
# the real self-containment check rather than a spurious bundler resolve error.
EXTERNALS=(--external playwright --external playwright-core --external chromium-bidi)

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOF
error: \`bun\` is required to compile the self-contained local binary, but it is
not installed on this machine. The stdio bridge still runs under Node via the
stdio-safe command \`node --no-warnings ${ENTRY}\`; only the single-file binary
needs Bun.

Install Bun (https://bun.sh) and run, where Bun is available:

  bun build ${ENTRY} ${EXTERNALS[*]} --compile --outfile ${OUT}

See docs/architecture.md ("Self-contained local binary") for the wreq-js native
prebuilt caveat and the lazy Playwright import.
EOF
  exit 1
fi

mkdir -p dist
echo "Compiling ${ENTRY} -> ${OUT} with bun $(bun --version)"
bun build "${ENTRY}" "${EXTERNALS[@]}" --compile --outfile "${OUT}"
status=$?

if [ "${status}" -ne 0 ]; then
  echo "error: bun --compile failed (exit ${status}); no binary was produced." >&2
  echo "This is a packaging blocker, not a passing build. See docs/architecture.md." >&2
  exit "${status}"
fi

if [ ! -e "${OUT}" ]; then
  echo "error: bun reported success but ${OUT} is missing; treating as failure." >&2
  exit 1
fi

# Startup self-check: a self-contained binary must load all bundled native modules
# and reach the stdio "ready" line. Empty stdin closes the transport so it exits.
echo "Self-check: starting ${OUT} to confirm it loads its bundled modules"
# Capture startup stderr in a PROJECT-LOCAL temp file. The system temp dir can be
# unwritable (e.g. sandboxes return `mktemp: Operation not permitted`); a failed
# mktemp must be a clear packaging blocker, not a silent empty path that lets the
# self-check "pass" against nothing. dist/ is writable (created above).
check_err="$(mktemp "dist/.selfcheck-stderr.XXXXXX" 2>/dev/null || true)"
if [ -z "${check_err}" ] || [ ! -f "${check_err}" ]; then
  echo "error: could not create a writable temp file for the startup self-check (tried under dist/)." >&2
  echo "Packaging blocker: refusing to claim success without actually running the binary self-check." >&2
  echo "See docs/architecture.md (\"Self-contained local binary\")." >&2
  rm -f "${OUT}"
  exit 1
fi
# The bridge is stderr-silent on a healthy boot (Claude Code rejects stderr during
# the handshake); opt into the ready line so this self-check can still detect a boot.
CAPTATUM_STDIO_DEBUG=1 "./${OUT}" </dev/null >/dev/null 2>"${check_err}" &
bin_pid=$!
( sleep 8; kill "${bin_pid}" 2>/dev/null ) &
watchdog_pid=$!
wait "${bin_pid}"; run_status=$?
kill "${watchdog_pid}" 2>/dev/null

if ! grep -q "local stdio bridge ready" "${check_err}"; then
  echo "error: ${OUT} failed its startup self-check (exit ${run_status}); removing broken artifact." >&2
  echo "------ binary startup stderr ------" >&2
  cat "${check_err}" >&2
  echo "-----------------------------------" >&2
  echo "Packaging blocker: the compiled binary did not start. See docs/architecture.md." >&2
  rm -f "${OUT}" "${check_err}"
  exit 1
fi

rm -f "${check_err}"
echo "Built ${OUT} ($(du -h "${OUT}" | cut -f1)); startup self-check passed."
