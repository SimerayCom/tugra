/**
 * Renders the POSIX-sh bootstrap that `GET /install/agent.sh` serves. Piped as
 * `curl -fsSL <hub>/install/agent.sh | sh -s -- --hub <ws> --token <t>`, it installs and runs the
 * tugra-agent as a Docker container — the same shape as the compose `agent` service (docker.sock mount,
 * ~/.tugra volume, restart policy). The agent needs the Docker socket to deploy containers anyway, so a
 * Docker install (rather than a native binary + systemd) is the honest, consistent path.
 *
 * The script is built as an array of SINGLE-QUOTED lines joined with "\n" — NOT a JS template literal —
 * because the sh body is full of `${VAR:-}` / `$1` / `${2:-}` that a template literal would try to
 * interpolate as JS. Only the image line concatenates the (validated) image ref.
 */

import { HOST_FACTS_SH } from "./host-facts-sh";
import { assertPinnable, archPinLines } from "./image-pin";

/**
 * Renders the bootstrap installer. When `digests` is supplied (the release's per-arch agent image digests,
 * matched to this hub's version), the script detects the host arch and pins IMAGE to `image@sha256:<digest>`
 * for supply-chain integrity — before arg parsing, so an explicit `--image` still overrides. Without
 * `digests` (dev / version mismatch / custom AGENT_IMAGE mirror) it falls back to the bare version tag.
 */
