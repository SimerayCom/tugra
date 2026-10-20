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

/** A conservative image-ref charset (registry/repo:tag@digest). Defensive — the ref is operator config. */
const IMAGE_RE = /^[A-Za-z0-9._/:@-]+$/;
/** A docker image digest is exactly 64 lowercase hex chars. */
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Renders the bootstrap installer. When `digests` is supplied (the release's per-arch agent image digests,
 * matched to this hub's version), the script detects the host arch and pins IMAGE to `image@sha256:<digest>`
 * for supply-chain integrity — before arg parsing, so an explicit `--image` still overrides. Without
 * `digests` (dev / version mismatch / custom AGENT_IMAGE mirror) it falls back to the bare version tag.
 */
export function renderAgentInstallScript(opts: { image: string; digests?: { amd64: string; arm64: string } }): string {
  const image = opts.image;
  if (!IMAGE_RE.test(image)) {
    throw new Error(`refusing to render install script for unsafe image ref: ${JSON.stringify(image)}`);
  }
  if (opts.digests && (!SHA256_RE.test(opts.digests.amd64) || !SHA256_RE.test(opts.digests.arm64))) {
    throw new Error("refusing to render install script with an invalid agent image digest");
  }
  // Arch-aware digest pin (only when digests are known + valid). Set as the default before arg parsing.
  const pinLines = opts.digests
    ? [
        '_arch="$(uname -m 2>/dev/null || echo unknown)"',
        'case "$_arch" in',
        `  x86_64|amd64) IMAGE="${image}@sha256:${opts.digests.amd64}" ;;`,
        `  aarch64|arm64) IMAGE="${image}@sha256:${opts.digests.arm64}" ;;`,
        "esac",
      ]
    : [];
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
    'TOKEN="${TUGRA_TOKEN:-}"',
    'NAME="tugra-agent"',
    'VOLUME="tugra-agent-data"',
    "",
    "# shift by 2 only when a value is present; a value-less flag shifts by 1 and falls through to the",
    "# required-value checks below (a bare `shift 2` would abort under `set -e` with an ugly error).",
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    --hub) HUB="${2:-}"; shift $(( $# >= 2 ? 2 : 1 )) ;;',
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
    "if ! command -v docker >/dev/null 2>&1; then",
    `  printf 'error: Docker is required to run the Tugra agent.\\n' >&2`,
    `  printf '  Install Docker: https://docs.docker.com/engine/install/  (quick: curl -fsSL https://get.docker.com | sh)\\n' >&2`,
    "  exit 1",
    "fi",
    "",
    `printf 'Pulling %s ...\\n' "$IMAGE"`,
    'if ! docker pull "$IMAGE"; then',
    `  printf 'error: could not pull %s\\n' "$IMAGE" >&2`,
    `  printf '  Set --image or the AGENT_IMAGE env on the hub, or check your release channel is published.\\n' >&2`,
    "  exit 1",
    "fi",
    "",
    "# Idempotent: replace any existing agent container. The named volume keeps the agent identity",
    "# (~/.tugra: key + serverId/seal), so a re-run reconnects as the SAME server rather than re-enrolling.",
    'docker rm -f "$NAME" >/dev/null 2>&1 || true',
    "",
    'docker run -d --name "$NAME" --restart unless-stopped \\',
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    '  -v "$VOLUME":/root/.tugra \\',
    "  -v /etc/tugra:/etc/tugra \\",
    '  -e TUGRA_HUB="$HUB" \\',
    '  -e TUGRA_TOKEN="$TOKEN" \\',
    '  -e TUGRA_AGENT_IMAGE="$IMAGE" \\',
    '  "$IMAGE" >/dev/null',
    "",
    `printf 'Tugra agent started. Follow its logs with: docker logs -f %s\\n' "$NAME"`,
    "",
  ];
  return lines.join("\n");
}
