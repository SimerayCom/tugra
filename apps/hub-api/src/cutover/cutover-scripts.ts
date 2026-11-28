import { shq } from "../deploy/deploy-script";

export { parseCutoverProbeMarkers, parseAcmeDiagMarkers } from "./cutover.logic";

const PROXY = "tugra-proxy";
const ACME_DIR = "/etc/tugra/letsencrypt";
export const ACME_FILE = `${ACME_DIR}/acme.json`;
/** acme.json larger than this is refused (the hub reads it back in ACME_CHUNK_BYTES slices, at most ~57 commands). */
export const ACME_READ_CAP = 2 * 1024 * 1024;

/**
 * Agent-side loopback probe: the proxy's routing for `host` seen from the server itself (curl --resolve to
 * 127.0.0.1). It verifies the router, NOT public reachability, and prints only a status marker, never a body, so
 * app output can never forge a marker. host/path pass through shq() after the DTO regex has limited them.
 * 127.0.0.1 is the BOX only on the host's network: the agent's shell is a container on the default bridge, where it is the
 * agent itself. Send this through `onHostNetwork` (or `world.exec(..., { hostNetwork: true })`), never as it is.
 */
export function buildCutoverLoopbackProbeScript(o: { host: string; path: string }): string {
  return [
    "set -u",
    `H=${shq(o.host)}; P=${shq(o.path)}`,
    'if command -v curl >/dev/null 2>&1; then',
    `  code=$(curl -ksS -o /dev/null -m 6 -w '%{http_code}' --resolve "$H:443:127.0.0.1" "https://$H$P" 2>/dev/null) || code=000`,
    "elif command -v wget >/dev/null 2>&1; then",
    `  code=$(wget -q --no-check-certificate -T 6 -O /dev/null --server-response "https://127.0.0.1$P" --header "Host: $H" 2>&1 | awk '/HTTP\\//{c=$2} END{print c+0}')`,
    "else",
    '  echo "TUGRA_CUTOVER_PROBE=unavailable"; exit 0',
    "fi",
    `printf 'TUGRA_CUTOVER_PROBE status=%03d\\n' "\${code:-0}"`,
  ].join("\n");
}

/**
 * Diagnostic only (never decides readiness): does acme.json already hold a cert for the host, and what is the
 * last ACME complaint in the proxy log, stripped to printable ASCII and capped. The host is DTO-validated and
 * shq()-quoted.
 */
export function buildAcmeDiagScript(host: string): string {
  return [
    "set -u",
    `H=${shq(host)}`,
    "n=0",
    `for f in ${ACME_DIR}/acme.json ${ACME_DIR}/acme-dns.json; do`,
    `  [ -f "$f" ] && c=$(grep -c "\\"main\\": *\\"$H\\"" "$f" 2>/dev/null || true) && n=$((n + \${c:-0}))`,
    "done",
    `printf 'TUGRA_ACME_HAS host=%s n=%s\\n' "$H" "$n"`,
    `L=$(docker logs --since 15m ${PROXY} 2>&1 | grep -i 'acme\\|unable to obtain' | tail -n 3 | tr -c '\\040-\\176\\n' ' ' | tr '\\n' ' ' | cut -c1-400 || true)`,
    `[ -n "$L" ] && printf 'TUGRA_ACME_ERR=%s\\n' "$L"`,
    "exit 0",
  ].join("\n");
}

/** The agent caps a command's output at 64 KiB and appends this marker when it cuts (agent/internal/exec). */
const AGENT_TRUNCATION_MARKER = "…(truncated)";

/** Bytes of acme.json read per command: 36 KiB -> 48 KiB of base64, comfortably under the agent's 64 KiB output cap. */
export const ACME_CHUNK_BYTES = 36 * 1024;

/**
 * Stop the proxy (so Traefik cannot rewrite acme.json under us) and probe the file: its size, its sha256 and, only
 * when it fits one command result, the body as one base64 line. A larger store is then read with
 * {@link buildAcmeReadChunkScript} and checked against the probe, so the hub never acts on a truncated read.
 */
