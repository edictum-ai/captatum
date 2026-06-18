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
# Bind 0.0.0.0 inside the container; the task network / a firewall constrains who
# may reach it. The gateway connects over the (same-task) loopback or private net.
exec chromium \
  --headless=new \
  --no-sandbox \
  --remote-debugging-port="${PORT}" \
  --remote-debugging-address=0.0.0.0 \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --no-remote \
  about:blank
