import { createCaptatumUseCase } from "./application/use-cases/captatum.ts";
import { CaptatumInputError } from "./application/use-cases/captatum-input.ts";
import { resultToMcpText, debugTextBlock } from "./interfaces/mcp/format.ts";
import { buildLocalDeps } from "./interfaces/mcp/local-deps.ts";
import { captatumSkillMarkdown, installSkill, type SkillTarget } from "./interfaces/mcp/skill.ts";
import { pathToFileURL } from "node:url";

/**
 * captatum CLI — one-shot fetch + agent-skill install. When the bin is invoked
 * with args, it runs this (no args → the stdio MCP bridge).
 *
 *   captatum <url> [flags]                          fetch + print, then exit
 *   captatum skill install [--target claude|codex]  install the agent skill
 *   captatum skill print  [--target claude|codex]   print the skill content
 *   captatum --help | -h                            this help
 */
const USAGE = `captatum — adaptive web-fetch (renders JS only when needed + structured extraction).

Usage:
  captatum <url> [flags]                       Fetch a URL, print the result, exit.
  captatum skill install [--target claude|codex]  Install the captatum agent skill.
  captatum skill print   [--target claude|codex]  Print the skill markdown.
  (no args)                                    Run as a stdio MCP server (for MCP clients).

Fetch flags:
  --output <raw|summary|extract>     Default: summary when a provider is configured, else raw.
  --prompt "<text>"                  What you want from the page (drives summary).
  --schema '<json>'                  JSON Schema for --output extract.
  --budget <n>                       Max tokens for the summary.
  --allow-render                     Render in a real browser (JS-only pages).
  --debug                            Append diagnostics (tier, attempts, model/tokens).
  --max-bytes <n>                    Fetch byte cap.
  --timeout-ms <n>                   Fetch timeout (ms).

Set OPENROUTER_API_KEY (or OLLAMA_BASE_URL + OLLAMA_MODEL) for summaries; without a
provider, --output defaults to raw (clean content + structured data, no LLM).
`;

interface ParsedArgs {
  url?: string;
  output?: string;
  prompt?: string;
  schema?: string;
  budget?: number;
  maxBytes?: number;
  timeoutMs?: number;
  debug: boolean;
  allowRender: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { debug: false, allowRender: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--output") out.output = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--schema") out.schema = argv[++i];
    else if (a === "--budget") out.budget = Number(argv[++i]);
    else if (a === "--max-bytes") out.maxBytes = Number(argv[++i]);
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--debug") out.debug = true;
    else if (a === "--allow-render" || a === "--allowRender") out.allowRender = true;
    else if (!a.startsWith("-") && out.url === undefined) out.url = a;
  }
  return out;
}

async function runFetch(argv: readonly string[]): Promise<void> {
  const a = parseArgs(argv);
  if (!a.url) {
    process.stderr.write("captatum: no URL provided.\n\n" + USAGE);
    process.exit(1);
  }
  let schema: unknown;
  if (a.schema !== undefined) {
    try {
      schema = JSON.parse(a.schema);
    } catch {
      process.stderr.write("captatum: --schema is not valid JSON.\n");
      process.exit(1);
    }
  }
  const captatum = createCaptatumUseCase(await buildLocalDeps());
  let result;
  try {
    result = await captatum.execute({
      url: a.url,
      output: a.output,
      prompt: a.prompt,
      debug: a.debug,
      allowRender: a.allowRender,
      schema,
      budget: a.budget,
      maxBytes: a.maxBytes,
      timeoutMs: a.timeoutMs,
    });
  } catch (error) {
    const msg = error instanceof CaptatumInputError
      ? error.body.error.message
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`captatum: ${msg}\n`);
    process.exit(1);
  }
  let text = resultToMcpText(result, a.debug);
  // CLI only: --debug shows diagnostics even for raw output (no structuredContent channel here).
  if (a.debug && result.output === "raw") text += `\n\n${debugTextBlock(result)}`;
  // Flush stdout before exiting (large piped output can truncate on immediate exit).
  // Exit nonzero for failure/no-content results (error, render-blocked, render-unavailable,
  // or an empty body) so shell automation doesn't see a silent success on an empty fetch.
  const failed = result.tier === "error" || result.tier === "render-blocked" || result.tier === "render-unavailable";
  const noContent = typeof result.result !== "string" || result.result.trim() === "";
  process.stdout.write(`${text}\n`, () => process.exit(failed || noContent ? 1 : 0));
}

function parseTarget(argv: readonly string[]): SkillTarget {
  const i = argv.indexOf("--target");
  if (i < 0) return "claude";
  const v = argv[i + 1];
  if (v !== "claude" && v !== "codex") {
    process.stderr.write(`captatum: unknown --target "${v ?? "(missing)"}". Use 'claude' or 'codex'.\n`);
    process.exit(1);
  }
  return v === "codex" ? "codex" : "claude";
}

function runSkill(argv: readonly string[]): void {
  const sub = argv[0];
  const target = parseTarget(argv);
  if (sub === "install") {
    const r = installSkill(target);
    process.stdout.write(`captatum skill installed for ${r.target} → ${r.path} (${r.created ? "created" : "updated"})\n`);
    process.exit(0);
  }
  if (sub === "print") {
    process.stdout.write(`${captatumSkillMarkdown(target)}\n`);
    process.exit(0);
  }
  process.stderr.write("captatum skill: expected 'install' or 'print'.\n");
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (argv[0] === "skill") {
    runSkill(argv.slice(1));
  } else {
    await runFetch(argv);
  }
}

// Only run when invoked as the entry point (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
