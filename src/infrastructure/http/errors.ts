import type { Redirect, RejectResult } from "../../application/ports/fetcher.ts";

export class GuardedFetchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GuardedFetchError";
  }
}

export function reject(code: string, message: string): never {
  throw new GuardedFetchError(code, message);
}

export function toRejectResult(error: unknown, redirects?: Redirect[]): RejectResult {
  const base = (() => {
    if (error instanceof GuardedFetchError) {
      return { code: error.code, message: error.message };
    }
    if (isAbortError(error)) {
      return { code: "timeout", message: "Fetch timed out" };
    }
    return { code: "network_error", message: "Fetch failed before a safe response was available" };
  })();
  return { rejected: true, ...base, ...(redirects && redirects.length > 0 ? { redirects } : {}) };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    reject("timeout", "Fetch timed out");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("abort")
  );
}

export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let cleanup = () => {};
  const abort = new Promise<T>((_, rejectPromise) => {
    const onAbort = () => rejectPromise(new GuardedFetchError("timeout", "Fetch timed out"));
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    cleanup();
  }
}
