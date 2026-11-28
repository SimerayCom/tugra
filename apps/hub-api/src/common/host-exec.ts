/**
 * One way to run a hub script in the HOST's context.
 *
 * The agent is a container on Docker's default bridge (no `--network host`, no `--pid host`, only the docker socket, its own
 * volume and /etc/tugra mounted). Every command the hub sends through `agentWs.sendCommand` runs as `bash -c` INSIDE it. So in
 * a script sent as it is: 127.0.0.1/localhost is the agent itself, the user-defined bridges (tugra-proxy's) are isolated and
 * time out, and the host's files (/data/coolify, /var/lib/docker, /etc/logrotate.d, /proc), processes, systemd and package
 * managers are not there. Two helpers, both a throwaway container of the agent's OWN image (never pulled, never resolved from a
 * container name):
 *
 *  - {@link onHostNetwork}: `--network host` plus the docker socket. For probes of the box's own :443 and of the proxy's bridge
 *    address. Files are still the helper's.
 *  - {@link onHostNamespaces}: `--privileged --pid=host` + `nsenter -t 1 -m -u -i -n -p`. The script then really runs on the
 *    host: its files, processes, network, docker and tools. Needed when the script reads or writes host paths.
 *
 * Callers pass a FLAG to the exec layer (`world.exec(server, script, ms, { hostNetwork: true })`, see {@link withHostContext}) so
 * script-text fakes in tests keep working. Neither helper falls back to the container: with no image they print
 * `TUGRA_HOST_UNAVAILABLE reason=no-image` and exit 1, so a probe says "could not enter the host" instead of reporting a wrong
 * "unreachable" or "nothing there". The image is ONLY the `$TUGRA_AGENT_IMAGE` env the agent learned at install/self-update (never
 * from the hub, never `docker inspect $(hostname)`: a tenant compose app may name its container the agent's short id, and its
 * image would run `--network host` with the docker socket, or `--privileged`, as host root).
 */

export const HOST_UNAVAILABLE_MARK = "TUGRA_HOST_UNAVAILABLE";

export interface HostContext {
  /** Run on the box's own network (curl to 127.0.0.1:443, to the proxy's bridge address). */
  hostNetwork?: boolean;
  /** Run in the host's namespaces (host files, processes, network, tools). Wins over `hostNetwork`. */
  hostNamespaces?: boolean;
  /** Hard cap of the helper's own runtime, seconds. Default 300 (host network) / 300 (namespaces). */
  deadlineSec?: number;
}

const DEFAULT_DEADLINE_SEC = 300;

const deadline = (o?: { deadlineSec?: number }): number => {
  const d = Math.trunc(o?.deadlineSec ?? DEFAULT_DEADLINE_SEC);
  if (!Number.isFinite(d) || d < 5 || d > 3600) throw new Error("host-exec: invalid deadline");
  return d;
};

const b64 = (s: string): string => {
  const v = Buffer.from(s, "utf8").toString("base64");
  // Pure base64 only: it sits inside single quotes on the agent's shell and can never break out.
  if (!/^[A-Za-z0-9+/=]*$/.test(v)) throw new Error("host-exec: non-base64 payload");
  return v;
};

/**
 * The agent runs a hub command as `bash -c <command>` and the kernel refuses one argument longer than 128 KiB (E2BIG: the command
 * would not start at all, with an error that says nothing about the size). The wrapped script is base64 (4/3 of the script), so a
 * script that would not fit is refused HERE with a message that names the problem; a caller with a long list batches it.
 */
export const MAX_WRAPPED_BYTES = 120_000;

const fits = (wrapped: string): string => {
  if (Buffer.byteLength(wrapped, "utf8") > MAX_WRAPPED_BYTES) throw new Error("host-exec: script too large for one command: split the work into batches");
  return wrapped;
};

/** The image check, shared by both helpers. */
const IMAGE_LINES = ['IMG="${TUGRA_AGENT_IMAGE:-}"', `[ -n "$IMG" ] || { echo "${HOST_UNAVAILABLE_MARK} reason=no-image"; exit 1; }`];
/** A unique helper name, removed when the command ends in a way the shell can still see (a SIGKILL cannot be trapped: `timeout` inside bounds it). */
const NAME_LINES = ['HN="tugra-hx-$$-$(date +%s)"', `trap 'docker rm -f "$HN" >/dev/null 2>&1' EXIT`];

/**
 * Run `script` on the box's own network. The script is read by `bash` inside the helper from a file (not from stdin), so a command
 * in it that reads stdin cannot swallow the rest of the script, and it gets `</dev/null`.
 */
export function onHostNetwork(script: string, opts?: { deadlineSec?: number }): string {
  const d = deadline(opts);
  return fits([
    ...IMAGE_LINES,
    ...NAME_LINES,
    `printf '%s' '${b64(script)}' | base64 -d | docker run --rm -i --pull never --name "$HN" --label tugra.role=host-net-helper \\`,
    `  --network host -v /var/run/docker.sock:/var/run/docker.sock -e TUGRA_AGENT_IMAGE="$IMG" --entrypoint bash "$IMG" \\`,
    `  -c 'cat > /tmp/tugra-host.sh; exec timeout -k 5 ${d} bash /tmp/tugra-host.sh </dev/null'`,
    "",
  ].join("\n"));
}

