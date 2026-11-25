import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isSafePm2Name, type Pm2Fact, type Pm2FactsUser } from "./pm2-facts";

/**
 * The move planner: PM2 facts (+ the stored scan's CloudPanel sites) -> one plan per process. PURE: no I/O, no env values.
 * A process is "ready" only when every part of it can be re-created faithfully in an official Node image; anything the
 * planner cannot prove it can carry over is "unsupported" with a reason (never a silent best effort).
 */

export const NODE_MAJOR_MIN = 10;
export const NODE_MAJOR_MAX = 30;
/** Node majors that are past end of life: still runnable, but the preview says so. */
export const NODE_EOL_MAJOR_MAX = 20;
/** The majors an engines range may resolve to (current and maintenance lines). */
const ENGINE_CANDIDATES = [18, 20, 22, 24, 26];
const NVM_CODENAMES: Record<string, number> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

export type Pm2Reason =
  | "not-running"
  | "cluster-instances"
  | "duplicate-name"
  | "name-unsafe"
  | "interpreter"
  | "script-kind"
  | "script-missing"
  | "script-outside"
  | "no-cwd"
  | "cwd-missing"
  | "cwd-unsafe"
  | "args-unsafe"
  | "no-user";
export type Pm2Warning = "root" | "node-eol" | "no-port" | "owner-differs" | "cluster-single";
export type NodeSource = "interpreter" | "nvmrc" | "engines" | "override" | "none";
export type Pm2PlanStatus = "ready" | "needs-node" | "unsupported";

export interface ScanSiteLite {
  names: string[];
  root: string;
  kind: string;
  port?: number;
  siteUser?: string;
}

export interface Pm2Overrides {
  nodeMajor?: number;
  probePath?: string | null;
}

export interface Pm2Plan {
  key: string;
  user: string;
  name: string;
  status: Pm2PlanStatus;
  reasons: Pm2Reason[];
  warnings: Pm2Warning[];
  /** The interpreter name when the reason is "interpreter" (python3, bash ...): shown, never executed. */
  interpreter: string | null;
  nodeMajor: number | null;
  nodeSource: NodeSource;
  image: string | null;
  command: string[];
  workDir: string | null;
  mountDir: string | null;
  uid: number | null;
  gid: number | null;
  port: number | null;
  portSource: "env" | "site" | "none";
  probePath: string | null;
  domains: string[];
  envCount: number;
  planHash: string;
}

/** Everything the executor needs beyond the view: the validated spec of the container and the PM2 account. Never sent to a browser. */
export interface Pm2Exec {
  user: string;
  home: string;
  userUid: number;
  name: string;
  image: string;
  command: string[];
  workDir: string;
  mountDir: string;
  uid: number;
  gid: number;
  healthPort: number | null;
  probePath: string | null;
  dockerOptions: string;
  /** Directory of the node binary PM2 used (where its sibling `pm2` usually lives); null when the interpreter was not a path. */
  interpreterDir: string | null;
  envDigest: string;
}

export interface PlannedProcess {
  plan: Pm2Plan;
  exec: Pm2Exec | null;
}

// ── node version ────────────────────────────────────────────────────────────────────────────────────────────────────

const VERSION_IN_PATH_RE = /(?:^|[/_-])v?(\d{1,2})\.\d{1,3}\.\d{1,3}(?:[/_.-]|$)/;

/** The node major a node binary path names (nvm / n / volta / fnm / a tarball dir), or null. */
export function nodeMajorFromPath(p: string): number | null {
  const m = VERSION_IN_PATH_RE.exec(p);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= NODE_MAJOR_MIN && n <= NODE_MAJOR_MAX ? n : null;
}

/** `.nvmrc` first line -> major: "v20", "20.11.1", "lts/iron". `lts/*`, `node`, `stable` name no version. */
export function nodeMajorFromNvmrc(line: string): number | null {
  const s = line.trim().toLowerCase();
  const code = /^lts\/([a-z]+)$/.exec(s);
  if (code) return NVM_CODENAMES[code[1]] ?? null;
  const m = /^v?(\d{1,2})(?:\.|$)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= NODE_MAJOR_MIN && n <= NODE_MAJOR_MAX ? n : null;
}

