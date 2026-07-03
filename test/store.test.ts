import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SaveAuthCodeInput, SaveRefreshTokenInput } from "../src/application/ports/store.ts";
import { StoreInputError, assertUtcIsoTimestamp } from "../src/application/ports/store.ts";
import { openSqliteStore } from "../src/infrastructure/sqlite/index.ts";
import { migrateTidbStore, TidbStore } from "../src/infrastructure/tidb/index.ts";
import type { TidbClient } from "../src/infrastructure/tidb/index.ts";

const NOW = "2026-06-16T12:00:00.000Z";
const LATER = "2026-06-16T12:05:00.000Z";
const MID = "2026-06-16T12:30:00.000Z";
const FUTURE = "2026-06-16T13:00:00.000Z";
const PAST = "2026-06-16T11:00:00.000Z";

test("sqlite auth codes are hashed, single-use, expired, and not content storage", async () => {
  const { file, cleanup } = sqlitePath();
  const rawCode = "raw-auth-code-secret";
  const expiredRawCode = "expired-auth-code-secret";
  const store = openSqliteStore(file);

  await store.saveAuthCode(authCode(rawCode, FUTURE));
  const consumed = await store.consumeAuthCode(sha256Hex(rawCode), NOW);
  assert.equal(consumed?.codeHash, sha256Hex(rawCode));
  assert.deepEqual(consumed?.scopes, ["fetch:read"]);
  assert.equal(await store.consumeAuthCode(sha256Hex(rawCode), NOW), null);

  await store.saveAuthCode(authCode(expiredRawCode, PAST));
  assert.equal(await store.consumeAuthCode(sha256Hex(expiredRawCode), NOW), null);
  await assert.rejects(
    store.saveAuthCode({ ...authCode("unused", FUTURE), codeHash: rawCode }),
    (error) => error instanceof StoreInputError,
  );

  await store.close();
  assertNoRawStrings(file, [rawCode, expiredRawCode]);
  assertNoContentTables(file);
  cleanup();
});

test("sqlite sweepExpired rejects a non-millisecond cutoff (PR #86 review)", async () => {
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  // A mixed-precision cutoff string-compares wrong against fixed ...fffZ expiries and
  // could sweep still-valid auth state — reject it (parity with TiDB's sweepExpired).
  await assert.rejects(store.sweepExpired("2026-06-16T12:00:00Z"), (error) => error instanceof StoreInputError);
  await store.sweepExpired(NOW); // a valid 3-ms-digit cutoff still works
  await store.close();
  cleanup();
});

test("sqlite rotates refresh tokens and replay revokes the refresh family", async () => {
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "refresh-token-one-raw";
  const rawTwo = "refresh-token-two-raw";
  const rawThree = "refresh-token-three-raw";
  const rawFour = "refresh-token-four-raw";

  await store.saveRefreshToken(refreshToken(rawOne, "family-1", null, FUTURE));
  const rotated = await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "family-1", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  assert.equal(rotated?.tokenHash, sha256Hex(rawOne));

  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawThree, "family-1", sha256Hex(rawOne), FUTURE),
    LATER,
  ), null);
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawFour, "family-1", sha256Hex(rawTwo), FUTURE),
    LATER,
  ), null);

  await store.close();
  assertNoRawStrings(file, [rawOne, rawTwo, rawThree, rawFour]);
  cleanup();
});


test("sqlite rotation preserves refresh-token metadata from the consumed token", async () => {
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "refresh-metadata-one";
  const rawTwo = "refresh-metadata-two";
  const rawThree = "refresh-metadata-three";

  await store.saveRefreshToken(refreshToken(rawOne, "family-metadata", null, FUTURE));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    {
      ...refreshToken(rawTwo, "family-metadata", sha256Hex(rawOne), FUTURE),
      clientId: "attacker",
      subject: "attacker",
      scopes: ["fetch:transform"],
    },
    NOW,
  );
  const second = await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawThree, "family-metadata", sha256Hex(rawTwo), FUTURE),
    LATER,
  );

  assert.equal(second?.clientId, "client-1");
  assert.equal(second?.subject, "subject-1");
  assert.deepEqual(second?.scopes, ["fetch:read"]);
  await store.close();
  cleanup();
});

