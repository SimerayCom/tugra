import { createHash } from "node:crypto";
import { shq } from "../../../deploy/deploy-script";

/**
 * The same-host PROXY SWAP of a `swap-proxy` takeover (design 6): stop the source's `coolify-proxy`, start Tugra's own
 * proxy on :80/:443, no DNS write. Everything here is pure: scripts built with `shq()` + strict `assert*` (golden-tested),
 * parsers that fail CLOSED, the swap state machine and the plan hash. The handlers (cutover.handler.ts) sequence it.
 *
 * Source safety (design 10): the engine only stops a RECORDED container id after verifying its identity (name + image +
 * published :80/:443); it sets the restart policy to `no` so a reboot does not bring it back, and it NEVER runs
 * `docker rm`. The reverse restores the recorded restart policy and starts the same id.
 */

export const COOLIFY_PROXY_NAME = "coolify-proxy";
export const TUGRA_PROXY_NAME = "tugra-proxy";

/** Restart policies `docker inspect` reports (`on-failure` without its retry count: the reverse restores the plain policy). */
export const RESTART_POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const;
export type RestartPolicy = (typeof RESTART_POLICIES)[number];

const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const PORT_RE = /^(\d{1,5})>(\d{1,5})\/(tcp|udp)$/;

export function assertContainerId(id: string): string {
  if (!CONTAINER_ID_RE.test(id)) throw new Error("swap: invalid container id");
  return id;
}
export function assertRestartPolicy(p: string): RestartPolicy {
  if (!(RESTART_POLICIES as readonly string[]).includes(p)) throw new Error("swap: invalid restart policy");
  return p as RestartPolicy;
}

// ───────────────────────────── the recorded source proxy ─────────────────────────────

/** What is recorded into `MigrationRunSwap.coolifyProxy` (docker inspect minus env). */
export interface CoolifyProxySnapshot {
  containerId: string;
  name: string;
  image: string;
  restartPolicy: RestartPolicy;
  running: boolean;
  /** `hostPort>containerPort/proto` entries. */
  ports: string[];
}

/** Read-only inspect of the container NAMED `coolify-proxy`. `docker container inspect` so an image of that name never matches. */
export function buildSwapInspectScript(): string {
  const f = (tpl: string) => `docker container inspect -f '${tpl}' "$ID" 2>/dev/null`;
  return [
    "set -u",
    `ID=$(docker container inspect -f '{{.Id}}' ${COOLIFY_PROXY_NAME} 2>/dev/null)`,
    'if [ -z "$ID" ]; then echo "TUGRA_SWAP_ABSENT"; exit 0; fi',
    'echo "TUGRA_SWAP_ID=$ID"',
    `echo "TUGRA_SWAP_NAME=$(${f("{{.Name}}")})"`,
    `echo "TUGRA_SWAP_IMAGE=$(${f("{{.Config.Image}}")})"`,
    `echo "TUGRA_SWAP_RESTART=$(${f("{{.HostConfig.RestartPolicy.Name}}")})"`,
    `echo "TUGRA_SWAP_RUNNING=$(${f("{{.State.Running}}")})"`,
    `echo "TUGRA_SWAP_PORTS=$(${f("{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}>{{$p}},{{end}}{{end}}")})"`,
    'echo "TUGRA_SWAP_END"',
  ].join("\n");
}

export type SwapInspect = { absent: true } | { absent: false; snapshot: CoolifyProxySnapshot; name: string };