export function buildAcmeReadScript(): string {
  return [
    "set -u",
    `docker stop ${PROXY} >/dev/null 2>&1 || true`,
    `if [ -f ${ACME_FILE} ]; then`,
    `  SZ=$(wc -c < ${ACME_FILE} | tr -d ' ')`,
    '  echo "TUGRA_ACME_SIZE=$SZ"',
    `  if [ "$SZ" -gt ${ACME_READ_CAP} ]; then echo "TUGRA_ACME_TOOBIG"; exit 0; fi`,
    `  echo "TUGRA_ACME_SHA256=$(sha256sum < ${ACME_FILE} | cut -d' ' -f1)"`,
    `  if [ "$SZ" -le ${ACME_CHUNK_BYTES} ]; then`,
    '    echo "TUGRA_ACME_B64_BEGIN"',
    `    base64 < ${ACME_FILE} | tr -d '\\n'`,
    '    echo ""',
    '    echo "TUGRA_ACME_B64_END"',
    "  fi",
    "else",
    '  echo "TUGRA_ACME_SIZE=0"',
    "fi",
  ].join("\n");
}

/**
 * Parse the probe. Fails CLOSED: anything that is not a complete, self-consistent read is `null` (a cut output must
 * never be mistaken for "no acme.json"). `b64` is the whole file when it rode the probe; it is `null` for an absent /
 * empty file (size 0) and for a store too big for one command (`size > ACME_CHUNK_BYTES`, `sha256` set), which the
 * caller then reads chunk by chunk.
 */
export function parseAcmeReadOutput(out: string): { size: number; b64: string | null; tooBig: boolean; sha256?: string } | null {
  if (out.includes(AGENT_TRUNCATION_MARKER)) return null;
  const lines = out.split(/\r?\n/);
  const sizeLine = lines.find((l) => /^TUGRA_ACME_SIZE=\d{1,12}$/.test(l));
  if (!sizeLine) return null;
  const size = Number(sizeLine.split("=")[1]);
  if (lines.includes("TUGRA_ACME_TOOBIG")) return { size, b64: null, tooBig: true };
  const shaLine = lines.find((l) => /^TUGRA_ACME_SHA256=[0-9a-f]{64}$/.test(l));
  const sha256 = shaLine ? shaLine.split("=")[1] : undefined;
  const begin = lines.indexOf("TUGRA_ACME_B64_BEGIN");
  const end = lines.indexOf("TUGRA_ACME_B64_END");
  if (begin < 0) {
    if (size === 0) return { size, b64: null, tooBig: false };
    // chunked path: only valid for a store that could not ride the probe, and only with its checksum
    return size > ACME_CHUNK_BYTES && sha256 ? { size, b64: null, tooBig: false, sha256 } : null;
  }
  if (end < begin) return null;
  const b64 = lines.slice(begin + 1, end).join("");
  if (!/^[A-Za-z0-9+/=]*$/.test(b64) || Buffer.from(b64, "base64").length !== size) return null;
  return sha256 ? { size, b64, tooBig: false, sha256 } : { size, b64, tooBig: false };
}

/** One slice of acme.json (the proxy is already stopped) as a single base64 line. */
export function buildAcmeReadChunkScript(offset: number, length: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > ACME_CHUNK_BYTES) throw new Error("bad acme chunk range");
  return [
    "set -u",
    `tail -c +${offset + 1} ${ACME_FILE} | head -c ${length} | base64 | tr -d '\\n'`,
    'echo ""',
    'echo "TUGRA_ACME_CHUNK_END"',
  ].join("\n");
}

/** The decoded bytes of one chunk, or `null` when the output is cut, malformed or lacks its end marker. */
export function parseAcmeChunkOutput(out: string): Buffer | null {
  if (out.includes(AGENT_TRUNCATION_MARKER)) return null;
  const lines = out.split(/\r?\n/);
  const end = lines.indexOf("TUGRA_ACME_CHUNK_END");
  if (end < 0) return null;
  const b64 = lines.slice(0, end).join("");
  return /^[A-Za-z0-9+/=]*$/.test(b64) ? Buffer.from(b64, "base64") : null;
}

/** Atomically replace acme.json (tmp + chmod 600 + mv, the certPrelude precedent). b64 is shq()-quoted. */
export function buildAcmeWriteScript(b64: string, count: number): string {
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new Error("acme payload is not base64");
  return [
    "set -eu",
    `mkdir -p ${ACME_DIR}`,
    `printf %s ${shq(b64)} | base64 -d > ${ACME_FILE}.tmp`,
    `chmod 600 ${ACME_FILE}.tmp`,
    `mv ${ACME_FILE}.tmp ${ACME_FILE}`,
    `echo "TUGRA_ACME_SEED ok n=${Math.max(0, Math.floor(count))}"`,
  ].join("\n");
}

export function parseAcmeSeedOutput(out: string): number | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^TUGRA_ACME_SEED ok n=(\d{1,5})$/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}
