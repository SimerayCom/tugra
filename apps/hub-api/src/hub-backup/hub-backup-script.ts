/**
 * Pure builders for backing up the HUB's OWN Postgres (the control-plane DB storing apps/servers/users and
 * encrypted secrets) — distinct from the managed-DB backups in ../backups. hub-api itself has no pg_dump / mc
 * / S3 client (its image is plain node), so like every other upload this runs on the LOCAL ("This machine")
 * agent: it `docker exec`s pg_dump inside the compose postgres container and streams the dump through the
 * SHARED gzip→gpg→sink pipeline (buildDumpUploadScript). The dump is ALWAYS gpg-encrypted (see
 * hubBackupPassphrase) because it contains every tenant's data + secrets.
 */

import { createHmac } from "node:crypto";
import { GPG_PREFLIGHT, buildDumpUploadScript, decodeChain, storedObjectSourceCmd } from "../backups/backup-script";
import { MC_INSTALL, type DestinationSpec } from "../backups/destination";

/** Storage namespace (S3 object prefix / local subdir) for hub backups → /etc/tugra/backups/hub/. */
export const HUB_NS = "hub";

/** The compose project the hub stack runs under (docker-compose.yml `name: tugra`); overridable via env. */
export function hubComposeProject(): string {
  return process.env.COMPOSE_PROJECT_NAME || "tugra";
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Extract the Postgres user + database name from the hub's DATABASE_URL (password is deliberately ignored —
 *  the dump uses the container's trusted local socket, so no password ever reaches argv). */
export function parseHubDbTarget(databaseUrl: string): { user: string; db: string } {
  const u = new URL(databaseUrl);
  const user = decodeURIComponent(u.username || "postgres");
  const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || user;
  return { user, db };
}

/** docker exec pg_dump inside the compose postgres container, resolved by compose labels (no hard-coded
 *  container name exists in the repo). Single pipeline element so it composes with the shared `| mc pipe`.
 *  Same flags as the managed-DB POSTGRES dump, so a hub dump restores with the documented pg_restore. */
export function hubDumpCommand(target: { user: string; db: string; project: string }): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(target.project)) {
    throw new Error("invalid compose project name"); // interpolated into a docker filter — guard injection
  }
  const cid = `"$(docker ps -q --filter label=com.docker.compose.project=${target.project} --filter label=com.docker.compose.service=postgres | head -n1)"`;
  return `docker exec ${cid} pg_dump -Fc -Z0 --no-owner --no-acl -U ${shq(target.user)} ${shq(target.db)}`;
}

/** Fail fast (exit 3) with a readable message when no hub postgres container is found — e.g. an external
 *  DATABASE_URL, where the in-app scheduled backup can't run (the operator uses their provider's backups). */
export function hubPgPrelude(project: string): string {
  const cid = `$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=postgres | head -n1)`;
  return `[ -n "${cid}" ] || { echo "tugra: hub postgres container not found (external DATABASE_URL? use your provider's backups)" >&2; exit 3; }`;
}

/** A hub-backup gpg passphrase derived from SECRETS_ENCRYPTION_KEY. We DON'T use the destination's own
 *  encryptionKey: it lives inside the DB being backed up, so a lost hub could never decrypt its own backup.
 *  SECRETS_ENCRYPTION_KEY is already mandatory for disaster recovery (it decrypts the dump's own secrets),
 *  so restoring needs nothing extra. One-way + domain-separated from the libsodium secretbox key. */
export function hubBackupPassphrase(secretsKey: string): string {
  return createHmac("sha256", secretsKey).update("tugra-hub-backup-v1").digest("hex");
}

/** Force the destination to gpg-encrypt with the derived hub passphrase, whatever its own toggle says. */
export function hubDest(spec: DestinationSpec, passphrase: string): DestinationSpec {
  return { ...spec, encryption: { enabled: true, key: passphrase } };
}

/** Final object/file name: `tugra-hub-<ts>.dump.gz.gpg`. */
export function hubBackupFilename(ts: string): string {
  return `tugra-hub-${ts}.dump.gz.gpg`;
}

/** The full hub-backup script: existence-guard prelude → pg_dump → gzip → gpg → sink (S3 mc pipe or LOCAL file). */
export function buildHubBackupScript(target: { user: string; db: string; project: string }, filename: string, dest: DestinationSpec): string {
  return buildDumpUploadScript(hubDumpCommand(target), HUB_NS, filename, dest, hubPgPrelude(target.project));
}

