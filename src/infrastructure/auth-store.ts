// Build the mcp-sso OAuth-state StorePort for the hosted flavor. The DEFAULT backend
// is SQLite (node:sqlite, a single file, no server) so a hosted deploy needs no
// database — one-click deploys (Railway / EC2 / Mac mini) need no external state. TiDB
// (MySQL-compatible, via `mcp-sso/store/mysql`) is the optional scale path: set
// `TIDB_HOST` to opt in (TLS required — SQLSTORE-1). `mysql2` is lazy-imported only
// when TiDB is selected, so a SQLite-only deploy never loads it. Replaces the removed
// `infrastructure/store-selection.ts`; the store impls + schema are now mcp-sso's.
import { accessSync, constants, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import type { StorePort } from "mcp-sso";
import { openSqliteStore } from "mcp-sso/store/sqlite";
import { config } from "../config.ts";

export type AuthStoreBackend = "tidb" | "sqlite";

export interface HostedAuthStore {
  store: StorePort;
  backend: AuthStoreBackend;
}

/** Build the hosted OAuth-state store. SQLite by default; TiDB when `TIDB_HOST` is set. */
export async function createHostedAuthStore(): Promise<HostedAuthStore> {
  if (config.tidb.host().trim()) {
    // SQLSTORE-1: OAuth token hashes + the DB password must not cross the wire in
    // plaintext, so TiDB requires TLS regardless of NODE_ENV.
    const sslCa = config.tidb.sslCa();
    if (!sslCa) {
      throw new Error("TiDB store requires TIDB_SSL_CA (TLS) — provide a CA or unset TIDB_HOST to use SQLite");
    }
    const { createMysqlStore } = await import("mcp-sso/store/mysql");
    const store = await createMysqlStore({
      host: config.tidb.host(),
      port: config.tidb.port(),
      database: config.tidb.database(),
      user: config.tidb.user(),
      password: config.tidb.password(),
      waitForConnections: true,
      connectionLimit: 5,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true, ca: sslCa },
    });
    return { store, backend: "tidb" };
  }
  const sqlitePath = config.store.sqlitePath();
  ensureParentDir(sqlitePath);
  return { store: openSqliteStore(sqlitePath), backend: "sqlite" };
}

/** Self-diagnosing message for the unwritable-SQLite-dir boot failure (#85). Under the
 *  hosted image's USER node the container's /app is root-owned, so the default
 *  ./data/captatum.sqlite path is not writable and mkdirSync throws a cryptic EACCES.
 *  This turns it into a message that names the resolved dir + the CAPTATUM_SQLITE_PATH
 *  fix. Exported so the wording can be unit-tested. */
export function unwritableStoreDirMessage(file: string, code: string, user: string, cwd: string): string {
  const absParent = dirname(resolve(cwd, file));
  return (
    `SQLite store dir is not writable: cannot create ${absParent} (from CAPTATUM_SQLITE_PATH=${file}; ` +
    `running as ${user}, cwd ${cwd}, os error ${code}). Under the hosted image's USER node the ` +
    `container's /app is root-owned and not writable — set CAPTATUM_SQLITE_PATH to a writable ` +
    `mounted volume (e.g. /data/captatum.sqlite).`
  );
}

function ensureParentDir(file: string): void {
  const parent = dirname(file);
  if (!parent || parent === ".") return;
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    // Re-wrap only the "not writable" family so a misconfigured path (ENOTDIR, EEXIST, …)
    // surfaces unchanged instead of being masked as a permissions problem.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw err;
    throw new Error(unwritableStoreDirMessage(file, code ?? "UNKNOWN", safeUser(), process.cwd()));
  }
  // mkdirSync is a no-op when the parent already exists, so a pre-created / mounted dir
  // with bad ownership would slip past the catch above and surface later as SQLite's
  // generic "unable to open database file". Probe write access so that case also gets the
  // actionable message (#85 review).
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(unwritableStoreDirMessage(file, "EACCES", safeUser(), process.cwd()));
  }
}

function safeUser(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}
