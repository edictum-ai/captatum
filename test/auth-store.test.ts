// Regression coverage for src/infrastructure/auth-store.ts — the hosted OAuth-state store
// factory. The SQLSTORE-1 TLS gate is a security control (forces TLS so OAuth token hashes
// + the DB password never cross the wire in plaintext); this pins it fail-closed. The
// SQLite-default path (incl. ensureParentDir) and the actionable unwritable-dir message
// are exercised too. (Non-frozen: this guards an impl detail, not a contract value.)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHostedAuthStore, unwritableStoreDirMessage } from "../src/infrastructure/auth-store.ts";

const TIDB_ENV = {
  TIDB_HOST: "tidb.test", TIDB_PORT: "4000", TIDB_DATABASE: "captatum",
  TIDB_USER: "u", TIDB_PASSWORD: "p",
};

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("SQLSTORE-1: a TiDB-selected store with no TIDB_SSL_CA fails closed (TLS required)", async () => {
  // TIDB_HOST set opts into TiDB; an absent CA must throw, never fall back to plaintext.
  await withEnv({ ...TIDB_ENV, TIDB_SSL_CA: undefined }, async () => {
    await assert.rejects(
      createHostedAuthStore(),
      /TIDB_SSL_CA.*TLS/,
      "TiDB with no CA must fail closed instead of sending OAuth hashes + the password in plaintext",
    );
  });
});

test("SQLite is the default backend: no TIDB_HOST ⇒ ensureParentDir + openSqliteStore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-auth-store-"));
  // A nested parent that does not exist yet — exercises ensureParentDir's recursive mkdir.
  const file = join(dir, "nested", "auth.sqlite");
  try {
    await withEnv({ TIDB_HOST: undefined, CAPTATUM_SQLITE_PATH: file }, async () => {
      const { store, backend } = await createHostedAuthStore();
      assert.equal(backend, "sqlite");
      assert.ok(existsSync(file), "ensureParentDir created the nested parent and the sqlite file opened");
      assert.equal(typeof store.sweepExpired, "function", "the store is a mcp-sso StorePort");
      // sweepExpired must accept a 3-ms-digit UTC ISO timestamp (assertUtcIsoTimestamp).
      await store.sweepExpired(new Date().toISOString());
      await store.close();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unwritableStoreDirMessage names the resolved path, the env var, the user, and the fix", () => {
  const msg = unwritableStoreDirMessage("/app/data/captatum.sqlite", "EACCES", "node", "/app");
  assert.match(msg, /\/app\/data/); // the resolved parent dir
  assert.match(msg, /CAPTATUM_SQLITE_PATH/); // the env knob to turn
  assert.match(msg, /\bnode\b/); // the running user
  assert.match(msg, /writable mounted volume/); // the actionable remedy
});
