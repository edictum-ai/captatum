import mysql from "mysql2/promise";
import type { PoolOptions } from "mysql2/promise";
import type { AuthCodeRecord, RefreshTokenRecord, SaveAuthCodeInput, SaveRefreshTokenInput, StorePort } from "../../application/ports/store.ts";
import { assertSha256Hex, assertUtcIsoTimestamp } from "../../application/ports/store.ts";
import type { AuthCodeRow, RefreshTokenRow } from "./records.ts";
import { authCodeFromRow, refreshTokenFromRow, validateAuthCode, validateRefreshToken, validateRotation } from "./records.ts";
import { migrateTidbStore } from "./schema.ts";
import type { TidbClient, TidbExecutor, TidbTransaction } from "./types.ts";

export class TidbStore implements StorePort {
  private closed = false;
  private readonly client: TidbClient;

  constructor(client: TidbClient) {
    this.client = client;
  }

  async saveAuthCode(input: SaveAuthCodeInput): Promise<void> {
    this.ensureOpen();
    validateAuthCode(input);
    await this.client.execute(`INSERT INTO oauth_auth_codes (
      code_hash, client_id, subject, redirect_uri, resource, scopes_json,
      code_challenge, code_challenge_method, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, authCodeParams(input));
  }

  async consumeAuthCode(codeHash: string, nowIso: string): Promise<AuthCodeRecord | null> {
    this.ensureOpen();
    assertSha256Hex(codeHash, "codeHash");
    assertUtcIsoTimestamp(nowIso, "nowIso");
    return await this.transaction(async (tx) => {
      const row = await one<AuthCodeRow>(
        tx,
        `SELECT * FROM oauth_auth_codes WHERE code_hash = ? FOR UPDATE`,
        [codeHash],
      );
      if (!row) return null;
      await tx.execute(`DELETE FROM oauth_auth_codes WHERE code_hash = ?`, [codeHash]);
      return row.expires_at > nowIso ? authCodeFromRow(row) : null;
    });
  }

  async consumeConsentJti(jti: string, expiresAtIso: string): Promise<boolean> {
    this.ensureOpen();
    assertUtcIsoTimestamp(expiresAtIso, "expiresAtIso");
    // OAUTH-2: INSERT IGNORE inserts only on the first use; a replay affects 0 rows.
    const [result] = await this.client.execute(
      `INSERT IGNORE INTO oauth_consent_jtis (jti, expires_at) VALUES (?, ?)`,
      [jti, expiresAtIso],
    );
    return affectedRows(result) > 0;
  }

  async saveRefreshToken(input: SaveRefreshTokenInput): Promise<void> {
    this.ensureOpen();
    validateRefreshToken(input);
    await this.transaction(async (tx) => {
      await ensureFamily(tx, input.familyId);
      await insertRefreshToken(tx, input);
    });
  }

  async rotateRefreshToken(
    tokenHash: string,
    next: SaveRefreshTokenInput,
    nowIso: string,
  ): Promise<RefreshTokenRecord | null> {
    this.ensureOpen();
    validateRotation(tokenHash, next, nowIso);
    return await this.transaction(async (tx) => {
      const row = await one<RefreshTokenRow>(tx, `SELECT t.*, f.revoked_at
        FROM oauth_refresh_tokens t
        JOIN oauth_refresh_token_families f ON f.family_id = t.family_id
        WHERE t.token_hash = ? FOR UPDATE`, [tokenHash]);
      if (!row || row.revoked_at !== null) return null;
      if (row.consumed_at !== null) {
        await revokeFamily(tx, row.family_id, nowIso);
        return null;
      }
      if (row.expires_at <= nowIso || next.familyId !== row.family_id) return null;
      if (await one(tx, `SELECT token_hash FROM oauth_refresh_tokens WHERE token_hash = ?`, [
        next.tokenHash,
      ])) return null;
      const [updated] = await tx.execute(
        `UPDATE oauth_refresh_tokens SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL`,
        [nowIso, tokenHash],
      );
      if (affectedRows(updated) !== 1) return null;
      await insertRefreshToken(tx, nextFromRow(next, row));
      return refreshTokenFromRow(row);
    });
  }

  async revokeRefreshTokenFamily(familyId: string, revokedAtIso: string): Promise<void> {
    this.ensureOpen();
    assertUtcIsoTimestamp(revokedAtIso, "revokedAtIso");
    await this.transaction(async (tx) => revokeFamily(tx, familyId, revokedAtIso));
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    this.ensureOpen();
    return await this.transaction(async (tx) => {
      const row = await one<RefreshTokenRow>(tx,
        `SELECT t.*, f.revoked_at FROM oauth_refresh_tokens t
         JOIN oauth_refresh_token_families f ON f.family_id = t.family_id
         WHERE t.token_hash = ?`, [tokenHash]);
      return row ? refreshTokenFromRow(row) : null;
    });
  }

  async sweepExpired(nowIso: string): Promise<void> {
    this.ensureOpen();
    assertUtcIsoTimestamp(nowIso, "nowIso");
    await this.transaction(async (tx) => {
      await tx.execute(`DELETE FROM oauth_auth_codes WHERE expires_at < ?`, [nowIso]);
      await tx.execute(`DELETE FROM oauth_consent_jtis WHERE expires_at < ?`, [nowIso]);
      // Retain a consumed token until its whole FAMILY is past validity: a successor's
      // expires_at = rotation + refresh TTL outlives the consumed predecessor, so sweeping
      // at the predecessor's own expiry would drop the replay signal while the successor is
      // still live. Materialized derived table, NOT a self-referencing NOT EXISTS — MySQL/TiDB
      // reject deleting a table referenced in its own subquery (ER_UPDATE_TABLE_USED).
      await tx.execute(`DELETE FROM oauth_refresh_tokens WHERE expires_at < ? AND family_id NOT IN (SELECT family_id FROM (SELECT DISTINCT family_id FROM oauth_refresh_tokens WHERE expires_at >= ?) AS live_families)`, [nowIso, nowIso]);
      // Clean every orphaned family (not only revoked ones) once it has no tokens left.
      await tx.execute(`DELETE FROM oauth_refresh_token_families WHERE family_id NOT IN (SELECT DISTINCT family_id FROM oauth_refresh_tokens)`);
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.client.end();
      this.closed = true;
    }
  }

  private async transaction<T>(fn: (tx: TidbTransaction) => Promise<T>): Promise<T> {
    // Acquire the connection, then run begin/commit/rollback inside the try so a
    // throw in beginTransaction() still hits finally{release()}. Without this, a
    // handful of begin failures permanently exhaust the connectionLimit:5 pool and
    // every OAuth store call hangs (auth outage). `begun` guards rollback() so we
    // don't call it on a connection with no open transaction (which would throw and
    // shadow the original error); the inner try swallows a cleanup-time rollback
    // failure so the caller still sees the real error.
    const tx = await this.client.getConnection();
    let begun = false;
    try {
      await tx.beginTransaction();
      begun = true;
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      if (begun) {
        try { await tx.rollback(); } catch { /* swallow cleanup error; throw original */ }
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Store is closed");
  }
}

export async function createTidbStore(options: PoolOptions): Promise<TidbStore> {
  const client = mysql.createPool(options) as unknown as TidbClient;
  await migrateTidbStore(client);
  return new TidbStore(client);
}

function authCodeParams(input: SaveAuthCodeInput): unknown[] {
  return [
    input.codeHash,
    input.clientId,
    input.subject,
    input.redirectUri,
    input.resource,
    JSON.stringify(input.scopes),
    input.codeChallenge,
    input.codeChallengeMethod,
    input.expiresAt,
  ];
}

async function insertRefreshToken(db: TidbExecutor, input: SaveRefreshTokenInput): Promise<void> {
  await db.execute(`INSERT INTO oauth_refresh_tokens (
    token_hash, family_id, previous_token_hash, client_id, subject, scopes_json,
    expires_at, consumed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [
    input.tokenHash,
    input.familyId,
    input.previousTokenHash,
    input.clientId,
    input.subject,
    JSON.stringify(input.scopes),
    input.expiresAt,
  ]);
}

function nextFromRow(input: SaveRefreshTokenInput, row: RefreshTokenRow): SaveRefreshTokenInput {
  return {
    ...input,
    clientId: row.client_id,
    subject: row.subject,
    scopes: JSON.parse(row.scopes_json) as string[],
  };
}

async function ensureFamily(db: TidbExecutor, familyId: string): Promise<void> {
  await db.execute(
    `INSERT INTO oauth_refresh_token_families (family_id, revoked_at)
      VALUES (?, NULL) ON DUPLICATE KEY UPDATE family_id = family_id`,
    [familyId],
  );
}

async function revokeFamily(db: TidbExecutor, familyId: string, revokedAtIso: string): Promise<void> {
  await db.execute(
    `INSERT INTO oauth_refresh_token_families (family_id, revoked_at)
      VALUES (?, ?) ON DUPLICATE KEY UPDATE revoked_at = COALESCE(revoked_at, ?)`,
    [familyId, revokedAtIso, revokedAtIso],
  );
}

async function one<T>(db: TidbExecutor, sql: string, params?: unknown[]): Promise<T | undefined> {
  const [rows] = await db.execute(sql, params);
  return Array.isArray(rows) ? rows[0] as T | undefined : undefined;
}

function affectedRows(result: unknown): number {
  if (typeof result !== "object" || result === null || !("affectedRows" in result)) return 0;
  return Number((result as { affectedRows: unknown }).affectedRows);
}
