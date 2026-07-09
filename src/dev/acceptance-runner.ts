/**
 * Runs the FROZEN acceptance suite — only ACTIVATED phases (test/acceptance/phases.json).
 * Lives in src/dev/ (NOT under test/acceptance/) so the manifest hashes only test content.
 *
 * A phase is activated ("146": true) only once its implementation lands; an unactivated
 * phase's tests are NOT run, because they assert DESIRED behavior the current code may not
 * yet meet (the suite is frozen before implementation). This makes an activated suite LIVE
 * (gated via the `check` CI job) rather than frozen-dead bytes.
 *
 * Engineering OS artifact chain: process-guard (freeze-hash · mixed-diff · stage-artifact)
 * gates the suite's integrity; this runner is the execution half.
 *
 *   node --no-warnings src/dev/acceptance-runner.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const accDir = path.join(repoRoot, "test", "acceptance");
const phasesPath = path.join(accDir, "phases.json");

const phases = JSON.parse(readFileSync(phasesPath, "utf8")) as Record<string, boolean>;
const files: string[] = [];
for (const [phase, active] of Object.entries(phases)) {
  if (!active) continue;
  const dir = path.join(accDir, phase);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    console.error(`acceptance: phase "${phase}" activated but dir ${dir} missing — skipping`);
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".test.ts")) files.push(path.join(dir, f));
  }
}

if (files.length === 0) {
  console.log("acceptance: no activated phases (test/acceptance/phases.json) — nothing to run");
  process.exit(0);
}

console.log(`acceptance: running ${files.length} file(s) from activated phase(s)`);
try {
  execFileSync("node", ["--no-warnings", "--test", ...files], { stdio: "inherit" });
} catch {
  process.exit(1);
}
