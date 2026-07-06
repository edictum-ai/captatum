/**
 * Captatum's reserved JSON-RPC server-error codes (-32000..-32099, the
 * implementation-defined "Server error" range per JSON-RPC 2.0 §5.1).
 *
 * These MUST NOT collide with codes the @modelcontextprotocol/sdk reserves in its
 * ErrorCode enum (it throws these itself, so a collision makes captatum's errors
 * ambiguous to any SDK-based client). At present the SDK reserves, in this range:
 *   -32000 ConnectionClosed, -32001 RequestTimeout, -32042 UrlElicitationRequired.
 *
 * #100: AUTH_JSONRPC_CODE was previously -32001, which collides EXACTLY with the
 * SDK's RequestTimeout — the SDK emits -32001 from its own timeout/cancellation
 * paths, so an auth failure was indistinguishable from "retry the request" (a client
 * would retry a 401 forever). Moved to -32003: lowest free value, clear of the SDK's
 * only sequential pair (-32000/-32001), distinct from -32042 and from captatum's own
 * OVERLOADED_JSONRPC_CODE (-32050).
 *
 * A collision-guard test (test/jsonrpc-error-codes.test.ts) asserts dynamically that
 * none of these values appear in the SDK ErrorCode enum, so if a future SDK release
 * claims one, CI fails and we bump to the next free value.
 */
export const AUTH_JSONRPC_CODE = -32003;
export const OVERLOADED_JSONRPC_CODE = -32050; // admission overload: distinct, retryable (#84)