/** package.json engines.node -> the lowest candidate major the range admits. Only ranges the planner fully understands resolve. */
export function nodeMajorFromEngines(range: string): number | null {
  const alts = range.split("||").map((a) => a.trim());
  if (alts.length === 0 || alts.some((a) => a === "")) return null;
  for (const alt of alts) {
    const cons: { op: string; major: number }[] = [];
    let ok = true;
    // "18.x", "20", "^20.1", "~18.17.0", ">=18 <23", ">= 18.0.0", "=20"
    const tokens = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d{1,2})(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/.exec(t);
      if (!m) {
        ok = false;
        break;
      }
      cons.push({ op: m[1] ?? "=", major: Number(m[2]) });
    }
    if (!ok || cons.length === 0) continue;
    for (const c of ENGINE_CANDIDATES) {
      const pass = cons.every(({ op, major }) => {
        switch (op) {
          case ">=":
            return c >= major;
          case ">":
            return c > major;
          case "<=":
            return c <= major;
          case "<":
            return c < major;
          default:
            return c === major; // "=", "^", "~" and a bare major pin the major
        }
      });
      if (pass) return c;
    }
    // A pinned major that is not among the candidates (a bare "16" or "^14"): honour it exactly.
    const pins = cons.filter((c) => ["=", "^", "~"].includes(c.op));
    if (pins.length === 1 && cons.length === 1 && pins[0].major >= NODE_MAJOR_MIN && pins[0].major <= NODE_MAJOR_MAX) return pins[0].major;
  }
  return null;
}

export function resolveNode(f: Pm2Fact, override?: number): { major: number | null; source: NodeSource } {
  if (override !== undefined && Number.isInteger(override) && override >= NODE_MAJOR_MIN && override <= NODE_MAJOR_MAX) return { major: override, source: "override" };
  if (f.interpreter.startsWith("/")) {
    const m = nodeMajorFromPath(f.interpreter);
    if (m) return { major: m, source: "interpreter" };
  }
  const rc = nodeMajorFromNvmrc(f.nvmrc);
  if (rc) return { major: rc, source: "nvmrc" };
  const en = nodeMajorFromEngines(f.enginesNode);
  if (en) return { major: en, source: "engines" };
  return { major: null, source: "none" };
}

// ── what runs it ────────────────────────────────────────────────────────────────────────────────────────────────────

const TOOLS = new Set(["npm", "yarn", "npx"]);
const NOT_NODE_EXT = new Set([".ts", ".tsx", ".py", ".sh", ".bash", ".rb", ".php", ".pl", ".lua", ".ps1", ".exe"]);
const NODE_EXT = new Set([".js", ".mjs", ".cjs"]);

type Kind = { kind: "node" } | { kind: "tool"; tool: string } | { reason: "interpreter"; interpreter: string } | { reason: "script-kind" };

function classify(f: Pm2Fact): Kind {
  const interp = f.interpreter.trim();
  const ibase = posix.basename(interp).toLowerCase();
  const isNodeBin = ibase === "node" || ibase === "nodejs" || /^node\d+$/.test(ibase);
  const scriptBase = posix.basename(f.script);
  const ext = posix.extname(scriptBase).toLowerCase();
  if (interp !== "" && interp.toLowerCase() !== "none" && !isNodeBin) {
    return { reason: "interpreter", interpreter: ibase.slice(0, 40) };
  }
  if (TOOLS.has(scriptBase)) return { kind: "tool", tool: scriptBase };
  if (NOT_NODE_EXT.has(ext)) return { reason: "script-kind" };
  if (NODE_EXT.has(ext) || (isNodeBin && ext === "")) return { kind: "node" };
  return { reason: "script-kind" };
}

// ── the directory that gets mounted ─────────────────────────────────────────────────────────────────────────────────

