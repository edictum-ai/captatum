#!/usr/bin/env node
// captatum launcher — the package `bin`. Re-execs Node 24 on a compiled entry
// (dist/ — Node 24 refuses to type-strip .ts inside node_modules, so the npm
// package ships compiled .js; the repo itself runs .ts natively for dev).
//
// With args it runs the one-shot CLI (fetch / skill install); with no args it
// runs the stdio MCP bridge (for MCP clients). stdio is inherited so the caller
// owns the process lifecycle.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (!Number.isInteger(major) || major < 24) {
  process.stderr.write(`captatum requires Node.js >= 24 (got ${process.versions.node}).\n`);
  process.stderr.write("Use a recent Node, or run the hosted gateway (ghcr.io/acartag7/captatum).\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const entry = args.length > 0 ? "../dist/cli.js" : "../dist/interfaces/mcp/stdio-bridge.js";
const entryPath = fileURLToPath(new URL(entry, import.meta.url));
const result = spawnSync(process.execPath, ["--no-warnings", entryPath, ...args], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
