import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  chooseStoreBackend,
  createHostedStore,
  unwritableStoreDirMessage,
} from "../src/infrastructure/store-selection.ts";

test("chooseStoreBackend selects sqlite unless TIDB_HOST is set", () => {
  assert.equal(chooseStoreBackend(""), "sqlite");
  assert.equal(chooseStoreBackend("   "), "sqlite");
  assert.equal(chooseStoreBackend("gateway01.tidb.cloud"), "tidb");
});

test("createHostedStore defaults to a working SQLite store and creates the parent dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-store-sel-"));
  // Parent dir ("nested") does not exist yet — the factory must create it.
  const path = join(dir, "nested", "captatum.sqlite");
  const { store, backend } = await createHostedStore({
    tidb: { host: "", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
    sqlitePath: path,
  });

  assert.equal(backend, "sqlite");
  // Round-trip an auth code to prove the store is live on the default backend.
  await store.saveAuthCode({
    codeHash: "a".repeat(64),
    clientId: "ctc_x",
    subject: "subj",
    redirectUri: "https://app.example/cb",
    resource: "https://api.example",
    scopes: ["fetch:read"],
    codeChallenge: "c".repeat(64),
    codeChallengeMethod: "S256",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const record = await store.consumeAuthCode("a".repeat(64), "2026-01-01T00:00:00.000Z");
  assert.ok(record, "auth code consumed");
  assert.equal(record?.clientId, "ctc_x");
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("createHostedStore rejects the TiDB backend without TIDB_SSL_CA (SQLSTORE-1)", async () => {
  await assert.rejects(
    createHostedStore({
      tidb: { host: "db.example", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
      sqlitePath: "./data/should-not-be-used.sqlite",
    }),
    /TIDB_SSL_CA/,
  );
});

test("unwritableStoreDirMessage is self-diagnosing: resolved dir + user + cwd + CAPTATUM_SQLITE_PATH fix (#85)", () => {
  const msg = unwritableStoreDirMessage("./data/captatum.sqlite", "EACCES", "node", "/app");
  assert.match(msg, /\/app\/data/); // resolved absolute parent
  assert.match(msg, /CAPTATUM_SQLITE_PATH=\.\/data\/captatum\.sqlite/);
  assert.match(msg, /\bnode\b/); // running-as user
  assert.match(msg, /\bcwd \/app\b/);
  assert.match(msg, /EACCES/);
  assert.match(msg, /\/data\/captatum\.sqlite/); // the suggested writable-volume fix
});

test("createHostedStore fails with an actionable CAPTATUM_SQLITE_PATH message when the parent dir is unwritable (#85)", async () => {
  // root bypasses UNIX perms, so the forced EACCES wouldn't fire — skip rather than flake.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "captatum-store-ro-"));
  const roDir = join(dir, "readonly");
  mkdirSync(roDir);
  chmodSync(roDir, 0o555); // no write → mkdirSync of a child throws EACCES
  try {
    await assert.rejects(
      createHostedStore({
        tidb: { host: "", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
        sqlitePath: join(roDir, "child", "captatum.sqlite"),
      }),
      (err: Error) => /CAPTATUM_SQLITE_PATH/.test(err.message),
    );
  } finally {
    chmodSync(roDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createHostedStore gives the actionable message when the parent dir EXISTS but is unwritable (#85 review)", async () => {
  // Codex P2: mkdirSync is a no-op on an existing dir, so a pre-created/mounted unwritable parent
  // would otherwise surface as SQLite's generic "unable to open database file". The W_OK probe must
  // catch it. root bypasses perms — skip rather than flake.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "captatum-store-ro-existing-"));
  const roDir = join(dir, "readonly");
  mkdirSync(roDir);
  chmodSync(roDir, 0o555); // EXISTS with no write — mkdir no-ops; access(W_OK) must catch it
  try {
    await assert.rejects(
      createHostedStore({
        tidb: { host: "", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
        sqlitePath: join(roDir, "captatum.sqlite"), // parent == roDir (exists, unwritable)
      }),
      (err: Error) => /CAPTATUM_SQLITE_PATH/.test(err.message),
    );
  } finally {
    chmodSync(roDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
