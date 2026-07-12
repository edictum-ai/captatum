/**
 * #155 verify probe (REAL-LLM before/after, not a unit assert on the clause).
 *
 * Reproduces transform_truncated on a REAL capped summary and checks that the front-load
 * clause makes the caller's most important fields survive the cap. Same content + same model
 * + same cap; the ONLY variable is FRONTLOAD_ON_TRUNCATION in the summary instruction.
 *
 *   node --no-warnings src/dev/truncation-probe.ts [url] [cap] [trials]
 *
 * Needs OPENROUTER_API_KEY in env (e.g. `set -a; . /path/.env; set +a` first — never echo it).
 * Prints field-survival counts + verdict/mid-cutoff rates per condition + the WITH−WITHOUT delta
 * + one sample truncated output per condition. Non-deterministic by nature → k-of-N, temperature 0.
 */
import { createCaptatumUseCase } from "../application/use-cases/captatum.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { createDefaultLlmTransformer } from "../infrastructure/llm/model-router.ts";
import { OpenRouterProvider } from "../infrastructure/llm/openrouter.ts";
import { buildMessages, FRONTLOAD_ON_TRUNCATION } from "../infrastructure/llm/prompts.ts";
import type { LlmGenerateInput, LlmMessage } from "../infrastructure/llm/types.ts";
import { config } from "../config.ts";

const URL = process.argv[2] ?? "https://github.com/edictum-ai/captatum";
const CAP = Number(process.argv[3] ?? 110);
const TRIALS = Number(process.argv[4] ?? 5);
const MODEL_OVERRIDE = process.argv[5] ?? "";

// Same structured prompt as the #155 repro (purpose/stack/polish/strengths/red flags/verdict).
const PROMPT = "Summarize this repository for a technical due-diligence read. Cover, in this order: (1) purpose — what problem it solves; (2) stack — languages, frameworks, infrastructure; (3) polish — maturity signals such as tests, CI, docs, versioning; (4) strengths; (5) red flags — security, licensing, or abandonment risks; (6) a one-line verdict. Be specific and concrete.";

// Field labels the model echoes back. present() = the label appears with trailing content.
const FIELDS: Array<[string, RegExp]> = [
  ["purpose", /purpose/i],
  ["stack", /stack/i],
  ["polish", /polish|matur/i],
  ["strengths", /strength/i],
  ["red-flags", /red flag|risk/i],
  ["verdict", /verdict|conclusion|bottom line|overall/i],
];

interface Trial { truncated: boolean; fields: number; verdict: boolean; redFlags: boolean; midCutoff: boolean; text: string; }

