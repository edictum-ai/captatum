import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Process-level stdio smoke: launches the ADVERTISED local entrypoint exactly as
 * an MCP client would — `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` —
 * and proves stdout is a pure JSON-RPC channel: no pnpm lifecycle banner, no stray
 * log line. The in-memory `smoke-stdio.ts` exercises local server semantics but
 * cannot catch stdout contamination from a script wrapper (e.g. `pnpm run bridge`
 * printing `> captatum@… bridge` to stdout); this one launches the real process.
 *
 * It performs the protocol handshake, `tools/list`, and one `captatum` call whose
 * 127.0.0.1 target is rejected before egress. That exercises real call framing and
 * #193's input recovery while staying hermetic: no network egress or public fixture.
 * A healthy boot must be stderr-SILENT (Claude Code rejects stderr during the handshake);
 * audit/ready logs are gated behind CAPTATUM_STDIO_DEBUG=1.
 */

const ENTRY = "src/interfaces/mcp/stdio-bridge.ts";
const PROTOCOL_VERSION = "2025-11-25";
const RESPONSE_TIMEOUT_MS = 15_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: unknown;
  method?: string;
}

interface ToolEntry {
  name?: string;
  inputSchema?: { additionalProperties?: unknown };
}

const child = spawn(process.execPath, ["--no-warnings", ENTRY], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  // Force the DEFAULT stderr-silent path (clear any inherited CAPTATUM_STDIO_DEBUG) so this
  // smoke asserts the Claude-Code-compatible contract regardless of the dev/CI shell env.
  env: { ...process.env, CAPTATUM_FLAVOR: "local-binary", CAPTATUM_STDIO_DEBUG: "" },
});

if (!child.stdin || !child.stdout || !child.stderr) {
  throw new Error("stdio process smoke: failed to open stdio pipes for the bridge process");
}
const { stdin, stdout, stderr } = child;

const stdoutLines: string[] = [];
const contaminated: string[] = [];
const stderrChunks: string[] = [];
const received = new Map<number | string, JsonRpcMessage>();
const waiters = new Map<number | string, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
let stdoutBuffer = "";
let childExited = false;

stdout.setEncoding("utf8");
stdout.on("data", (chunk: string) => {
  stdoutBuffer += chunk;
  let newline = stdoutBuffer.indexOf("\n");
  while (newline >= 0) {
    consumeLine(stdoutBuffer.slice(0, newline));
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    newline = stdoutBuffer.indexOf("\n");
  }
});
stderr.setEncoding("utf8");
stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

child.on("error", (error: Error) => failAllWaiters(new Error(`bridge process error: ${error.message}`)));
child.on("exit", (code, signal) => {
  childExited = true;
  if (stdoutBuffer.trim() !== "") {
    consumeLine(stdoutBuffer);
    stdoutBuffer = "";
  }
  failAllWaiters(new Error(`bridge process exited early (code=${code} signal=${signal})\nstderr:\n${stderrText()}`));
});

function consumeLine(raw: string): void {
  const line = raw.replace(/\r$/, "").trim();
  if (line === "") return;
  stdoutLines.push(line);
  let parsed: JsonRpcMessage;
  try {
    parsed = JSON.parse(line) as JsonRpcMessage;
  } catch {
    contaminated.push(line);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
    contaminated.push(line);
    return;
  }
  if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
    received.set(parsed.id, parsed);
    const waiter = waiters.get(parsed.id);
    if (waiter) {
      waiters.delete(parsed.id);
      waiter.resolve(parsed);
    }
  }
}

function failAllWaiters(error: Error): void {
  for (const [id, waiter] of waiters) {
    waiters.delete(id);
    waiter.reject(error);
  }
}

function stderrText(): string {
  return stderrChunks.join("");
}