const SAFE_DIR_RE = /^\/[A-Za-z0-9._@+/-]+$/;
const DENY_EXACT = new Set([
  "/", "/home", "/root", "/etc", "/var", "/usr", "/opt", "/srv", "/tmp", "/mnt", "/media", "/boot", "/lib", "/lib64", "/bin", "/sbin",
  "/dev", "/proc", "/sys", "/run", "/data", "/var/www", "/var/lib", "/var/log", "/var/run", "/var/tmp",
]);
const DENY_TREES = ["/etc", "/proc", "/sys", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/run", "/var/run", "/var/lib/docker"];
const DENY_SEGMENTS = new Set([".ssh", ".pm2", ".gnupg", ".aws", ".docker", ".kube"]);

/** Why `dir` must not be mounted read-write into a container, or null when it may. `home` is the PM2 account's home. */
export function mountDirProblem(dir: string, home: string): "cwd-unsafe" | null {
  if (!SAFE_DIR_RE.test(dir) || posix.normalize(dir) !== dir || dir.endsWith("/")) return "cwd-unsafe";
  if (DENY_EXACT.has(dir)) return "cwd-unsafe";
  if (DENY_TREES.some((t) => dir === t || dir.startsWith(`${t}/`))) return "cwd-unsafe";
  const segs = dir.split("/").filter(Boolean);
  if (segs.length < 2) return "cwd-unsafe";
  if (segs.some((s) => DENY_SEGMENTS.has(s))) return "cwd-unsafe";
  // Never a directory that CONTAINS the PM2 home (its dump holds every other process's environment) or is a home itself.
  if (home === dir || home.startsWith(`${dir}/`)) return "cwd-unsafe";
  if (segs[0] === "home" && segs.length < 3) return "cwd-unsafe";
  return null;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PROBE_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;
export function validProbePath(p: string | null | undefined): string | null {
  return typeof p === "string" && PROBE_PATH_RE.test(p) ? p : null;
}

function portFromSites(sites: ScanSiteLite[], user: string, cwd: string): { port: number | null; domains: string[] } {
  const proxies = sites.filter((s) => s.kind === "proxy" && s.port);
  const rootMatch = proxies.filter((s) => s.root && (cwd === s.root || cwd.startsWith(`${s.root}/`) || s.root.startsWith(`${cwd}/`)));
  const pool = rootMatch.length > 0 ? rootMatch : proxies.filter((s) => s.siteUser === user);
  const ports = [...new Set(pool.map((s) => s.port as number))];
  if (ports.length !== 1) return { port: null, domains: [] };
  return { port: ports[0], domains: [...new Set(pool.flatMap((s) => s.names))].slice(0, 10) };
}

export function planProcess(
  user: Pm2FactsUser,
  f: Pm2Fact,
  ctx: { sites: ScanSiteLite[]; override?: Pm2Overrides },
): PlannedProcess {
  const reasons: Pm2Reason[] = [];
  const warnings: Pm2Warning[] = [];
  const key = `${user.user}/${f.name}`;
  let interpreterName: string | null = null;

  if (!f.nameExact || !isSafePm2Name(f.name)) reasons.push("name-unsafe");
  if (f.status !== "online") reasons.push("not-running");
  if (f.mode === "cluster" && f.instances > 1) reasons.push("cluster-instances");
  else if (f.instances > 1) reasons.push("duplicate-name");

  const cls = classify(f);
  if ("reason" in cls) {
    reasons.push(cls.reason);
    if (cls.reason === "interpreter") interpreterName = cls.interpreter;
  }

  const cwd = f.cwd;
  if (!cwd || !cwd.startsWith("/")) reasons.push("no-cwd");
  else if (!f.cwdExists) reasons.push("cwd-missing");
  else if (mountDirProblem(cwd, user.home)) reasons.push("cwd-unsafe");

  if ("kind" in cls && cls.kind === "node") {
    if (!f.script.startsWith("/")) reasons.push("script-outside");
    else if (cwd && !f.script.startsWith(`${cwd}/`)) reasons.push("script-outside");
    else if (!f.scriptExists) reasons.push("script-missing");
    else if (!SAFE_DIR_RE.test(f.script)) reasons.push("script-outside");
  }
  const allArgs = [...f.args, ...f.nodeArgs, ...f.interpreterArgs];
  if (f.argsOverflow || allArgs.some((a) => CONTROL.test(a))) reasons.push("args-unsafe");
  if ("kind" in cls && cls.kind === "tool" && (f.nodeArgs.length > 0 || f.interpreterArgs.length > 0)) reasons.push("args-unsafe");

  const ready = reasons.length === 0 && "kind" in cls;
  const supportedShape = "kind" in cls;

  // Node version (only meaningful for something that can run on node at all).
  const nv = supportedShape ? resolveNode(f, ctx.override?.nodeMajor) : { major: null, source: "none" as NodeSource };

  const uid = f.uid ?? user.uid;
  const gid = f.gid ?? user.gid;
  if (uid === 0 || gid === 0) warnings.push("root");
  if (f.cwdExists && f.cwdUid !== uid) warnings.push("owner-differs");
  if (nv.major !== null && nv.major <= NODE_EOL_MAJOR_MAX) warnings.push("node-eol");
  if (f.mode === "cluster") warnings.push("cluster-single");

  // Port: the saved PORT wins, else the one CloudPanel proxies this directory's site to.
  let port: number | null = f.port ?? null;
  let portSource: Pm2Plan["portSource"] = port ? "env" : "none";
  let domains: string[] = [];
  if (cwd) {
    const s = portFromSites(ctx.sites, user.user, cwd);
    if (port === null && s.port !== null) {
      port = s.port;
      portSource = "site";
    }
    if (port !== null && s.port === port) domains = s.domains;
  }
  if (port === null) warnings.push("no-port");
  const probePath = port !== null ? validProbePath(ctx.override?.probePath) : null;

  let command: string[] = [];
  if ("kind" in cls) {
    command = cls.kind === "node" ? ["node", ...f.nodeArgs, ...f.interpreterArgs, f.script, ...f.args] : [cls.tool, ...f.args];
  }
  const image = nv.major !== null ? `node:${nv.major}` : null;

  const status: Pm2PlanStatus = !ready ? "unsupported" : nv.major === null ? "needs-node" : "ready";
  const dockerOptions = ready && cwd ? `--network host -u ${uid}:${gid} -w ${cwd} -v ${cwd}:${cwd}` : "";

  const plan: Pm2Plan = {
    key,
    user: user.user,
    name: f.name,
    status,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    interpreter: interpreterName,
    nodeMajor: nv.major,
    nodeSource: nv.source,
    image,
    command: ready ? command : [],
    workDir: ready ? cwd : null,
    mountDir: ready ? cwd : null,
    uid: ready ? uid : null,
    gid: ready ? gid : null,
    port,
    portSource,
    probePath,
    domains,
    envCount: f.envCount,
    planHash: "",
  };
  plan.planHash = hashPlan(plan, f.envDigest);

  const exec: Pm2Exec | null =
    ready && nv.major !== null && image && cwd
      ? {
          user: user.user,
          home: user.home,
          userUid: user.uid,
          name: f.name,
          image,
          command,
          workDir: cwd,
          mountDir: cwd,
          uid,
          gid,
          healthPort: port,
          probePath,
          dockerOptions,
          interpreterDir: f.interpreter.startsWith("/") && SAFE_DIR_RE.test(f.interpreter) ? posix.dirname(f.interpreter) : null,
          envDigest: f.envDigest,
        }
      : null;
  return { plan, exec };
}

/** A fingerprint of the plan AND the environment it was made with: a move refuses to run when either changed since the preview. */
export function hashPlan(p: Omit<Pm2Plan, "planHash"> | Pm2Plan, envDigest: string): string {
  const body = JSON.stringify([p.key, p.status, p.image, p.command, p.workDir, p.mountDir, p.uid, p.gid, p.port, p.probePath, envDigest]);
  return createHash("sha256").update(body).digest("hex");
}

/** Every process of every PM2 home, planned. Overrides are keyed `user/name`. */
export function planAll(users: Pm2FactsUser[], sites: ScanSiteLite[], overrides: Record<string, Pm2Overrides> = {}): PlannedProcess[] {
  const out: PlannedProcess[] = [];
  for (const u of users) for (const f of u.procs) out.push(planProcess(u, f, { sites, override: overrides[`${u.user}/${f.name}`] }));
  return out;
}
