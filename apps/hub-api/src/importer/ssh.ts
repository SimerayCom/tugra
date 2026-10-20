import { isIP } from "node:net";
import { isBlockedIp } from "./sources/ssrf-guard";

/**
 * SSH target safety + the runner contract for the importer's data-plane (dump a source DB / tar a volume on
 * the Coolify host and stream it to Tugra). The host is USER-SUPPLIED, so the same SSRF rule as the HTTP
 * client applies: a loopback/link-local/metadata target is refused (private ranges stay allowed — a
 * self-hosted Coolify is usually internal). The concrete SshRunner is provided separately; this module holds the target validation and the runner contract.
 */

export interface SshConnectionConfig {
  host: string;
  port: number; // default 22
  username: string;
  privateKey: string; // PEM, stored encrypted at rest; decrypted in memory for the connection only
  passphrase?: string;
}

// A DNS hostname: dot-separated labels, each starting AND ending alphanumeric (so a leading '-' can never be
// read as an ssh option like -J/ProxyJump), '_'/'-' allowed inside. IP literals are handled separately via isIP.
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Validate an SSH target up front: a bare host (not a URL), a valid port, and — for an IP literal — not a
 *  blocked address. Also rejects an ssh-option-shaped host (leading '-') and a numeric IPv4-DISGUISE
 *  (decimal 2130706433, short 127.1, hex 0x7f…, octal 0177…) that isIP doesn't recognise but the resolver
 *  would map to a blocked address — so the guard never relies solely on the connect-time resolve check. A
 *  real DNS hostname is additionally re-checked at connect time (the runner validates every resolved
 *  address before connecting, closing DNS-rebinding, exactly like the HTTP client's guardedLookup). */
export function assertAllowedSshTarget(host: string, port?: number): { host: string; port: number } {
  const h = (host ?? "").trim().replace(/^\[|\]$/g, "");
  const p = port ?? 22;
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("invalid SSH port");
  if (!h || h.length > 255) throw new Error("invalid SSH host");

  if (isIP(h) !== 0) {
    if (isBlockedIp(h)) throw new Error("the SSH host is a blocked (loopback/link-local/metadata) address");
    return { host: h, port: p };
  }
  // Not a valid IP → must be a well-formed DNS hostname with a NON-numeric final label (a real TLD is never
  // all-digits; a hex/decimal single label is an IPv4-disguise, not a hostname).
  const lastLabel = h.split(".").pop() ?? "";
  if (!HOST_RE.test(h) || /^0x[0-9a-f]+$/i.test(h) || /^[0-9]+$/.test(lastLabel)) {
    throw new Error("invalid SSH host");
  }
  return { host: h, port: p };
}

/** One remote command's live output. `stdout` streams the dump/tar to Tugra; `result` resolves when it ends. */
export interface SshExec {
  stdout: NodeJS.ReadableStream;
  result: Promise<{ exitCode: number; stderrTail: string }>;
}

/**
 * Runs commands on one source host over SSH. The implementation pins the connection to an SSRF-validated
 * resolved address, authenticates with the key only (no agent/password prompts), and bounds the session
 * (connect timeout + overall deadline). Constructed with its {@link SshConnectionConfig} already supplied.
 */
export interface SshRunner {
  exec(command: string): Promise<SshExec>;
  close(): Promise<void>;
}