test("sqlite rejects expired refresh tokens and closes idempotently", async () => {
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawToken = "expired-refresh-token-raw";

  await store.saveRefreshToken(refreshToken(rawToken, "family-expired", null, PAST));
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawToken),
    refreshToken("next-token-raw", "family-expired", sha256Hex(rawToken), FUTURE),
    NOW,
  ), null);
  await store.close();
  await store.close();
  await assert.rejects(store.saveRefreshToken(refreshToken("closed-token", "closed", null, FUTURE)));
  cleanup();
});

test("tidb fake covers auth code single-use, expiry, and parameterized SQL", async () => {
  const fake = new FakeTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  const rawCode = "tidb-raw-auth-code";
  const expiredRawCode = "tidb-expired-auth-code";

  await store.saveAuthCode(authCode(rawCode, FUTURE));
  assert.equal((await store.consumeAuthCode(sha256Hex(rawCode), NOW))?.codeHash, sha256Hex(rawCode));
  assert.equal(await store.consumeAuthCode(sha256Hex(rawCode), NOW), null);
  await store.saveAuthCode(authCode(expiredRawCode, PAST));
  assert.equal(await store.consumeAuthCode(sha256Hex(expiredRawCode), NOW), null);

  assertParameterized(fake, [rawCode, expiredRawCode, sha256Hex(rawCode)]);
  assertNoRawInFake(fake, [rawCode, expiredRawCode]);
  await store.close();
  await store.close();
  assert.equal(fake.endCalls, 1);
});

test("tidb fake rotates refresh tokens and revokes family on replay", async () => {
  const fake = new FakeTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  const rawOne = "tidb-refresh-token-one";
  const rawTwo = "tidb-refresh-token-two";
  const rawThree = "tidb-refresh-token-three";
  const rawFour = "tidb-refresh-token-four";

  await store.saveRefreshToken(refreshToken(rawOne, "tidb-family", null, FUTURE));
  const rotated = await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "tidb-family", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  assert.equal(rotated?.tokenHash, sha256Hex(rawOne));
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawThree, "tidb-family", sha256Hex(rawOne), FUTURE),
    LATER,
  ), null);
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawFour, "tidb-family", sha256Hex(rawTwo), FUTURE),
    LATER,
  ), null);

  assert.equal(fake.families.get("tidb-family")?.revoked_at, LATER);
  assertParameterized(fake, [rawOne, rawTwo, rawThree, rawFour, sha256Hex(rawOne)]);
  assertNoRawInFake(fake, [rawOne, rawTwo, rawThree, rawFour]);
});


test("tidb rotation preserves refresh-token metadata from the consumed token", async () => {
  const fake = new FakeTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  const rawOne = "tidb-refresh-metadata-one";
  const rawTwo = "tidb-refresh-metadata-two";
  const rawThree = "tidb-refresh-metadata-three";

  await store.saveRefreshToken(refreshToken(rawOne, "tidb-family-metadata", null, FUTURE));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    {
      ...refreshToken(rawTwo, "tidb-family-metadata", sha256Hex(rawOne), FUTURE),
      clientId: "attacker",
      subject: "attacker",
      scopes: ["fetch:transform"],
    },
    NOW,
  );
  const second = await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawThree, "tidb-family-metadata", sha256Hex(rawTwo), FUTURE),
    LATER,
  );

  assert.equal(second?.clientId, "client-1");
  assert.equal(second?.subject, "subject-1");
  assert.deepEqual(second?.scopes, ["fetch:read"]);
});

test("tidb transaction releases the connection even when beginTransaction fails", async () => {
  // #2: getConnection() + beginTransaction() ran before the try/finally, so a begin
  // throw leaked the pooled connection. With connectionLimit:5, five such failures
  // exhaust the pool and every OAuth call hangs. After the fix, release() still runs.
  class BeginFailsTidb extends FakeTidb {
    async beginTransaction(): Promise<void> {
      throw new Error("begin exploded");
    }
  }
  const fake = new BeginFailsTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  await assert.rejects(store.findRefreshToken(sha256Hex("any")), /begin exploded/);
  assert.ok(
    fake.txEvents.includes("release"),
    "connection leaked: release() not called after beginTransaction threw",
  );
});

