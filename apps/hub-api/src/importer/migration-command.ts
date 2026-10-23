import { BadRequestException } from "@nestjs/common";
import { isMigrationToken } from "./migration-token";

// The hub base URL is interpolated into a shell command the user pastes into a terminal on the SOURCE host.
// When HUB_PUBLIC_URL is unset the base derives from the request Host / X-Forwarded-* headers, which are
// attacker-controllable — so a forged `Host: evil;rm -rf /` must never reach the shell. Allow only an
// http(s) origin with an optional port and a safe path; reject anything with shell metacharacters.
const SAFE_BASE_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

/** Throw 400 unless `base` is a shell-safe http(s) origin — call BEFORE minting so a bad base never leaves a token behind. */
export function assertSafeBase(base: string): void {
  if (!SAFE_BASE_RE.test(base)) {
    throw new BadRequestException("hub public URL is not safe to embed in a shell command — set HUB_PUBLIC_URL");
  }
}

/** The one-line migrator bootstrap. The token rides the ENVIRONMENT of the receiving `sh` (the `VAR=val cmd`
 *  prefix binds to `sh` only, so curl never sees it and it is never on any argv — migrator.sh forwards it with
 *  a bare `-e TUGRA_MIGRATION_TOKEN`). `--hub` is the HTTP base (artifacts stream over the REST ingest API,
 *  not the agent ws). The token charset [A-Za-z0-9_-] is shell-safe, so it needs no quoting. */
export function buildMigrationCommand(token: string, base: string): string {
  if (!isMigrationToken(token)) throw new BadRequestException("invalid migration token");
  assertSafeBase(base);
  return `curl -fsSL ${base}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${token} sh -s -- --hub ${base}`;
}

/** The same command with a literal <TOKEN> placeholder — for the read-only GET (the raw token is hashed at
 *  rest and unrecoverable after mint, so the live command can only be shown once, from the mint response). */
export function buildMigrationCommandTemplate(base: string): string {
  assertSafeBase(base);
  return `curl -fsSL ${base}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=<TOKEN> sh -s -- --hub ${base}`;
}