function score(text: string, rawTruncated: boolean | undefined): Trial {
  const t = text.trim();
  // A field "survives" if its label appears AND is followed by >2 non-label chars (not just a
  // dangling header like the repro's empty "(5) Red flags:").
  const fields = FIELDS.filter(([, re]) => {
    const m = t.match(re);
    return m && m.index !== undefined && t.slice(m.index).length > m[0].length + 2;
  }).length;
  return {
    truncated: rawTruncated ?? false,
    fields,
    verdict: /verdict|conclusion|bottom line|overall/i.test(t),
    redFlags: /red flag|risk/i.test(t),
    // Ends without terminal punctuation → cut off mid-answer (the #155 failure mode).
    midCutoff: !/[.!?:"']$/.test(t),
    text,
  };
}

function strip(messages: LlmMessage[]): LlmMessage[] {
  // Controlled single-variable baseline: identical messages with ONLY the clause removed.
  return messages.map((m) => m.role === "user" ? { ...m, content: m.content.replace(` ${FRONTLOAD_ON_TRUNCATION}`, "") } : m);
}

async function run(provider: OpenRouterProvider, model: string, messages: LlmMessage[]): Promise<Trial | string> {
  const input: LlmGenerateInput = { task: "summarize", model, prompt: PROMPT, content: "", messages, maxOutputTokens: CAP };
  try {
    const res = await provider.generate(input);
    if (!res.text.trim()) return "empty completion";
    return score(res.text, res.truncated);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const clock = { nowMs: () => Date.now() };
const captatum = createCaptatumUseCase({ fetcher: createWreqGuardedFetcher(), extractHtml, transformer: await createDefaultLlmTransformer(), clock });
const page = await captatum.execute({ url: URL, output: "raw" });
const content = page.result;
if (!content || content.length < 200) { console.error(`Could not fetch usable content from ${URL} (got ${content.length} chars)`); process.exit(1); }

const provider = new OpenRouterProvider({ apiKey: config.transform.openRouterApiKey(), models: splitList(config.transform.openRouterModels()), timeoutMs: config.transform.timeoutMs() });
await provider.discover();
const candidates = provider.candidates();
const candidate = (MODEL_OVERRIDE && candidates.find((c) => c.model === MODEL_OVERRIDE)) || candidates[0];
if (!candidate) { console.error("No OpenRouter candidate — is OPENROUTER_API_KEY set?"); process.exit(1); }

const withMsgs = buildMessages({ mode: "summarize", output: "summary", content, prompt: PROMPT });
const conditions: Array<{ name: "with-clause" | "without-clause"; msgs: LlmMessage[] }> = [
  { name: "with-clause", msgs: withMsgs },
  { name: "without-clause", msgs: strip(withMsgs) },
];

console.log(`#155 truncation probe — url=${URL} model=${candidate.model} cap=${CAP} trials=${TRIALS} content=${content.length}chars\n`);

const samples: Record<string, string> = {};
const firstError: Record<string, string> = {};
const agg: Record<string, { fields: number[]; verdict: number; redFlags: number; midCutoff: number; truncated: number; errors: number; ok: number }> = {};
for (const cond of conditions) {
  agg[cond.name] = { fields: [], verdict: 0, redFlags: 0, midCutoff: 0, truncated: 0, errors: 0, ok: 0 };
  for (let i = 0; i < TRIALS; i++) {
    const r = await run(provider, candidate.model, cond.msgs);
    if (typeof r === "string") { agg[cond.name].errors++; if (!firstError[cond.name]) firstError[cond.name] = r; continue; }
    const a = agg[cond.name];
    a.ok++; a.fields.push(r.fields); a.verdict += r.verdict ? 1 : 0; a.redFlags += r.redFlags ? 1 : 0;
    a.midCutoff += r.midCutoff ? 1 : 0; a.truncated += r.truncated ? 1 : 0;
    if (!samples[cond.name] && r.truncated) samples[cond.name] = r.text;
  }
}

function avg(xs: number[]): string { return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "n/a"; }
function pct(n: number, d: number): string { return d ? `${Math.round((n / d) * 100)}%` : "n/a"; }

for (const cond of conditions) {
  const a = agg[cond.name];
  console.log(`[${cond.name}] ok=${a.ok} errors=${a.errors} truncated=${pct(a.truncated, a.ok)} avgFieldsSurvived=${avg(a.fields)}/6 verdictPresent=${pct(a.verdict, a.ok)} redFlagsPresent=${pct(a.redFlags, a.ok)} endsMidAnswer=${pct(a.midCutoff, a.ok)}`);
  if (firstError[cond.name]) console.log(`  first error: ${firstError[cond.name]}`);
}
const w = agg["with-clause"], wo = agg["without-clause"];
console.log(`\nDELTA (with − without): verdictPresent ${pct(w.verdict, w.ok)} vs ${pct(wo.verdict, wo.ok)} · endsMidAnswer ${pct(w.midCutoff, w.ok)} vs ${pct(wo.midCutoff, wo.ok)} · avgFields ${avg(w.fields)} vs ${avg(wo.fields)}`);
for (const name of ["without-clause", "with-clause"] as const) {
  const s = samples[name];
  if (s) console.log(`\n--- sample ${name} (truncated output, first 500 chars) ---\n${s.slice(0, 500)}`);
}

function splitList(value: string): string[] { return value.split(",").map((s) => s.trim()).filter(Boolean); }