// ───────────────────────────── restore drill ─────────────────────────────


/** Tables the drill counts after the restore; a fixed allow-list (the names are interpolated into SQL). */
export const DRILL_TABLES = ["User", "Team", "Server", "Application", "Database", "BackupDestination", "Deployment"] as const;

/**
 * Restore the stored hub dump into a THROWAWAY Postgres container on the local agent and print marker lines the hub
 * parses (never data): `TUGRA_DRILL rc=<pg_restore exit> tables=<public tables>` and `TUGRA_DRILL_COUNT <table> <rows>`.
 * The container has no network, runs the same image as the hub's own postgres, and is removed on every exit path.
 */
export function buildHubDrillScript(target: { project: string }, filename: string, dest: DestinationSpec): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(target.project)) throw new Error("invalid compose project name");
  const decode = decodeChain(dest, storedObjectSourceCmd(dest, HUB_NS, filename), { gzip: true });
  const lines = ["set -e", "set -o pipefail", GPG_PREFLIGHT];
  if (dest.type === "S3" && dest.s3) lines.push(MC_INSTALL);
  lines.push(
    `SRC=$(docker ps -q --filter label=com.docker.compose.project=${target.project} --filter label=com.docker.compose.service=postgres | head -n1)`,
    `[ -n "$SRC" ] || { echo "tugra: hub postgres container not found" >&2; exit 3; }`,
    `IMG=$(docker inspect -f '{{.Config.Image}}' "$SRC")`,
    `NAME="tugra-drill-$$"`,
    `trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT`,
    `docker run -d --rm --name "$NAME" --network none -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill "$IMG" >/dev/null`,
    `for i in $(seq 1 90); do docker exec "$NAME" pg_isready -U postgres -d drill >/dev/null 2>&1 && break; sleep 1; done`,
    `docker exec "$NAME" pg_isready -U postgres -d drill >/dev/null`,
    "set +e",
    `${decode} | docker exec -i "$NAME" pg_restore --no-owner --no-acl -U postgres -d drill`,
    "RC=$?",
    `T=$(docker exec "$NAME" psql -U postgres -d drill -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo -1)`,
    `echo "TUGRA_DRILL rc=$RC tables=$T"`,
    ...DRILL_TABLES.map((t) => `echo "TUGRA_DRILL_COUNT ${t} $(docker exec "$NAME" psql -U postgres -d drill -tA -c 'SELECT count(*) FROM "${t}"' 2>/dev/null || echo -1)"`),
    "exit 0",
  );
  return lines.join("\n");
}

export interface DrillResult {
  ok: boolean;
  tables: number;
  checks: Record<string, number>;
  rc: number | null;
  reason: string | null;
}

/**
 * Judge the marker lines. The restore passes when the dump produced tables, EVERY core table exists (a count of -1 means
 * a truncated or damaged dump) and the account tables hold rows: a hub always has at least one user and one team.
 * `pg_restore` exits 1 for ignored warnings and for fatal errors alike, so its code alone cannot decide; an exit above 1
 * is a failure. A cut output (no marker) is a failure, never a pass.
 */
export function parseDrillOutput(output: string, exitCode: number): DrillResult {
  const fail = (reason: string, extra: Partial<DrillResult> = {}): DrillResult => ({ ok: false, tables: 0, checks: {}, rc: null, reason, ...extra });
  if (exitCode !== 0) return fail("script-failed");
  const head = /^TUGRA_DRILL rc=(\d+) tables=(-?\d+)$/m.exec(output);
  if (!head) return fail("no-marker");
  const rc = Number(head[1]);
  const tables = Number(head[2]);
  const checks: Record<string, number> = {};
  for (const m of output.matchAll(/^TUGRA_DRILL_COUNT (\w+) (-?\d+)$/gm)) {
    if ((DRILL_TABLES as readonly string[]).includes(m[1])) checks[m[1]] = Number(m[2]);
  }
  if (tables < 1) return fail("no-tables", { tables: Math.max(tables, 0), checks, rc });
  if (rc > 1) return fail("restore-failed", { tables, checks, rc });
  if (DRILL_TABLES.some((t) => !(checks[t] >= 0))) return fail("missing-tables", { tables, checks, rc });
  if (!(checks.User >= 1) || !(checks.Team >= 1)) return fail("empty-accounts", { tables, checks, rc });
  return { ok: true, tables, checks, rc, reason: null };
}