/** Parse the inspect output; `null` for anything cut or malformed (never mistaken for "absent"). */
export function parseSwapInspect(out: string): SwapInspect | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (lines.includes("TUGRA_SWAP_ABSENT")) return { absent: true };
  if (!lines.includes("TUGRA_SWAP_END")) return null;
  const get = (k: string): string | null => {
    const l = lines.find((x) => x.startsWith(`TUGRA_SWAP_${k}=`));
    return l === undefined ? null : l.slice(`TUGRA_SWAP_${k}=`.length);
  };
  const id = get("ID");
  const name = get("NAME");
  const image = get("IMAGE");
  const restart = get("RESTART");
  const running = get("RUNNING");
  const portsRaw = get("PORTS");
  if (!id || !CONTAINER_ID_RE.test(id) || name === null || !image || !IMAGE_RE.test(image) || restart === null || (running !== "true" && running !== "false") || portsRaw === null) return null;
  // docker reports an empty policy name as "" for `no`
  const policy = restart === "" ? "no" : restart;
  if (!(RESTART_POLICIES as readonly string[]).includes(policy)) return null;
  const ports = portsRaw.split(",").filter(Boolean);
  if (!ports.every((p) => PORT_RE.test(p))) return null;
  return { absent: false, name, snapshot: { containerId: id, name: name.replace(/^\//, ""), image, restartPolicy: policy as RestartPolicy, running: running === "true", ports } };
}

/** Is this really the source's proxy? name + a traefik image + it publishes host :80 and :443 over tcp. Otherwise NOTHING is stopped. */
export function verifyCoolifyProxyIdentity(i: SwapInspect): { ok: true; snapshot: CoolifyProxySnapshot } | { ok: false; code: "absent" | "name" | "image" | "ports" } {
  if (i.absent) return { ok: false, code: "absent" };
  const s = i.snapshot;
  if (i.name !== `/${COOLIFY_PROXY_NAME}`) return { ok: false, code: "name" };
  if (!/traefik/i.test(s.image)) return { ok: false, code: "image" };
  const publishes = (hostPort: number) => s.ports.some((p) => {
    const m = PORT_RE.exec(p);
    return !!m && Number(m[1]) === hostPort && m[3] === "tcp";
  });
  if (!publishes(80) || !publishes(443)) return { ok: false, code: "ports" };
  return { ok: true, snapshot: s };
}

// ───────────────────────────── scripts ─────────────────────────────

/**
 * Step 3: `docker update --restart=no` FIRST (a reboot must not bring Coolify's proxy back over ours), then `docker stop`.
 * If the update fails the stop is NOT issued (fail closed: a half-swap that a reboot would undo). Prints the container's
 * running state so the hub verifies the effect from the host, not from an exit code.
 */
export function buildSwapStopSourceScript(containerId: string): string {
  const id = assertContainerId(containerId);
  return [
    "set -u",
    `ID=${shq(id)}`,
    'if ! docker update --restart=no "$ID" >/dev/null 2>&1; then echo "TUGRA_SWAP_UPDATE_FAILED"; exit 0; fi',
    'docker stop "$ID" >/dev/null 2>&1 || true',
    `echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"`,
  ].join("\n");
}

/**
 * The reverse of the swap on the host: stop Tugra's proxy first (frees :80/:443), restore the RECORDED restart policy on the
 * recorded source proxy id and start it. Never `docker rm`; both containers stay on the box.
 */
export function buildSwapReverseScript(containerId: string, restartPolicy: string): string {
  const id = assertContainerId(containerId);
  const policy = assertRestartPolicy(restartPolicy);
  return [
    "set -u",
    `ID=${shq(id)}`,
    `docker stop ${TUGRA_PROXY_NAME} >/dev/null 2>&1 || true`,
    `docker update --restart=${policy} "$ID" >/dev/null 2>&1 || echo "TUGRA_SWAP_UPDATE_FAILED"`,
    'docker start "$ID" >/dev/null 2>&1 || true',
    `echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"`,
    `echo "TUGRA_SWAP_TARGET=$(docker container inspect -f '{{.State.Status}}' ${TUGRA_PROXY_NAME} 2>/dev/null || echo absent)"`,
  ].join("\n");
}

/** Read-only state of both proxies (the verification after every swap/reverse command and the resume observation). */
export function buildSwapStatusScript(containerId: string): string {
  const id = assertContainerId(containerId);
  return [
    "set -u",
    `ID=${shq(id)}`,
    `echo "TUGRA_SWAP_SOURCE_RUNNING=$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"`,
    `echo "TUGRA_SWAP_TARGET=$(docker container inspect -f '{{.State.Status}}' ${TUGRA_PROXY_NAME} 2>/dev/null || echo absent)"`,
    `echo "TUGRA_SWAP_TARGET_PORTS=$(docker container inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}>{{$p}},{{end}}{{end}}' ${TUGRA_PROXY_NAME} 2>/dev/null)"`,
    'echo "TUGRA_SWAP_STATUS_END"',
  ].join("\n");
}

export interface SwapHostState {
  /** `true`/`false` from docker, or `absent` when the recorded id no longer exists. */
  sourceRunning: boolean | "absent";
  /** Tugra proxy `State.Status` (`running`, `exited`, ...) or `absent`. */
  target: string;
  /** Host ports Tugra's proxy publishes (`80>80/tcp` ...); empty when dark (`proxyBind: none`). */
  targetPorts: string[];
  updateFailed: boolean;
}

/** Parse any of the three scripts' state markers. `null` when the output is cut or has no source marker. */
export function parseSwapState(out: string): SwapHostState | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  const get = (k: string) => {
    const l = lines.find((x) => x.startsWith(`TUGRA_SWAP_${k}=`));
    return l === undefined ? null : l.slice(`TUGRA_SWAP_${k}=`.length);
  };
  const src = get("SOURCE_RUNNING");
  if (src === null) return lines.includes("TUGRA_SWAP_UPDATE_FAILED") ? { sourceRunning: "absent", target: "absent", targetPorts: [], updateFailed: true } : null;
  if (src !== "true" && src !== "false" && src !== "absent") return null;
  const target = get("TARGET") ?? "absent";
  if (!/^[a-z]{1,20}$/.test(target)) return null;
  const portsRaw = get("TARGET_PORTS") ?? "";
  const targetPorts = portsRaw.split(",").filter(Boolean);
  if (!targetPorts.every((p) => PORT_RE.test(p))) return null;
  return { sourceRunning: src === "absent" ? "absent" : src === "true", target, targetPorts, updateFailed: lines.includes("TUGRA_SWAP_UPDATE_FAILED") };
}

// ───────────────────────────── swap state machine ─────────────────────────────

export const SWAP_STATES = ["PLANNED", "STOPPING_SOURCE_PROXY", "STARTING_TARGET_PROXY", "LIVE", "REVERSING", "REVERSED"] as const;
export type SwapState = (typeof SWAP_STATES)[number];

const SWAP_TRANSITIONS: Readonly<Record<SwapState, readonly SwapState[]>> = {
  PLANNED: ["STOPPING_SOURCE_PROXY", "REVERSING"],
  STOPPING_SOURCE_PROXY: ["STARTING_TARGET_PROXY", "REVERSING"],
  STARTING_TARGET_PROXY: ["LIVE", "REVERSING"],
  LIVE: ["REVERSING"],
  REVERSING: ["REVERSED"],
  REVERSED: [],
};

export function canSwapTransition(from: SwapState, to: SwapState): boolean {
  return from === to || SWAP_TRANSITIONS[from].includes(to);
}

/** The Tugra proxy serves (or may serve) production traffic from here on: the reverse is the only way back. */
export const swapIsPastPlanning = (s: SwapState): boolean => s !== "PLANNED" && s !== "REVERSED";

// ───────────────────────────── plan hash ─────────────────────────────

/**
 * What the human approved for a swap: the run, the server, the exact container that will be stopped and the hosts that
 * move with it (sorted, with their stateful flag). Bound into the VERIFY approval, so a different proxy or host list
 * voids it.
 */
export function swapPlanHash(o: { runId: string; serverId: string; proxy: Pick<CoolifyProxySnapshot, "containerId" | "image" | "ports">; hosts: ReadonlyArray<{ hostname: string; stateful: boolean }> }): string {
  const hosts = [...o.hosts].sort((a, b) => a.hostname.localeCompare(b.hostname)).map((h) => `${h.hostname}:${h.stateful ? 1 : 0}`);
  const body = JSON.stringify(["swap", o.runId, o.serverId, o.proxy.containerId, o.proxy.image, [...o.proxy.ports].sort(), hosts]);
  return createHash("sha256").update(body).digest("hex");
}
