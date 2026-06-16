export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function normalizeBudget(budget: number | undefined): number | undefined {
  return typeof budget === "number" && Number.isInteger(budget) && budget > 0 ? budget : undefined;
}