function send(message: Record<string, unknown>): void {
  if (!stdin.writable) return;
  stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(id: number): Promise<JsonRpcMessage> {
  const existing = received.get(id);
  if (existing) return Promise.resolve(existing);
  if (childExited) {
    return Promise.reject(new Error(`bridge exited before responding to id=${id}\nstderr:\n${stderrText()}`));
  }
  return new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out after ${RESPONSE_TIMEOUT_MS}ms waiting for JSON-RPC id=${id}\nstderr:\n${stderrText()}`));
    }, RESPONSE_TIMEOUT_MS);
    waiters.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => isRecord(entry) && typeof entry.code === "string" ? [entry.code] : []);
}

async function run(): Promise<ToolEntry> {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "captatum-stdio-process-smoke", version: "0.1.0" },
    },
  });
  await waitForResponse(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitForResponse(2);

  const result = list.result as { tools?: ToolEntry[] } | undefined;
  const tools = result?.tools ?? [];
  const tool = tools.find((entry) => entry.name === "captatum");
  if (!tool) {
    const names = tools.map((entry) => entry.name).join(", ") || "none";
    throw new Error(`tools/list did not advertise captatum over stdio (saw: ${names})`);
  }
  if (tool.inputSchema?.additionalProperties !== false) {
    throw new Error("stdio captatum inputSchema is not strict (additionalProperties !== false)");
  }

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "captatum",
      arguments: {
        url: "http://127.0.0.1/",
        output: "extract",
        schema: { type: "object", budget: 700 },
      },
    },
  });
  const call = await waitForResponse(3);
  const structuredContent = isRecord(call.result) && isRecord(call.result.structuredContent)
    ? call.result.structuredContent
    : undefined;
  if (!structuredContent) {
    throw new Error(`captatum recovery probe returned no structured content: ${JSON.stringify(call)}`);
  }
  if (!errorCodes(structuredContent.errors).includes("private_address")) {
    throw new Error(`captatum recovery probe did not reject 127.0.0.1 before egress: ${JSON.stringify(call)}`);
  }
  if (!errorCodes(structuredContent.warnings).includes("schema_knob_extracted")) {
    throw new Error(`captatum recovery probe did not surface schema_knob_extracted: ${JSON.stringify(call)}`);
  }
  if (contaminated.length > 0) {
    throw new Error(
      `stdout is NOT a pure JSON-RPC channel — ${contaminated.length} non-protocol line(s):\n${contaminated.join("\n")}`,
    );
  }
  if (stdoutLines.length === 0) {
    throw new Error("no JSON-RPC frames observed on stdout; bridge produced no protocol output");
  }
  // A healthy boot must be stderr-SILENT: some MCP clients (Claude Code) treat any stderr
  // during the initialize handshake as a fatal server error (-32000). Audit/ready logs are
  // gated behind CAPTATUM_STDIO_DEBUG=1 (not set here), so stderr should be empty.
  if (stderrText().trim() !== "") {
    throw new Error(
      `bridge wrote to stderr on a healthy boot (must be silent — clients like Claude Code reject stderr during the handshake):\n${stderrText()}`,
    );
  }
  return tool;
}

let exitCode = 0;
try {
  const tool = await run();
  console.log("--- captatum local stdio bridge process smoke ---");
  console.log(`advertised command: node --no-warnings ${ENTRY}`);
  console.log(`stdout JSON-RPC frames: ${stdoutLines.length} (0 non-protocol lines)`);
  console.log("stdout is a pure JSON-RPC channel: no pnpm banner, no stray logs");
  console.log(`captatum advertised over stdio with strict schema: ${tool.name === "captatum" ? "yes" : "no"}`);
  console.log("captatum recovery probe: schema knob warning + pre-egress private-address reject verified");
  console.log("stderr silent on healthy boot (Claude-Code compatible; set CAPTATUM_STDIO_DEBUG=1 for audit/ready logs)");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`stdio process smoke FAILED: ${message}\n`);
  exitCode = 1;
} finally {
  try { stdin.end(); } catch { /* already closed */ }
  if (!childExited) child.kill("SIGTERM");
  await delay(200);
  if (!childExited) child.kill("SIGKILL");
}

process.exit(exitCode);
