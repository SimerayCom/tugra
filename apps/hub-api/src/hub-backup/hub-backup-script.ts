/**
 * Pure builders for backing up the HUB's OWN Postgres (the control-plane DB storing apps/servers/users and
 * encrypted secrets) — distinct from the managed-DB backups in ../backups. hub-api itself has no pg_dump / mc
 * / S3 client (its image is plain node), so like every other upload this runs on the LOCAL ("This machine")
 * agent: it `docker exec`s pg_dump inside the compose postgres container and streams the dump through the
 * SHARED gzip→gpg→sink pipeline (buildDumpUploadScript). The dump is ALWAYS gpg-encrypted (see
 * hubBackupPassphrase) because it contains every tenant's data + secrets.
 */

import { createHmac } from "node:crypto";
import { buildDumpUploadScript } from "../backups/backup-script";
import type { DestinationSpec } from "../backups/destination";

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
