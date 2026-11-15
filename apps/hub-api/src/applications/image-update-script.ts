import { registryLoginPrelude, registryLogoutSteps, shq, type RegistryAuth } from "../deploy/deploy-script";
import { IMAGE_CHECK_ERRORS, isCheckableRef, type ImageCheckError } from "./image-update";

/**
 * The fixed, hub-built bash probe for the "image update available" check. It runs on the app's OWN server (through
 * the signed deploy command channel) and asks the registry for the upstream manifest digest of each ref with
 * `docker buildx imagetools inspect`. The hub never contacts a registry itself.
 *
 * Safety model: every interpolated value goes through shq(); refs are re-validated by the strict allow-list;
 * raw docker/registry output only ever lands in files under a temp dir and is NEVER echoed (so nothing a hostile
 * registry says can reach the hub); the ONLY thing written to stdout is the `emit` line, bound to a per-run nonce
 * and a closed vocabulary. The script does not install a competing EXIT trap: it appends its temp dir to
 * $TUGRA_SEC_DIRS (the registry login prelude's wipe list) and re-installs the identical trap string.
 */

export type ImageProbeVerdict = { ok: true; digest: string } | { ok: false; code: ImageCheckError };

const NONCE_RE = /^[0-9a-f]{16}$/;
export const IMAGE_PROBE_MAX_ITEMS = 25;
export const IMAGE_PROBE_PER_ITEM_TIMEOUT_SEC = 20;
/** Worst case of ONE ref: the --format inspect, then (only when it failed fast, never after a timeout) one --raw call. */
export const IMAGE_PROBE_PER_ITEM_WORST_SEC = 2 * IMAGE_PROBE_PER_ITEM_TIMEOUT_SEC;
/** The registry login is bounded too (a tarpit login endpoint must not hold the whole batch). */
export const IMAGE_PROBE_LOGIN_TIMEOUT_SEC = 20;

export function buildImageUpdateScript(items: { idx: number; ref: string }[], auth: RegistryAuth | null, nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error("invalid probe nonce");
  if (items.length < 1 || items.length > IMAGE_PROBE_MAX_ITEMS) throw new Error("invalid probe batch size");
  for (const it of items) {
    if (!Number.isInteger(it.idx) || it.idx < 0 || it.idx > 999) throw new Error("invalid probe index");
    if (!isCheckableRef(it.ref)) throw new Error("invalid probe image reference");
  }
  const lines: string[] = [
    "set +e",
    ...registryLoginPrelude(auth, IMAGE_PROBE_LOGIN_TIMEOUT_SEC), // [] when anonymous (the agent's ambient docker config, exactly like a deploy pull)
    auth ? "TUGRA_LOGIN_RC=$?" : "TUGRA_LOGIN_RC=0",
    "TD=$(mktemp -d)",
    'TUGRA_SEC_DIRS="${TUGRA_SEC_DIRS:+$TUGRA_SEC_DIRS }$TD"',
    "trap 'rm -rf $TUGRA_SEC_DIRS' EXIT INT TERM HUP",
    `N='${nonce}'`,
    'emit() { echo "TUGRA_IMGUP_$N $1 $2"; }',
    `T=""; command -v timeout >/dev/null 2>&1 && T="timeout ${IMAGE_PROBE_PER_ITEM_TIMEOUT_SEC}"`,
    'SHA="sha256sum"; command -v sha256sum >/dev/null 2>&1 || SHA="shasum -a 256"',
    "chk() {",
    '  : >"$TD/o"; : >"$TD/e"',
    '  if [ "${TUGRA_LOGIN_RC:-0}" -ne 0 ]; then emit "$1" "err auth"; return; fi',
    `  $T docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$2" >"$TD/o" 2>"$TD/e" </dev/null; rc=$?`,
    `  d=$(head -c 200 "$TD/o" | tr -d '[:space:]')`,
    // A timeout means the registry is unresponsive: a second call would only burn another full window, so the
    // --raw fallback runs for fast failures / malformed output only (rc 124 goes straight to `err timeout`).
    `  if [ $rc -ne 124 ] && { [ $rc -ne 0 ] || ! printf '%s' "$d" | grep -Eqx 'sha256:[0-9a-f]{64}'; }; then`,
    '    $T docker buildx imagetools inspect --raw "$2" >"$TD/raw" 2>"$TD/e" </dev/null; rc=$?',
    '    d=""; [ $rc -eq 0 ] && d="sha256:$($SHA <"$TD/raw" | cut -d\' \' -f1)"',
    "  fi",
    `  if printf '%s' "$d" | grep -Eqx 'sha256:[0-9a-f]{64}'; then emit "$1" "ok $d"; return; fi`,
    '  if [ $rc -eq 124 ]; then emit "$1" "err timeout"',
    `  elif grep -Eqi 'unauthorized|denied|authentication required|401|403' "$TD/e"; then emit "$1" "err auth"`,
    `  elif grep -Eqi 'not found|manifest unknown|no such manifest|404' "$TD/e"; then emit "$1" "err notfound"`,
    '  else emit "$1" "err failed"; fi',
    "}",
    "if ! docker buildx version >/dev/null 2>&1; then",
    ...items.map((it) => `  emit ${it.idx} "err unsupported"`),
    "else",
    ...items.map((it) => `  chk ${it.idx} ${shq(it.ref)}`),
    "fi",
    ...registryLogoutSteps(auth),
    'echo "TUGRA_IMGUP_$N DONE"',
  ];
  return lines.join("\n");
}

/**
 * Parse the probe output into per-index verdicts. Anchored multiline match bound to the run's nonce over a
 * closed vocabulary: anything else (login noise, a forged line with another nonce, a bad digest, an unknown code)
 * is ignored. The first line per idx wins; a missing idx means "no verdict" (the caller writes nothing).
 */
export function parseImageUpdateOutput(output: string, nonce: string): Map<number, ImageProbeVerdict> {
  const out = new Map<number, ImageProbeVerdict>();
  if (!NONCE_RE.test(nonce) || typeof output !== "string") return out;
  const codes = IMAGE_CHECK_ERRORS.join("|");
  const re = new RegExp(`^TUGRA_IMGUP_${nonce} (\\d{1,3}) (?:ok (sha256:[0-9a-f]{64})|err (${codes}))$`, "gm");
  for (const m of output.replace(/\r\n/g, "\n").matchAll(re)) {
    const idx = Number(m[1]);
    if (out.has(idx)) continue;
    out.set(idx, m[2] ? { ok: true, digest: m[2] } : { ok: false, code: m[3] as ImageCheckError });
  }
  return out;
}
