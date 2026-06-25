import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SaveAuthCodeInput, SaveRefreshTokenInput } from "../src/application/ports/store.ts";
import { StoreInputError } from "../src/application/ports/store.ts";
import { openSqliteStore } from "../src/infrastructure/sqlite/index.ts";
import { migrateTidbStore, TidbStore } from "../src/infrastructure/tidb/index.ts";
import type { TidbClient } from "../src/infrastructure/tidb/index.ts";

const NOW = "2026-06-16T12:00:00.000Z";
const LATER = "2026-06-16T12:05:00.000Z";
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
