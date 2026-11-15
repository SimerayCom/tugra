/**
 * Renders the POSIX-sh bootstrap that `GET /install/migrator.sh` serves. Piped as
 *   curl -fsSL <hub>/install/migrator.sh | TUGRA_MIGRATION_TOKEN=<token> sh -s -- --hub <hub-url>
 * it runs the tugra-agent `migrate` subcommand (the one-click data migrator) as a ONE-SHOT, hardened
 * Docker container on the UNTRUSTED source host. The migrator IS the agent image — `docker run <image>
 * migrate ...` works because Dockerfile.agent's ENTRYPOINT is `tugra-agent` and the image ships the
 * docker CLI (the migrator inspects/execs the source DB containers over the mounted socket).
 *
 * Security shape (this is a security boundary):
 *  - The migration token NEVER lands on an argv at any layer: the install one-liner sets it in the
 *    environment of the receiving `sh` (not curl, not sh's argv), migrator.sh reads it from
 *    $TUGRA_MIGRATION_TOKEN and forwards it with a bare `-e TUGRA_MIGRATION_TOKEN` (name only — the
 *    docker client copies the value from its own env). `--token`/`--token-file` are hard-rejected.
 *  - The container is `--cap-drop ALL --read-only --security-opt no-new-privileges`, writes only to two
 *    tmpfs mounts (/tmp + the /spool gzip spool, so a dump never touches the host disk), and binds the
 *    docker socket as its ONLY mount. No -d, no ports, `--rm` + an EXIT trap reap it.
 *  - Everything that reaches docker (hub, image, spool size, network) is charset-validated fail-closed.
 *
 * Caveat: the DEFAULT image is digest-pinned to this hub's version (which includes the `migrate`
 * subcommand). An operator AGENT_IMAGE override to an image PREDATING the migrator would run
 * `tugra-agent migrate ...` as the old agent, which ignores the unknown `migrate` arg and exits 0 with
 * no migration. AGENT_IMAGE must therefore point at an image that ships the `migrate` subcommand.
 *
 * Like the agent installer, the body is an array of SINGLE-QUOTED lines joined with "\n" (NOT a template
 * literal) because it is full of `$1` / `${VAR:-}` / `$((...))`; only the IMAGE line + the pin block
 * concatenate the validated image ref.
 */

import { assertPinnable, archPinLines, type ArchDigests } from "./image-pin";

