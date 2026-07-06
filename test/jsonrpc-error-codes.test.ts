import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AUTH_JSONRPC_CODE, OVERLOADED_JSONRPC_CODE } from "../src/interfaces/jsonrpc-error-codes.ts";

// #100: captatum's reserved JSON-RPC server-error codes MUST NOT collide with any
// value the @modelcontextprotocol/sdk reserves in its ErrorCode enum — the SDK throws
// those codes itself (e.g. RequestTimeout=-32001 from its timeout/cancellation paths),
// so a collision makes a captatum error ambiguous to any SDK-based client.
// (AUTH_JSONRPC_CODE was -32001, colliding with the SDK's RequestTimeout, so an auth
// failure was indistinguishable from "retry the request".)
//
// This guard is self-defending: if a future SDK release claims one of our codes, OR a
// captatum change moves a code onto an SDK value, this test fails and we bump to a
// free -32000..-32099 value.
const SDK_RESERVED = new Set<number>(
  Object.values(ErrorCode).filter((v): v is number => typeof v === "number"),
);

test("AUTH_JSONRPC_CODE does not collide with any SDK ErrorCode (#100)", () => {
  assert.ok(
    !SDK_RESERVED.has(AUTH_JSONRPC_CODE),
    `AUTH_JSONRPC_CODE ${AUTH_JSONRPC_CODE} collides with an @modelcontextprotocol/sdk ErrorCode — pick a free -32000..-32099 value`,
  );
});

test("OVERLOADED_JSONRPC_CODE does not collide with any SDK ErrorCode (#100)", () => {
  assert.ok(
    !SDK_RESERVED.has(OVERLOADED_JSONRPC_CODE),
    `OVERLOADED_JSONRPC_CODE ${OVERLOADED_JSONRPC_CODE} collides with an @modelcontextprotocol/sdk ErrorCode`,
  );
});

test("captatum JSON-RPC codes are in the server-error range and mutually distinct", () => {
  for (const code of [AUTH_JSONRPC_CODE, OVERLOADED_JSONRPC_CODE]) {
    assert.ok(code <= -32000 && code >= -32099, `${code} is in the -32000..-32099 server-error range (JSON-RPC 2.0 §5.1)`);
  }
  assert.notEqual(AUTH_JSONRPC_CODE, OVERLOADED_JSONRPC_CODE, "auth and overload codes are distinct");
});

test("AUTH_JSONRPC_CODE is -32003 (moved off the -32001 RequestTimeout collision)", () => {
  // Locks the chosen value; update this + the guard above if it must ever move.
  assert.equal(AUTH_JSONRPC_CODE, -32003);
  assert.notEqual(AUTH_JSONRPC_CODE, ErrorCode.RequestTimeout, "distinct from the SDK's -32001 RequestTimeout");
});
