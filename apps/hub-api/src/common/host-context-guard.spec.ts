import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Lint-style guard over the script builders (the same bug class has been hit four times: the web terminal, the in-place probes, the
 * dark probe, the cleanup scan).
 *
 * A hub script sent through the agent runs as `bash -c` INSIDE the agent's container: 127.0.0.1 / localhost there is the agent, the
 * proxy's bridge is isolated, and the host's files, processes and tools (/data/coolify, /var/lib/docker, /etc/logrotate.d,
 * /proc/net, systemctl, apt-get ...) are not visible. So a source file that builds a script AND names one of those things must say
 * how the script gets to the host. This spec fails for a file that is not in {@link REVIEWED}, with what to do; and for every
 * reviewed file it checks that the way it names is really there (the helper's name in the file or in the named callers).
 *
 * How a script reaches the host (`how`):
 *  - "host-namespaces": `onHostNamespaces` / `hostNamespaces: true` / `wrapHostExec` (nsenter into PID 1): host files, processes, tools
 *  - "host-network":    `onHostNetwork` / `hostNetwork: true`: the box's own :443 and the proxy's bridge address
 *  - "helper":          the script itself starts a throwaway container (`--network host`, `--mount type=bind`, `--privileged`) of the agent's image
 *  - "daemon":          only docker commands; the path/host names are resolved by the DAEMON (a `-v`/`--mount` source, `docker volume create`, a label)
 *  - "inside":          the name is something inside another container (`docker exec ... mysql -h127.0.0.1`), or the agent's own mount (/etc/tugra)
 *  - "operator":        not run by the agent's shell: the operator's host, an ssh session, a migrator container, or the hub itself
 */
type How = "host-namespaces" | "host-network" | "helper" | "daemon" | "inside" | "operator";
interface Reviewed {
  how: How;
  /** For host-namespaces / host-network: the files that send the script (they must name the wrapper). Default: the file itself. */
  via?: string[];
  why: string;
}

const REVIEWED: Record<string, Reviewed> = {
  "server-ops/patch-script.ts": { how: "host-namespaces", why: "wrapHostExec: the package manager runs on the host through nsenter" },
  "server-ops/reboot-script.ts": { how: "helper", why: "its own --network host helper container of the agent image, then systemd-run on the host" },
  "server-ops/reboot.service.ts": { how: "inside", why: "message text only" },
  "server-ops/patch.service.ts": { how: "inside", why: "message text only" },
  "server-ops/proxy-ops.service.ts": { how: "inside", why: "docker commands and /etc/tugra (the agent's own mount)" },
  "install/migrator-install-script.ts": { how: "helper", why: "migrator.sh: runs on the source host, or in the agent's container where acme_ok asks the daemon (throwaway container, --mount bind)" },
  "install/host-facts-sh.ts": { how: "operator", why: "captured by the installer on the host, before the agent container starts (the agent only reports the file)" },
  "install/agent-install-script.ts": { how: "operator", why: "the installer runs on the host, as root, from the operator's shell" },
  "importer/safe-db-scripts.ts": { how: "inside", why: "clickhouse client inside the database container" },
  "migration-runs/steps/data/verify/db-stats.ts": { how: "inside", why: "`docker exec ... -h127.0.0.1` inside the database container" },
  "migration-runs/steps/data/source-control/host-loop-script.ts": { how: "operator", why: "the host loop is pasted by the operator / run over ssh; 127.0.0.1 only classifies a source address" },
  "migration-runs/steps/data/inventory/inventory-script.ts": { how: "operator", why: "`migrator.sh --inventory` over the host loop's ssh, never the agent's shell" },
  "deploy/compose-adopt.ts": { how: "helper", why: "the compose is read in a helper container of the agent image; /data/coolify is a path rule, not a read" },
  "deploy/deploy-script.ts": { how: "daemon", why: "deploy scripts talk to docker; the access-log rotation is the agent's (traffic/rotate.go), the http probe runs in a --network host container" },
  "agent-gateway/agent-ws.server.ts": { how: "operator", why: "hub-side URL parsing" },
  "pm2-move/pm2-script.ts": { how: "helper", why: "the port and HTTP probes run in `--network host` containers" },
  "app-moves/app-move-scripts.ts": { how: "helper", why: "df / ports / host paths are measured in host-view containers (--mount bind, --network host, --entrypoint named)" },
  "common/host-exec.ts": { how: "host-namespaces", why: "the helper itself" },
  "cutover/cutover-scripts.ts": {
    how: "host-network",
    via: ["cutover/cutover.service.ts", "migration-runs/steps/cutover/swap-runtime.ts"],
    why: "the loopback probe dials the box's :443: both callers send it on the host network",
  },
  "object-migrations/obj-scripts.ts": { how: "helper", why: "mc runs in helper containers; the docker root is measured with a --mount bind" },
  "applications/panel-domain.service.ts": { how: "operator", why: "hub-side hostname check" },
  "applications/port-allocator.service.ts": { how: "host-network", why: "the listening-port probe reads the HOST's /proc/net/tcp on the host network" },
  "coolify-inplace/inplace-scripts.ts": {
    how: "host-network",
    via: ["coolify-inplace/coolify-inplace.service.ts", "coolify-inplace/inplace-world.service.ts"],
    why: "probes and certificate checks run on the host network; the fallback install reads Coolify's acme.json in the host namespaces",
  },
  "coolify-inplace/inplace-service-scripts.ts": { how: "daemon", why: "host folders are tested through the daemon (tugra_host_test), volumes are created by it" },
  "coolify-cleanup/remnant-scan.ts": { how: "host-namespaces", via: ["coolify-cleanup/coolify-cleanup.service.ts"], why: "/data/coolify is read in the host namespaces" },
  "coolify-cleanup/remnant-remove.ts": { how: "host-namespaces", via: ["coolify-cleanup/coolify-cleanup.service.ts"], why: "/data/coolify is removed in the host namespaces" },
  "backups/backup-script.ts": { how: "inside", why: "`docker exec` into the database container" },
  "migration-runs/steps/cutover/dark-probe.ts": {
    how: "host-network",
    via: ["migration-runs/steps/cutover/tls-preissue.handler.ts"],
    why: "the proxy's bridge address is reachable from the host network only",
  },
};

const HOST_ONLY =
  /127\.0\.0\.1|\blocalhost\b|\/data\/coolify|\/var\/lib\/docker\b|\/etc\/logrotate\.d|\/proc\/(?:net|1)\b|\/etc\/os-release|\bsystemctl\b|\bjournalctl\b|\bufw\b|\biptables\b|\bapt-get\b|\bss -ltn/;
const BUILDS_SCRIPT = /sendCommand\(|\bbuild\w*Script\b|\bdocker (?:run|exec|inspect|ps)\b|\bcommand -v\b/;
const WRAPPER: Record<"host-namespaces" | "host-network", RegExp> = {
  "host-namespaces": /onHostNamespaces|hostNamespaces:\s*true|wrapHostExec|nsenter -t 1/,
  "host-network": /onHostNetwork|hostNetwork:\s*true|withHostContext|--network host/,
};

const SRC = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "testing" || name === "node_modules") continue;
      sources(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts") && !/-box\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The code without comments (block, line and JSDoc lines): a mention in a comment is not a script. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const files = sources(SRC).map((p) => ({ rel: relative(SRC, p), code: code(readFileSync(p, "utf8")) }));
const flagged = files.filter((f) => BUILDS_SCRIPT.test(f.code) && HOST_ONLY.test(f.code));

describe("host context guard: a script that names the host must reach the host", () => {
  it("every source file that builds a script and names 127.0.0.1/localhost or a host path is reviewed", () => {
    const unknown = flagged.filter((f) => !(f.rel in REVIEWED)).map((f) => f.rel);
    if (unknown.length > 0) {
      throw new Error(
        `These files build agent scripts and name 127.0.0.1 / localhost / a host path or tool, but are not reviewed:\n  ${unknown.join("\n  ")}\n` +
          "The agent runs scripts as `bash -c` INSIDE its container (default bridge, only /etc/tugra + the docker socket): there 127.0.0.1 is the agent, " +
          "other bridges are isolated and the host's files and processes are invisible. Send the script through common/host-exec " +
          "(onHostNetwork / onHostNamespaces, or the `hostNetwork` / `hostNamespaces` flag of the exec layer), or test through the daemon, " +
          "then add the file to REVIEWED in this spec with how and why.",
      );
    }
  });

  it("no reviewed entry is stale (the file still exists)", () => {
    const known = new Set(files.map((f) => f.rel));
    expect(Object.keys(REVIEWED).filter((rel) => !known.has(rel))).toEqual([]);
  });

  it("a file reviewed as host-network / host-namespaces really sends through the wrapper (the file itself or the callers it names)", () => {
    const byRel = new Map(files.map((f) => [f.rel, f.code]));
    const bad: string[] = [];
    for (const [rel, r] of Object.entries(REVIEWED)) {
      if (r.how !== "host-namespaces" && r.how !== "host-network") continue;
      for (const sender of r.via ?? [rel]) {
        const text = byRel.get(sender);
        if (text === undefined) bad.push(`${rel}: sender ${sender} does not exist`);
        else if (!WRAPPER[r.how].test(text)) bad.push(`${rel}: ${sender} does not use a ${r.how} wrapper`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the helper-container entries really start a container of the agent's image with the host view they claim", () => {
    const byRel = new Map(files.map((f) => [f.rel, f.code]));
    const bad = Object.entries(REVIEWED)
      .filter(([, r]) => r.how === "helper")
      .filter(([rel]) => !/--network host|--mount|--privileged|--pid[= ]host|docker run/.test(byRel.get(rel) ?? ""))
      .map(([rel]) => rel);
    expect(bad).toEqual([]);
  });

  it("every agent-image helper run names its --entrypoint (the image's own entrypoint is tugra-agent)", () => {
    // Static form of the app-move bug: `docker run ... "$HI" sh -c` ran `tugra-agent sh -c`. A run of the agent image (the $HI / $IMG / $TUGRA_AGENT_IMAGE
    // variable) in the builders of the move probe must carry --entrypoint.
    const probe = readFileSync(join(SRC, "app-moves/app-move-scripts.ts"), "utf8");
    const runs = probe.split("\n").filter((l) => /docker run/.test(l) && /"\$HI"/.test(l));
    expect(runs.length).toBeGreaterThan(0);
    for (const l of runs) expect(l).toMatch(/--entrypoint/);
  });
});
