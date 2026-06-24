/**
 * OAuth state storage port (hosted flavor only). Stores auth-code records and
 * refresh-token records — all hashed — behind a swappable port with one
 * implementation per flavor: TiDB (hosted) or node:sqlite (local binary).
 *
 * No storage for fetched content; the service is stateless otherwise.
 * See docs/contracts.md "Storage".
 */

export interface AuthCodeRecord {
  /** sha256(raw code). */
  codeHash: string;
  clientId: string;
  subject: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: string;
}

export interface RefreshTokenRecord {
  /** sha256(raw token). */
  tokenHash: string;
  /** Family id; replay revokes the whole family. */
  familyId: string;
  /** sha256 of the previous token in the family (chain root has none). */
  previousTokenHash: string | null;
  clientId: string;
  subject: string;
  scopes: string[];
  expiresAt: string;
}

export interface SaveAuthCodeInput {
  codeHash: string;
  clientId: string;
  subject: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: string;
}

export interface SaveRefreshTokenInput {
  tokenHash: string;
  familyId: string;
  previousTokenHash: string | null;
  clientId: string;
  subject: string;
  scopes: string[];
  expiresAt: string;
}

export interface StorePort {
  saveAuthCode(input: SaveAuthCodeInput): Promise<void>;
  /** Single-use; removes on read. Returns null if missing/expired. */
  consumeAuthCode(codeHash: string, nowIso: string): Promise<AuthCodeRecord | null>;
  saveRefreshToken(input: SaveRefreshTokenInput): Promise<void>;
  /** Returns the record (and rotates), or null if missing/expired/revoked. */
  rotateRefreshToken(
    tokenHash: string,
    next: SaveRefreshTokenInput,
    nowIso: string,
  ): Promise<RefreshTokenRecord | null>;
  /** Revoke every token in the family. Replay detection path. */
  revokeRefreshTokenFamily(familyId: string, revokedAtIso: string): Promise<void>;
  /** Find a refresh token by its hash, or null if it does not exist. */
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  close(): Promise<void>;
}

export class StoreInputError extends Error {
  readonly code = "invalid_store_input";
}

export function assertSha256Hex(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new StoreInputError(`${label} must be a SHA-256 hex digest`);
  }
}

export function assertUtcIsoTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new StoreInputError(`${label} must be a UTC ISO timestamp`);
  }
}