test("assertUtcIsoTimestamp requires millisecond precision to keep expiry ordering lexicographic", () => {
  // #8: expiry is compared as a string; uniform 3-digit-ms precision is required or
  // ordering can invert ("…00Z" sorts after "…00.500Z"), flipping expired→valid.
  assert.throws(() => assertUtcIsoTimestamp("2026-07-03T12:00:00Z", "expiresAt"), StoreInputError);
  assert.throws(() => assertUtcIsoTimestamp("2026-07-03T12:00:00+00:00", "expiresAt"), StoreInputError);
  assert.throws(() => assertUtcIsoTimestamp("2026-07-03T12:00:00.12Z", "expiresAt"), StoreInputError);
  assert.throws(() => assertUtcIsoTimestamp("2026-07-03T12:00:00.1234Z", "expiresAt"), StoreInputError);
  assert.doesNotThrow(() => assertUtcIsoTimestamp("2026-07-03T12:00:00.000Z", "expiresAt"));
  assert.doesNotThrow(() => assertUtcIsoTimestamp("2026-07-03T12:00:00.500Z", "expiresAt"));
});

test("sqlite sweeps consumed refresh tokens past validity and cleans the orphaned family", async () => {
  // #7: pre-fix, the sweep kept `AND consumed_at IS NULL` and the family cleanup
  // required `revoked_at IS NOT NULL`, so consumed rows + non-revoked families grew
  // without bound. Both tokens here expire LATER; rotate at NOW consumes T1.
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "gc-refresh-one";
  const rawTwo = "gc-refresh-two";
  await store.saveRefreshToken(refreshToken(rawOne, "gc-family", null, LATER));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "gc-family", sha256Hex(rawOne), LATER),
    NOW,
  );
  await store.sweepExpired(FUTURE);
  assert.equal(rowCount(file, "oauth_refresh_tokens"), 0, "consumed + expired tokens swept");
  assert.equal(rowCount(file, "oauth_refresh_token_families"), 0, "orphaned (non-revoked) family cleaned");
  await store.close();
  cleanup();
});

test("sqlite retains a still-valid consumed token so replay still revokes the family", async () => {
  // #7 regression guard: a consumed token must survive until its expires_at, else a
  // stolen-token replay after the sweep sees no row and silently fails to revoke.
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "retain-refresh-one";
  const rawTwo = "retain-refresh-two";
  const rawThree = "retain-refresh-three";
  await store.saveRefreshToken(refreshToken(rawOne, "retain-family", null, FUTURE));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "retain-family", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  await store.sweepExpired(LATER); // LATER < FUTURE — still within validity
  assert.notEqual(await store.findRefreshToken(sha256Hex(rawOne)), null, "consumed token retained within validity");
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawThree, "retain-family", sha256Hex(rawOne), FUTURE),
    LATER,
  ), null, "replay of consumed T1 detected");
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawThree, "retain-family", sha256Hex(rawTwo), FUTURE),
    LATER,
  ), null, "family revoked — successor T2 is dead");
  await store.close();
  cleanup();
});

test("sqlite retains a consumed predecessor until its whole family is past validity (#7 replay window)", async () => {
  // Production gives each rotation a FRESH TTL, so a successor outlives its consumed
  // predecessor. Sweeping at the predecessor's own expiry must NOT delete it while a
  // family successor is still valid, or a stolen-token replay can no longer revoke it.
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "window-refresh-one";
  const rawTwo = "window-refresh-two";
  const rawThree = "window-refresh-three";
  // T1 issued at NOW, expires LATER; rotated to T2 which expires FUTURE (fresh TTL).
  await store.saveRefreshToken(refreshToken(rawOne, "window-family", null, LATER));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "window-family", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  // Sweep at MID (LATER < MID < FUTURE): T1 is expired, T2 is still valid.
  await store.sweepExpired(MID);
  assert.notEqual(
    await store.findRefreshToken(sha256Hex(rawOne)),
    null,
    "consumed predecessor retained while a family successor is still valid",
  );
  // The expired-but-retained T1 replay must still revoke the family.
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawThree, "window-family", sha256Hex(rawOne), FUTURE),
    MID,
  ), null, "stolen T1 replay still detected (revokes the family)");
  assert.equal(await store.rotateRefreshToken(
    sha256Hex(rawTwo),
    refreshToken(rawThree, "window-family", sha256Hex(rawTwo), FUTURE),
    MID,
  ), null, "successor T2 now dead (family was revoked)");
  await store.close();
  cleanup();
});

