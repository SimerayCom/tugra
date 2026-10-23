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

/** The one-line migrator bootstrap, mirroring the agent installer (servers.service.ts buildInstallCommand).
 *  `--hub` is the HTTP base (the migrator streams artifacts over the REST ingest API, not the agent ws). */
export function buildMigrationCommand(token: string, base: string): string {
  if (!isMigrationToken(token)) throw new BadRequestException("invalid migration token");
  assertSafeBase(base);
  return `curl -fsSL ${base}/install/migrator.sh | sh -s -- --hub ${base} --token ${token}`;
}

/** The same command with a literal <TOKEN> placeholder — for the read-only GET (the raw token is hashed at
 *  rest and unrecoverable after mint, so the live command can only be shown once, from the mint response). */
export function buildMigrationCommandTemplate(base: string): string {
  assertSafeBase(base);
  return `curl -fsSL ${base}/install/migrator.sh | sh -s -- --hub ${base} --token <TOKEN>`;
}
