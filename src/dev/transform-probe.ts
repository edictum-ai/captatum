/**
 * Verify the transform (summary/extract) path end-to-end against a configured
 * provider (set OLLAMA_BASE_URL/OLLAMA_MODEL or OPENROUTER_API_KEY). Confirms
 * the model receives the verified JSON-LD fields and reports them accurately.
 *
 *   OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=<model> \
 *     node --no-warnings src/dev/transform-probe.ts [url] [prompt]
 */
import { createSmartFetchUseCase } from "../application/use-cases/smart-fetch.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "../infrastructure/wreq/requester.ts";
import { PlaywrightRenderer } from "../infrastructure/render/index.ts";
import { createDefaultLlmTransformer } from "../infrastructure/llm/model-router.ts";

const url = process.argv[2] ?? "https://jobs.ashbyhq.com/e2b/ab44a84f-4467-438a-a26c-2420237c54e2";
const prompt = process.argv[3] ?? "Extract the job title, salary range, and location. Reply as a short bullet list.";
const output = (process.env.OUTPUT ?? "summary") as "summary" | "extract";
const schema = process.env.SCHEMA ? JSON.parse(process.env.SCHEMA) : undefined;
const clock = { nowMs: () => Date.now() };
const transformer = await createDefaultLlmTransformer();
const smartFetch = createSmartFetchUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  transformer,
  renderer: new PlaywrightRenderer(),
  clock,
});

const result = await smartFetch.execute({ url, output, prompt, ...(schema ? { schema } : {}) });
console.log(JSON.stringify({
  url,
  tier: result.tier,
  title: result.title,
  output: result.output,
  transform: result.transform,
  errors: result.errors,
  result: result.result,
}, null, 2));