export function renderAgentInstallScript(opts: { image: string; digests?: { amd64: string; arm64: string } }): string {
  const image = opts.image;
  assertPinnable(image, opts.digests);
  // Arch-aware digest pin (only when digests are known + valid). Set as the default before arg parsing.
  const pinLines = archPinLines(image, opts.digests);
  const lines = [
    "#!/bin/sh",
    "# Tugra agent installer — runs the tugra-agent as a Docker container.",
    "# Usage: curl -fsSL <hub>/install/agent.sh | sh -s -- --hub <wss-url>/agent --token <enroll-token>",
    "set -eu",
    "",
    // Version-matched agent image, injected by the hub. Override with --image (or edit before piping).
    'IMAGE="' + image + '"',
    // Pin to the release's per-arch digest when known (supply-chain); --image below still overrides.
    ...pinLines,
    'HUB="${TUGRA_HUB:-}"',
    // IP-mode hubs serve a self-signed certificate: the agent pins this leaf fingerprint (sha256:<hex>) instead of a CA chain.
    'HUB_PIN="${TUGRA_HUB_PIN:-}"',
    // Explicit opt-in to a plain ws:// hub (everything, secrets included, readable on the network).
    'HUB_INSECURE="${TUGRA_HUB_INSECURE:-}"',
    'TOKEN="${TUGRA_TOKEN:-}"',
    'NAME="tugra-agent"',
    'VOLUME="tugra-agent-data"',
    "",
    "# shift by 2 only when a value is present; a value-less flag shifts by 1 and falls through to the",
    "# required-value checks below (a bare `shift 2` would abort under `set -e` with an ugly error).",
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    --hub) HUB="${2:-}"; shift $(( $# >= 2 ? 2 : 1 )) ;;',
    '    --hub-pin) HUB_PIN="${2:-}"; shift $(( $# >= 2 ? 2 : 1 )) ;;',
    '    --hub-insecure) HUB_INSECURE=1; shift ;;',
    '    --token) TOKEN="${2:-}"; shift $(( $# >= 2 ? 2 : 1 )) ;;',
    '    --image) IMAGE="${2:-}"; shift $(( $# >= 2 ? 2 : 1 )) ;;',
    "    *)",
    `      printf 'tugra-agent installer: unknown option %s\\n' "$1" >&2`,
    "      exit 1 ;;",
    "  esac",
    "done",
    "",
    'if [ -z "$HUB" ]; then',
    `  printf 'error: --hub is required (or set TUGRA_HUB)\\n' >&2`,
    "  exit 1",
    "fi",
    'if [ -z "$TOKEN" ]; then',
    `  printf 'error: --token is required (or set TUGRA_TOKEN)\\n' >&2`,
    "  exit 1",
    "fi",
    "",
    "# Transport policy (the agent enforces the same): wss:// is the normal case — a domain uses its public certificate, a",
    "# bare IP needs --hub-pin (the fingerprint of the hub's self-signed certificate). Plain ws:// to a host that is not",
    "# this machine / the docker network leaks every environment value and secret to the network, so it must be explicit.",
    "LOOPBACK=0",
    'case "$HUB" in',
    "  ws://*)",
    '    HUBHOST="${HUB#ws://}"; HUBHOST="${HUBHOST%%/*}"; HUBHOST="${HUBHOST%%:*}"',
    // Loopback is the literal name or a numeric 127.x.y.z only: a NAME that merely starts with "127."
    // (127.evil.example.com) is a public host — the agent parses an IP, refuses it, and would crash-loop later.
    '    case "$HUBHOST" in',
    "      localhost) LOOPBACK=1 ;;",
    '      127.*.*.*) case "$HUBHOST" in *[!0-9.]*) ;; *) LOOPBACK=1 ;; esac ;;',
    "    esac",
    '    if [ "$LOOPBACK" != "1" ]; then',
    '      case "$HUBHOST" in',
    '        *.*|\[*) if [ "$HUB_INSECURE" != "1" ]; then',
    `            printf 'error: %s is a plain ws:// address (traffic, secrets included, is readable on the network).\\n' "$HUB" >&2`,
    `            printf '  Use the wss:// address, or pass --hub-insecure to accept plaintext explicitly.\\n' >&2`,
    "            exit 1",
    "          fi",
    `          printf 'WARNING: plain ws:// hub address — traffic including secrets is readable on the network.\\n' >&2 ;;`,
    "      esac",
    "    fi ;;",
    "  wss://*)",
    '    HUBHOST="${HUB#wss://}"; HUBHOST="${HUBHOST%%/*}"; HUBHOST="${HUBHOST%%:*}"',
    '    case "$HUBHOST" in',
    '      [0-9]*.[0-9]*.[0-9]*.[0-9]*) if [ -z "$HUB_PIN" ]; then',
    `          printf 'error: %s is a bare IP over TLS and needs --hub-pin sha256:<certificate fingerprint>.\\n' "$HUB" >&2`,
    "          exit 1",
    "        fi ;;",
    "    esac ;;",
    "esac",
    "",
    "if ! command -v docker >/dev/null 2>&1; then",
    // Turnkey add-server (parity with the hub installer): auto-install Docker when root, unless opted out.
    // Keeps the manual hint for the non-root / skip / failure cases so nothing silently half-installs.
    `  if [ "\${TUGRA_SKIP_DOCKER_INSTALL:-0}" = "1" ]; then`,
    `    printf 'error: Docker is required. Install it: https://get.docker.com (auto-install skipped via TUGRA_SKIP_DOCKER_INSTALL)\\n' >&2`,
    "    exit 1",
    "  fi",
    `  if [ "$(id -u)" != "0" ]; then`,
    `    printf 'error: Docker is not installed and this is not root. Install Docker (https://get.docker.com) or re-run as root.\\n' >&2`,
    "    exit 1",
    "  fi",
    `  printf 'Docker not found — installing it via get.docker.com (set TUGRA_SKIP_DOCKER_INSTALL=1 to skip) ...\\n' >&2`,
    `  if ! curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1; then`,
    `    printf 'error: automatic Docker install failed — install it manually: https://get.docker.com\\n' >&2`,
    "    exit 1",
    "  fi",
    "fi",
    "",
    `printf 'Pulling %s ...\\n' "$IMAGE"`,
    'if ! docker pull "$IMAGE"; then',
    `  printf 'error: could not pull %s\\n' "$IMAGE" >&2`,
    `  printf '  Set --image or the AGENT_IMAGE env on the hub, or check your release channel is published.\\n' >&2`,
    "  exit 1",
    "fi",
    "",
    "# Capture the HOST's identity here, on the host, before the agent starts in its container (it would only see the",
    "# container): hostname, OS and interface IPs go to /etc/tugra/host-facts.json, which the agent reports on connect.",
    HOST_FACTS_SH.trimEnd(),
    "tugra_write_host_facts",
    "",
    "# Idempotent: replace any existing agent container. The named volume keeps the agent identity",
    "# (~/.tugra: key + serverId/seal), so a re-run reconnects as the SAME server rather than re-enrolling.",
    'docker rm -f "$NAME" >/dev/null 2>&1 || true',
    "",
    "# Optional privacy knob: TUGRA_TRAFFIC_IP_MODE=off disables the IP-derived traffic dimensions (city, anonymized",
    "# network). Persisted under /etc/tugra (mounted into the agent) so it survives agent self-updates; any value",
    "# other than 'anonymized' (the default) or 'off' is treated as 'off'.",
    'if [ -n "${TUGRA_TRAFFIC_IP_MODE:-}" ]; then',
    `  { mkdir -p /etc/tugra && printf '%s\\n' "$TUGRA_TRAFFIC_IP_MODE" > /etc/tugra/traffic-ip-mode; } 2>/dev/null || printf 'warning: could not persist TUGRA_TRAFFIC_IP_MODE to /etc/tugra/traffic-ip-mode\\n' >&2`,
    "fi",
    "",
    "# A hub on this very machine (ws://localhost, ws://127.x): the agent's own container on the default bridge could never reach the",
    "# host's loopback (localhost there is the container), so such an agent shares the host's network.",
    'NETARG=""',
    'if [ "$LOOPBACK" = "1" ]; then',
    '  NETARG="--network host"',
    `  printf 'note: the hub address is on this machine (loopback), so the agent runs on the host network to reach it.\\n' >&2`,
    "fi",
    "",
    'docker run -d --name "$NAME" --restart unless-stopped $NETARG \\',
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    '  -v "$VOLUME":/root/.tugra \\',
    "  -v /etc/tugra:/etc/tugra \\",
    '  -e TUGRA_HUB="$HUB" \\',
    '  ${HUB_PIN:+-e "TUGRA_HUB_PIN=$HUB_PIN"} \\',
    '  ${HUB_INSECURE:+-e TUGRA_HUB_INSECURE=1} \\',
    '  -e TUGRA_TOKEN="$TOKEN" \\',
    '  -e TUGRA_AGENT_IMAGE="$IMAGE" \\',
    '  ${TUGRA_TRAFFIC_IP_MODE:+-e "TUGRA_TRAFFIC_IP_MODE=$TUGRA_TRAFFIC_IP_MODE"} \\',
    '  "$IMAGE" >/dev/null',
    "",
    `printf 'Tugra agent started. Follow its logs with: docker logs -f %s\\n' "$NAME"`,
    "",
  ];
  return lines.join("\n");
}