test("sqlite does not sweep a family that still holds a current token", async () => {
  const { file, cleanup } = sqlitePath();
  const store = openSqliteStore(file);
  const rawOne = "active-refresh-one";
  const rawTwo = "active-refresh-two";
  await store.saveRefreshToken(refreshToken(rawOne, "active-family", null, FUTURE));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "active-family", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  await store.sweepExpired(NOW);
  assert.equal(rowCount(file, "oauth_refresh_tokens"), 2, "current tokens retained");
  assert.equal(rowCount(file, "oauth_refresh_token_families"), 1, "active family retained");
  await store.close();
  cleanup();
});

test("tidb fake sweeps consumed refresh tokens past validity and cleans the orphaned family", async () => {
  const fake = new FakeTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  const rawOne = "tidb-gc-one";
  const rawTwo = "tidb-gc-two";
  await store.saveRefreshToken(refreshToken(rawOne, "tidb-gc-family", null, LATER));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "tidb-gc-family", sha256Hex(rawOne), LATER),
    NOW,
  );
  await store.sweepExpired(FUTURE);
  assert.equal(fake.refreshTokens.size, 0, "consumed + expired tokens swept");
  assert.equal(fake.families.size, 0, "orphaned (non-revoked) family cleaned");
});

test("tidb fake retains a consumed predecessor while a family successor is valid (#7 replay window)", async () => {
  const fake = new FakeTidb();
  await migrateTidbStore(fake);
  const store = new TidbStore(fake);
  const rawOne = "tidb-window-one";
  const rawTwo = "tidb-window-two";
  await store.saveRefreshToken(refreshToken(rawOne, "tidb-window-family", null, LATER));
  await store.rotateRefreshToken(
    sha256Hex(rawOne),
    refreshToken(rawTwo, "tidb-window-family", sha256Hex(rawOne), FUTURE),
    NOW,
  );
  // Sweep at MID (LATER < MID < FUTURE): T1 expired but T2 still valid -> T1 retained.
  await store.sweepExpired(MID);
  assert.equal(fake.refreshTokens.size, 2, "consumed predecessor retained while successor is valid");
  assert.ok(fake.refreshTokens.has(sha256Hex(rawOne)), "T1 not swept");
});

function rowCount(file: string, table: string): number {
  const db = new DatabaseSync(file);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: unknown };
  db.close();
  return Number(row.n);
}

function authCode(rawCode: string, expiresAt: string): SaveAuthCodeInput {
  return {
    codeHash: sha256Hex(rawCode),
    clientId: "client-1",
    subject: "subject-1",
    redirectUri: "https://client.test/callback",
    resource: "https://captatum.test",
    scopes: ["fetch:read"],
    codeChallenge: "pkce-challenge",
    codeChallengeMethod: "S256",
    expiresAt,
  };
}