// What the privileged helper runs inside the host's namespaces: decode the script and run it with the host's bash (else sh).
const NS_RUNNER = 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; S=$(printf %s "$TUGRA_HX_B64" | base64 -d); if command -v bash >/dev/null 2>&1; then exec bash -c "$S" </dev/null; fi; exec sh -c "$S" </dev/null';

/**
 * Run `script` in the HOST's namespaces: its mount namespace (so /data/coolify, /var/lib/docker, /etc/logrotate.d are the real ones),
 * its network, pid and ipc. Only the short-lived helper is `--privileged`: no stronger than the docker socket the agent already holds.
 * Every unmet precondition prints `TUGRA_HOST_UNAVAILABLE reason=...` and exits 1; there is never a fallback to the container.
 */
export function onHostNamespaces(script: string, opts?: { deadlineSec?: number }): string {
  const d = deadline(opts);
  return fits([
    ...IMAGE_LINES,
    ...NAME_LINES,
    `docker run --rm --pull never --name "$HN" --label tugra.role=host-ns-helper \\`,
    `  --privileged --pid=host --userns=host --network none \\`,
    `  -e TUGRA_AGENT_IMAGE="$IMG" -e TUGRA_HX_B64='${b64(script)}' -e TUGRA_HX_RUN='${b64(NS_RUNNER)}' --entrypoint sh "$IMG" -c '`,
    `[ "$(readlink /proc/1/ns/mnt)" != "$(readlink /proc/self/ns/mnt)" ] || { echo "${HOST_UNAVAILABLE_MARK} reason=not-host-pid"; exit 1; }`,
    `grep -Eq "^ *0 +0 +4294967295$" /proc/self/uid_map || { echo "${HOST_UNAVAILABLE_MARK} reason=userns"; exit 1; }`,
    `command -v nsenter >/dev/null 2>&1 || { echo "${HOST_UNAVAILABLE_MARK} reason=no-nsenter"; exit 1; }`,
    `exec timeout -k 5 ${d} nsenter -t 1 -m -u -i -n -p -- /bin/sh -c "$(printf %s "$TUGRA_HX_RUN" | base64 -d)"`,
    `'`,
    "",
  ].join("\n"));
}

/** Wrap `script` for the requested host context; the script as it is when none is asked for. */
export function withHostContext(script: string, ctx?: HostContext): string {
  if (ctx?.hostNamespaces) return onHostNamespaces(script, ctx);
  if (ctx?.hostNetwork) return onHostNetwork(script, ctx);
  return script;
}

/** The script a {@link onHostNetwork} / {@link onHostNamespaces} wrapper carries, or the text itself when it is not wrapped. For tests that read what was sent. */
export function unwrapHostScript(sent: string): string {
  const m = /TUGRA_HX_B64='([A-Za-z0-9+/=]*)'/.exec(sent) ?? /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d \| docker run/.exec(sent);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : sent;
}

/** Why the host could not be entered (`no-image`, `not-host-pid`, `userns`, `no-nsenter`), or null when the output does not say so. */
export function hostUnavailableReason(output: string): string | null {
  const m = new RegExp(`${HOST_UNAVAILABLE_MARK} reason=(\\S+)`).exec(output ?? "");
  return m ? m[1] : null;
}

/**
 * Shell function `tugra_host_test <-e|-f|-d> <absolute host path>`: does that HOST path exist (and is it a file / a directory)?
 * From the agent's own filesystem the host's paths are invisible, so the daemon is asked: a throwaway container of the agent's image
 * with the PARENT of the path bind-mounted read-only (a `--mount` bind of a missing source fails and never creates it). The parent is
 * mounted, not the path, so a symlink stays a symlink (`-L` is answerable). Returns 0 yes, 1 no, 2 unknown (no image, a path docker
 * cannot take, a daemon error): callers must not read 2 as "no".
 *
 * Every capability is dropped except DAC_READ_SEARCH: root without it cannot traverse a parent owned by someone else with mode 700
 * (/home/alice), and `test` would then fail silently and read as "missing".
 */
export const HOST_TEST_FN = [
  "tugra_host_test() {",
  '  [ -n "${TUGRA_AGENT_IMAGE:-}" ] || return 2',
  '  case "$2" in /*) ;; *) return 2 ;; esac',
  // a comma or a quote would end the --mount value early (a second mount option): such a path is not asked about
  `  case "$2" in *,*|*'"'*|*"'"*) return 2 ;; esac`,
  '  if [ "$2" = "/" ]; then par=/; base=.; else par=$(dirname "$2"); base=$(basename "$2"); fi',
  '  e=$(docker run --rm --pull never --network none --cap-drop ALL --cap-add DAC_READ_SEARCH --label tugra.role=host-probe --mount "type=bind,src=$par,dst=/x,readonly" --entrypoint test "$TUGRA_AGENT_IMAGE" "$1" "/x/$base" 2>&1 >/dev/null); rc=$?',
  "  [ $rc -eq 0 ] && return 0",
  '  case "$e" in *"does not exist"*|*"No such file"*) return 1 ;; esac',
  "  [ -z \"$e\" ] && return 1",
  "  return 2",
  "}",
].join("\n");
