#!/usr/bin/env bash
# Captatum browser sidecar — a long-lived headless Chromium exposing CDP, so the
# gateway connects to it (CAPTATUM_BROWSER_CDP_ENDPOINT=http://<host>:9222) and
# never launches a browser in its own process.
#
# WHY THIS EXISTS: blast-radius separation. A Chromium RCE/sandbox-escape escapes
# into THIS container (no OAuth keys, no DB creds, no env) — NOT into the gateway.
# `--no-sandbox` is acceptable HERE because the container is the isolation
# boundary; it is NOT acceptable in-process with the gateway. See
# docs/threat-model.md.
#
# The Chromium major version MUST match the gateway's `playwright` pin
# (package.json); a mismatch can break the CDP protocol.
set -euo pipefail

PORT="${CAPTATUM_BROWSER_CDP_PORT:-9222}"

# Locate the bundled Chromium. The mcr.microsoft.com/playwright image lays it out
# at /ms-playwright/chromium-<ver>/chrome-linux/chrome; fall back to PATH names.
CHROME="$(ls /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1 || true)"
CHROME="${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
if [ -z "${CHROME:-}" ]; then
  echo "browser-sidecar: no chromium binary found" >&2
  exit 1
fi

# Bind loopback only: pods that share one network namespace (e.g. the gateway
# + browser sidecar) reach each other via 127.0.0.1, so the gateway reaches the
# browser on 127.0.0.1:9222 (same pattern as the tunnel -> gateway 127.0.0.1:3000
# hop). Loopback-only also keeps CDP off the pod's network interface. (Chromium
# binds 127.0.0.1 by default; --remote-debugging-address is intentionally NOT set
# to 0.0.0.0.)
exec "${CHROME}" \
  --headless=new \
  --no-sandbox \
  --remote-debugging-port="${PORT}" \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --no-remote \
  about:blank