function refreshToken(
  rawToken: string,
  familyId: string,
  previousTokenHash: string | null,
  expiresAt: string,
): SaveRefreshTokenInput {
  return {
    tokenHash: sha256Hex(rawToken),
    familyId,
    previousTokenHash,
    clientId: "client-1",
    subject: "subject-1",
    scopes: ["fetch:read"],
    expiresAt,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlitePath(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "captatum-store-"));
  return {
    file: join(dir, "oauth.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function assertNoRawStrings(file: string, rawStrings: string[]): void {
  const bytes = readFileSync(file);
  for (const raw of rawStrings) {
    assert.equal(bytes.includes(Buffer.from(raw)), false, `raw secret persisted: ${raw}`);
  }
}

function assertNoContentTables(file: string): void {
  const db = new DatabaseSync(file);
  const tables = db.prepare(
    `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
  ).all().map((row) => String((row as { name: unknown }).name));
  db.close();
  assert.deepEqual(tables, [
    "oauth_auth_codes",
    "oauth_consent_jtis",
    "oauth_refresh_token_families",
    "oauth_refresh_tokens",
  ]);
  assert.equal(tables.some((name) => /content|body|cache|page/i.test(name)), false);
}

interface FakeAuthCodeRow {
  code_hash: string;
  client_id: string;
  subject: string;
  redirect_uri: string;
  resource: string;
  scopes_json: string;
  code_challenge: string;
  code_challenge_method: "S256";
  expires_at: string;
}

interface FakeRefreshTokenRow {
  token_hash: string;
  family_id: string;
  previous_token_hash: string | null;
  client_id: string;
  subject: string;
  scopes_json: string;
  expires_at: string;
  consumed_at: string | null;
}

class FakeTidb implements TidbClient {
  readonly authCodes = new Map<string, FakeAuthCodeRow>();
  readonly families = new Map<string, { family_id: string; revoked_at: string | null }>();
  readonly refreshTokens = new Map<string, FakeRefreshTokenRow>();
  readonly executions: Array<{ sql: string; params: unknown[] }> = [];
  readonly txEvents: string[] = [];
  endCalls = 0;
  private snapshot: ReturnType<FakeTidb["clone"]> | null = null;

  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.executions.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE TABLE")) return [{ affectedRows: 0 }, []];
    if (normalized.startsWith("INSERT INTO oauth_auth_codes")) return this.insertAuthCode(params);
    if (normalized.startsWith("SELECT * FROM oauth_auth_codes")) {
      return [[this.authCodes.get(String(params[0]))].filter(Boolean), []];
    }
    if (normalized.startsWith("DELETE FROM oauth_auth_codes")) {
      return [{ affectedRows: this.authCodes.delete(String(params[0])) ? 1 : 0 }, []];
    }
    if (normalized.startsWith("INSERT INTO oauth_refresh_token_families")) {
      return this.upsertFamily(params);
    }
    if (normalized.startsWith("INSERT INTO oauth_refresh_tokens")) {
      return this.insertRefreshToken(params);
    }
    if (normalized.startsWith("SELECT t.*, f.revoked_at")) return this.selectRefreshToken(params);
    if (normalized.startsWith("SELECT token_hash FROM oauth_refresh_tokens")) {
      const token = this.refreshTokens.get(String(params[0]));
      return [token ? [{ token_hash: token.token_hash }] : [], []];
    }
    if (normalized.startsWith("UPDATE oauth_refresh_tokens SET consumed_at")) {
      return this.consumeRefreshToken(params);
    }
    if (normalized.startsWith("DELETE FROM oauth_consent_jtis")) {
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith("DELETE FROM oauth_refresh_tokens WHERE expires_at")) {
      return this.sweepRefreshTokens(params);
    }
    if (normalized.startsWith("DELETE FROM oauth_refresh_token_families")) {
      return this.sweepOrphanedFamilies();
    }
    throw new Error(`Unhandled fake TiDB SQL: ${normalized}`);
  }

  async getConnection(): Promise<FakeTidb> {
    return this;
  }

  async beginTransaction(): Promise<void> {
    this.txEvents.push("begin");
    this.snapshot = this.clone();
  }

  async commit(): Promise<void> {
    this.txEvents.push("commit");
    this.snapshot = null;
  }

  async rollback(): Promise<void> {
    this.txEvents.push("rollback");
    if (this.snapshot) this.restore(this.snapshot);
    this.snapshot = null;
  }

  release(): void {
    this.txEvents.push("release");
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  private insertAuthCode(params: unknown[]): [unknown, unknown] {
    const row: FakeAuthCodeRow = {
      code_hash: String(params[0]),
      client_id: String(params[1]),
      subject: String(params[2]),
      redirect_uri: String(params[3]),
      resource: String(params[4]),
      scopes_json: String(params[5]),
      code_challenge: String(params[6]),
      code_challenge_method: "S256",
      expires_at: String(params[8]),
    };
    if (this.authCodes.has(row.code_hash)) throw new Error("duplicate auth code");
    this.authCodes.set(row.code_hash, row);
    return [{ affectedRows: 1 }, []];
  }

  private upsertFamily(params: unknown[]): [unknown, unknown] {
    const familyId = String(params[0]);
    const existing = this.families.get(familyId);
    if (!existing) {
      this.families.set(familyId, {
        family_id: familyId,
        revoked_at: params.length > 1 ? String(params[1]) : null,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (params.length > 2 && existing.revoked_at === null) existing.revoked_at = String(params[2]);
    return [{ affectedRows: 1 }, []];
  }

  private insertRefreshToken(params: unknown[]): [unknown, unknown] {
    const row: FakeRefreshTokenRow = {
      token_hash: String(params[0]),
      family_id: String(params[1]),
      previous_token_hash: params[2] === null ? null : String(params[2]),
      client_id: String(params[3]),
      subject: String(params[4]),
      scopes_json: String(params[5]),
      expires_at: String(params[6]),
      consumed_at: null,
    };
    if (this.refreshTokens.has(row.token_hash)) throw new Error("duplicate refresh token");
    this.refreshTokens.set(row.token_hash, row);
    return [{ affectedRows: 1 }, []];
  }

  private selectRefreshToken(params: unknown[]): [unknown, unknown] {
    const token = this.refreshTokens.get(String(params[0]));
    if (!token) return [[], []];
    return [[{ ...token, revoked_at: this.families.get(token.family_id)?.revoked_at ?? null }], []];
  }

  private consumeRefreshToken(params: unknown[]): [unknown, unknown] {
    const token = this.refreshTokens.get(String(params[1]));
    if (!token || token.consumed_at !== null) return [{ affectedRows: 0 }, []];
    token.consumed_at = String(params[0]);
    return [{ affectedRows: 1 }, []];
  }

  private sweepRefreshTokens(params: unknown[]): [unknown, unknown] {
    // Mirror the store SQL: retain an expired token whose family still has a valid
    // member (so a stolen-token replay can still revoke the family while a successor lives).
    const cutoff = String(params[0]);
    const familyStillValid = new Set<string>();
    for (const row of this.refreshTokens.values()) {
      if (row.expires_at >= cutoff) familyStillValid.add(row.family_id);
    }
    let deleted = 0;
    for (const [key, row] of [...this.refreshTokens]) {
      if (row.expires_at < cutoff && !familyStillValid.has(row.family_id)) {
        this.refreshTokens.delete(key);
        deleted += 1;
      }
    }
    return [{ affectedRows: deleted }, []];
  }

  private sweepOrphanedFamilies(): [unknown, unknown] {
    const remaining = new Set([...this.refreshTokens.values()].map((row) => row.family_id));
    let deleted = 0;
    for (const key of this.families.keys()) {
      if (!remaining.has(key)) { this.families.delete(key); deleted += 1; }
    }
    return [{ affectedRows: deleted }, []];
  }

  private clone() {
    return {
      authCodes: new Map(this.authCodes),
      families: new Map([...this.families].map(([key, value]) => [key, { ...value }])),
      refreshTokens: new Map([...this.refreshTokens].map(([key, value]) => [key, { ...value }])),
    };
  }

  private restore(snapshot: ReturnType<FakeTidb["clone"]>): void {
    this.authCodes.clear();
    this.families.clear();
    this.refreshTokens.clear();
    for (const [key, value] of snapshot.authCodes) this.authCodes.set(key, value);
    for (const [key, value] of snapshot.families) this.families.set(key, value);
    for (const [key, value] of snapshot.refreshTokens) this.refreshTokens.set(key, value);
  }
}

function assertParameterized(fake: FakeTidb, sensitive: string[]): void {
  for (const execution of fake.executions) {
    if (!execution.sql.startsWith("CREATE TABLE")) {
      assert.match(execution.sql, /\?/);
      assert.notEqual(execution.params.length, 0);
    }
    for (const value of sensitive) assert.equal(execution.sql.includes(value), false);
  }
}

function assertNoRawInFake(fake: FakeTidb, rawStrings: string[]): void {
  const stored = JSON.stringify({
    authCodes: [...fake.authCodes.values()],
    families: [...fake.families.values()],
    refreshTokens: [...fake.refreshTokens.values()],
  });
  for (const raw of rawStrings) assert.equal(stored.includes(raw), false);
}