export function renderMigratorInstallScript(opts: { image: string; digests?: ArchDigests }): string {
  const image = opts.image;
  assertPinnable(image, opts.digests);
  const pinLines = archPinLines(image, opts.digests);
  const lines = [
    "#!/bin/sh",
    "# Tugra one-click data migrator - runs the tugra-agent `migrate` subcommand as a one-shot, hardened",
    "# Docker container on the source host. The migration token rides the ENVIRONMENT, never an argv.",
    "# Usage: curl -fsSL <hub>/install/migrator.sh | TUGRA_MIGRATION_TOKEN=<token> sh -s -- --hub <hub-url> [--dry-run] [--only REF] [--map REF=CONTAINER] [--resync] [--certs] [--proxy-container NAME]",
    "#   volume data (streamed in resumable parts): [--arms databases|volumes|all] [--stop-source] [--stop-timeout S] [--allow-bind] [--part-mib N] [--reset-volume REF] [--hub-outage-wait D] [--speedtest-mib N]",
    "set -eu",
    "",
    // Version-matched agent image, injected by the hub (the migrator is the agent image's `migrate` subcommand).
    'IMAGE="' + image + '"',
    // Pin to the release's per-arch digest when known (supply-chain); --image below still overrides.
    ...pinLines,
    // Unique per-run name ($$ = this sh's pid) so two concurrent migrations never `docker rm -f` each
    // other, and the EXIT trap only ever reaps OUR container (not a foreign one someone named tugra-migrator).
    'NAME="tugra-migrator-$$"',
    // Rootless/relocated Docker exposes its socket elsewhere ($XDG_RUNTIME_DIR/docker.sock); allow an
    // absolute-path override. Validated below before it reaches the --mount src.
    'SOCK="${TUGRA_DOCKER_SOCK:-/var/run/docker.sock}"',
    'HUB="${TUGRA_HUB:-}"',
    'SPOOL_SIZE="${TUGRA_SPOOL_SIZE:-2g}"',
    'NETWORK="${TUGRA_MIGRATOR_NETWORK:-}"',
    // Opt-in `--certs` (copy the source proxy's ACME certs): never set unless the owner passes the flag.
    'WANT_CERTS=""',
    'PROXY=""',
    // Which arm(s) run: the default (databases) keeps today's container exactly as it was; a volume arm adds a memory cap.
    'ARMS="databases"',
    "",
    "# die prints to stderr WITHOUT ever echoing a token/value and exits with the given (or usage=2) code.",
    "die() { printf 'tugra-migrator: %s\\n' \"$1\" >&2; exit \"${2:-2}\"; }",
    "",
    "# Everything lives in main(), invoked on the LAST line: a truncated `curl | sh` download then ends in a",
    "# parse error instead of executing a partial script (sh reads the pipe incrementally).",
    "main() {",
    "  # Consume ONLY --hub/--image here; rotate every other arg to the BACK of \"$@\" so it is forwarded",
    "  # verbatim to `migrate`. n counts the not-yet-examined args at the FRONT; forwarded ones sit behind.",
    "  n=$#",
    '  while [ "$n" -gt 0 ]; do',
    "    a=$1; shift; n=$((n - 1))",
    '    case "$a" in',
    '      --hub) [ "$n" -ge 1 ] || die "--hub needs a value"; HUB=$1; shift; n=$((n - 1)) ;;',
    "      --hub=*) HUB=${a#--hub=} ;;",
    '      --image) [ "$n" -ge 1 ] || die "--image needs a value"; IMAGE=$1; shift; n=$((n - 1)) ;;',
    "      --image=*) IMAGE=${a#--image=} ;;",
    "      --token|--token=*|--token-file|--token-file=*)",
    '        die "the migration token is never accepted on the command line - set TUGRA_MIGRATION_TOKEN (use the command shown in the Tugra UI)" ;;',
    '      --spool-dir|--spool-dir=*) die "--spool-dir is fixed inside the container" ;;',
    '      --certs) WANT_CERTS=1; set -- "$@" "$a" ;;',
    '      --proxy-container) [ "$n" -ge 1 ] || die "--proxy-container needs a value"; PROXY=$1; set -- "$@" "$a" "$1"; shift; n=$((n - 1)) ;;',
    "      --proxy-container=*) PROXY=${a#--proxy-container=}; set -- \"$@\" \"$a\" ;;",
    // The tar helper of the volume arm is THIS migrator image (never pulled onto the source host); it cannot be repointed.
    '      --helper-image|--helper-image=*) die "--helper-image is fixed to the migrator image" ;;',
    // --arms is both parsed (to size the container) and forwarded verbatim to `migrate`.
    '      --arms) [ "$n" -ge 1 ] || die "--arms needs a value"; ARMS=$1; shift; n=$((n - 1)); set -- "$@" --arms "$ARMS" ;;',
    "      --arms=*) ARMS=${a#--arms=}; set -- \"$@\" \"$a\" ;;",
    "      --*) set -- \"$@\" \"$a\" ;;",
    // A single-dash option (Go's flag package accepts `-token` as well as `--token`) would slip a token /
    // spool-dir / hub onto the container argv or override a pinned value. Reject ALL single-dash options
    // WITHOUT echoing the arg (it could be `-token=<secret>`). The hub/UI only ever emit `--` flags.
    '      -?*) die "single-dash options are not accepted - use the double-dash flags from the Tugra UI (--dry-run, --only, --map, --resync, --handshake, --certs, --proxy-container)" ;;',
    '      *) set -- "$@" "$a" ;;',
    "    esac",
    "  done",
    "",
    "  # Fail-closed validation of everything that reaches docker/argv (migrate re-validates --hub too).",
    '  case "$HUB" in http://?*|https://?*) ;; *) die "--hub must be an http(s) URL of your Tugra hub" ;; esac',
    '  case "$HUB" in *[!A-Za-z0-9.:/_~-]*) die "--hub contains unsafe characters" ;; esac',
    "  case \"$IMAGE\" in ''|-*|*[!A-Za-z0-9._/:@-]*) die \"invalid --image reference\" ;; esac",
    "  case \"$SPOOL_SIZE\" in ''|*[!0-9mMgG]*) die \"TUGRA_SPOOL_SIZE must look like 512m or 2g\" ;; esac",
    '  case "$NETWORK" in -*|*[!A-Za-z0-9_.-]*) die "invalid TUGRA_MIGRATOR_NETWORK" ;; esac',
    '  case "$ARMS" in databases|volumes|all) ;; *) die "--arms must be databases, volumes or all" ;; esac',
    '  case "$SOCK" in /*) ;; *) die "TUGRA_DOCKER_SOCK must be an absolute path" ;; esac',
    '  case "$SOCK" in *[!A-Za-z0-9._/-]*) die "TUGRA_DOCKER_SOCK contains unsafe characters" ;; esac',
    '  case "$PROXY" in -*|*[!A-Za-z0-9_.-]*) die "invalid --proxy-container" ;; esac',
    "",
    "  # Token: env ONLY, checked WITHOUT echoing it. tugra_mig_ + 43 base64url chars = 53 (mirrors the hub).",
    '  TOK="${TUGRA_MIGRATION_TOKEN:-}"',
    '  [ -n "$TOK" ] || die "TUGRA_MIGRATION_TOKEN is not set (paste the exact command from the Tugra UI)"',
    '  case "$TOK" in tugra_mig_*) ;; *) die "malformed migration token" ;; esac',
    '  case "$TOK" in *[!A-Za-z0-9_-]*) die "malformed migration token" ;; esac',
    '  [ "${#TOK}" -eq 53 ] || die "malformed migration token"',
    "  export TUGRA_MIGRATION_TOKEN",
    "",
    "  if ! command -v docker >/dev/null 2>&1; then",
    "    printf 'error: Docker is required on this host to run the migrator.\\n' >&2",
    "    printf '  Install Docker: https://docs.docker.com/engine/install/  (quick: curl -fsSL https://get.docker.com | sh)\\n' >&2",
    "    exit 6",
    "  fi",
    '  [ -S "$SOCK" ] || die "Docker socket $SOCK not found (rootless/remote Docker is not supported by the one-click migrator)" 6',
    "",
    "  printf 'Pulling %s ...\\n' \"$IMAGE\"",
    '  if ! docker pull "$IMAGE" >/dev/null; then',
    "    printf 'error: could not pull %s (set --image, or check the release is published)\\n' \"$IMAGE\" >&2",
    "    exit 6",
    "  fi",
    "",
    "  # Idempotent (replace a stale one), and reaped on exit. A SIGINT/TERM/HUP reaches the container via the",
    "  # docker CLI (migrate exits 130 after its own cleanup); the trap then removes the container and exits 130.",
    '  docker rm -f "$NAME" >/dev/null 2>&1 || true',
    "  trap 'docker rm -f \"$NAME\" >/dev/null 2>&1 || true' EXIT",
    "  trap 'exit 130' INT TERM HUP",
    "",
    "  # Keep a non-root-owned socket (rootless/userns/custom group) reachable without adding capabilities.",
    '  GID="$(stat -c %g "$SOCK" 2>/dev/null || stat -f %g "$SOCK" 2>/dev/null || echo 0)"',
    "  case \"$GID\" in ''|*[!0-9]*) GID=0 ;; esac",
    '  NETARG=""',
    '  [ -n "$NETWORK" ] && NETARG="--network=$NETWORK"',
    // The streamed volume copy keeps one 128 MiB raw slice + two member buffers in memory: cap the container so a bug can
    // never take the source host down. The databases arm is untouched (its dump spool lives in the tmpfs below).
    '  MEMARG=""',
    '  case "$ARMS" in volumes|all) MEMARG="--memory=768m --memory-swap=768m" ;; esac',
    "",
    "  # --certs only: make the source proxy's acme.json visible (read-only) inside the migrator container. The path is",
    "  # resolved from the proxy container's own mounts (default /data/coolify/proxy/acme.json), must be a regular",
    "  # non-symlink file and is charset-validated; a missing file just drops the mount and the agent reports 'skipped'.",
    '  ACMEMOUNT=""',
    '  if [ -n "$WANT_CERTS" ]; then',
    '    ACME="$(docker inspect --format \'{{range .Mounts}}{{if eq .Destination "/traefik"}}{{.Source}}/acme.json{{end}}{{end}}\' "${PROXY:-coolify-proxy}" 2>/dev/null || true)"',
    '    [ -n "$ACME" ] || ACME=/data/coolify/proxy/acme.json',
    '    case "$ACME" in /*) ;; *) ACME="" ;; esac',
    '    case "$ACME" in *[!A-Za-z0-9._/-]*) ACME="" ;; esac',
    '    if [ -n "$ACME" ] && [ -f "$ACME" ] && [ ! -L "$ACME" ]; then',
    '      ACMEMOUNT="--mount type=bind,src=$ACME,dst=/acme/acme.json,readonly"',
    '      set -- "$@" --acme-file=/acme/acme.json',
    "    fi",
    "  fi",
    "",
    "  # Runs in the foreground (not detached, no TTY): the operator sees the single JSON result line + the",
    "  # exit code, and the token-bearing env is dropped at --rm. The socket mount is the ONE privileged mount.",
    "  rc=0",
    '  docker run --rm --name "$NAME" \\',
    "    --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit 128 \\",
    "    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \\",
    '    --tmpfs "/spool:rw,noexec,nosuid,nodev,mode=0700,size=$SPOOL_SIZE" \\',
    '    --mount "type=bind,src=$SOCK,dst=/var/run/docker.sock" \\',
    '    --group-add "$GID" \\',
    "    $NETARG $ACMEMOUNT $MEMARG \\",
    // TUGRA_SELF_IMAGE: the volume arm's tar helper is this very image (already pulled above), run with --pull=never.
    '    -e TUGRA_MIGRATION_TOKEN -e "TUGRA_SELF_IMAGE=$IMAGE" -e HOME=/tmp \\',
    "    --entrypoint tugra-agent \\",
    '    "$IMAGE" migrate "--hub=$HUB" --spool-dir=/spool "$@" </dev/null || rc=$?',
    "  # Propagate migrate's contract exit code (0 ok, 1 partial, 3 auth, 4 unreachable, 5 skew, 6 precond, 130 int).",
    '  exit "$rc"',
    "}",
    "",
    'main "$@"',
    "",
  ];
  return lines.join("\n");
}
