import type { TidbExecutor } from "./types.ts";

export const TIDB_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code_hash CHAR(64) NOT NULL PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    code_challenge VARCHAR(255) NOT NULL,
    code_challenge_method VARCHAR(16) NOT NULL,
    expires_at VARCHAR(32) NOT NULL,
    KEY idx_oauth_auth_codes_expires_at (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_refresh_token_families (
    family_id VARCHAR(128) NOT NULL PRIMARY KEY,
    revoked_at VARCHAR(32) NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    family_id VARCHAR(128) NOT NULL,
    previous_token_hash CHAR(64) NULL,
    client_id VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at VARCHAR(32) NOT NULL,
    consumed_at VARCHAR(32) NULL,
    KEY idx_oauth_refresh_tokens_family_id (family_id),
    KEY idx_oauth_refresh_tokens_expires_at (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_consent_jtis (
    jti CHAR(48) NOT NULL PRIMARY KEY,
    expires_at VARCHAR(32) NOT NULL,
    KEY idx_oauth_consent_jtis_expires_at (expires_at)
  )`,
];

export async function migrateTidbStore(executor: TidbExecutor): Promise<void> {
  for (const migration of TIDB_MIGRATIONS) {
    await executor.execute(migration);
  }
}
