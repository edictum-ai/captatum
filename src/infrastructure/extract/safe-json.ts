export interface SafeJsonIssue {
  code: "invalid_json" | "unsafe_json_key";
  message: string;
}

export type SafeJsonResult =
  | { ok: true; value: unknown; issues: SafeJsonIssue[] }
  | { ok: false; issues: SafeJsonIssue[] };

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseSafeJson(input: string): SafeJsonResult {
  const dropped = new Set<string>();

  try {
    const value = JSON.parse(input, (key: string, value: unknown) => {
      if (UNSAFE_KEYS.has(key)) {
        dropped.add(key);
        return undefined;
      }
      return value;
    }) as unknown;

    const issues = [...dropped].map((key) => ({
      code: "unsafe_json_key" as const,
      message: `Unsafe embedded JSON key ignored: ${key}`,
    }));
    return { ok: true, value, issues };
  } catch {
    return {
      ok: false,
      issues: [{ code: "invalid_json", message: "Embedded JSON could not be parsed safely" }],
    };
  }
}
