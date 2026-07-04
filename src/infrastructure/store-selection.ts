// Composition for the hosted flavor's OAuth-state StorePort. The DEFAULT backend
// is SQLite (node:sqlite, a single file, no server) so the hosted flavor boots
// with zero external dependencies — one-click deploys (Railway / EC2 / Mac Mini)
// need no database. TiDB (MySQL-compatible) remains the optional scale path:
// set TIDB_HOST to select it. SQLSTORE-1 still applies to the TiDB path (TLS
// required); SQLite is a local file so there is no wire to protect.
//
// The backend choice is a pure function (testable without a DB); creation is a
// factory that lazy-imports mysql2 only when TiDB is selected, so a SQLite-only
// deploy never loads it.
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import type { StorePort } from "../application/ports/store.ts";
import { openSqliteStore } from "./sqlite/index.ts";

export type StoreBackend = "tidb" | "sqlite";

/** SQLite is the default; TiDB is opted into by setting TIDB_HOST. */
export function chooseStoreBackend(tidbHost: string): StoreBackend {
  return tidbHost.trim() ? "tidb" : "sqlite";
}

export interface HostedStoreOptions {
  tidb: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    sslCa: string;
  };
  sqlitePath: string;
}

export interface HostedStore {
  store: StorePort;
  backend: StoreBackend;
}

export async function createHostedStore(options: HostedStoreOptions): Promise<HostedStore> {
  const backend = chooseStoreBackend(options.tidb.host);
  if (backend === "tidb") {
    // SQLSTORE-1: OAuth token hashes + the DB password must not cross the wire in
    // plaintext, so TiDB requires TLS regardless of NODE_ENV.
    if (!options.tidb.sslCa) {
      throw new Error("TiDB store requires TIDB_SSL_CA (TLS) — set CAPTATUM_SQLITE_PATH-less config or provide a CA");
    }
    const { createTidbStore } = await import("./tidb/index.ts");
    const store = await createTidbStore({
      host: options.tidb.host,
      port: options.tidb.port,
      database: options.tidb.database,
      user: options.tidb.user,
      password: options.tidb.password,
      waitForConnections: true,
      connectionLimit: 5,
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true, ca: options.tidb.sslCa },
    });
    return { store, backend };
  }
  ensureParentDir(options.sqlitePath);
  return { store: openSqliteStore(options.sqlitePath), backend };
}

/**
 * Self-diagnosing message for the unwritable-SQLite-dir boot failure (#85). Under the hosted
 * image's USER node the container's /app is root-owned, so the default ./data/captatum.sqlite path
 * is not writable and mkdirSync throws a cryptic EACCES. This turns it into a message that names
 * the resolved dir + the CAPTATUM_SQLITE_PATH fix. Exported so the wording is unit-tested.
 */
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
}

function safeUser(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}
