import type { Result } from "../../domain/result.ts";
import {
  extractTier1FromFetchResult,
  type Tier1ExtractInput,
} from "../../application/use-cases/tier1-extract.ts";
import { extractHtml } from "./index.ts";

export type Tier1InfrastructureInput = Omit<Tier1ExtractInput, "extractHtml">;

export async function extractTier1Result(input: Tier1InfrastructureInput): Promise<Result> {
  return await extractTier1FromFetchResult({ ...input, extractHtml });
}
