/**
 * A fake SOURCE HOST for the inventory specs: a temp directory with a fake `docker`, `du`, `curl`, `timeout` and `hostname` first
 * on PATH, so the real shell function (`inventory-script.ts`) runs for REAL under `sh -c` and the specs assert on what the host
 * experienced (which docker verbs were called, what reached an argv, what was POSTed to the hub) instead of on script text.
 *
 * The fake docker understands exactly the read-only calls the inventory makes (`version`, `ps -a`, `inspect -f` of the mounts, the image
 * id, the environment or the executed command, `image inspect -f` of the RepoDigests, `volume ls -q`, `volume inspect -f`, and the one
 * read-only database listing `exec <c> psql ...` / `exec <c> sh -c '<mysql listing>'`, answered like the engine would from the container's own environment); any other verb is recorded in `calls.jsonl` and fails, so a spec can assert nothing else was called.
 * The fake curl plays the hub: `ping` answers 200 with the configured part size, `sink` accepts a body up to the configured cap
 * (anything bigger is answered 413, like a proxy with a body limit), `host-report` records the posted text.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeMount {
  type: "volume" | "bind" | "tmpfs";
  name?: string;
  source: string;
  dest: string;
  rw?: boolean;
}
export interface FakeInvContainer {
  id: string;
  name: string;
  image: string;
  state?: string;
  mounts?: FakeMount[];
  /** `Config.Env` entries (`KEY=value`) the container was started with. */
  env?: string[];
  /** The executed command: `.Path` and `.Args`. */
  path?: string;
  args?: string[];
  /** `RepoDigests` of the container's image (`repo@sha256:<hex>`); the fake answers them for `docker image inspect`. */
  repoDigests?: string[];
  /** Every database the engine in this container lists (system ones included): what `psql` / `mysql` print when `docker exec` asks. */
  databases?: string[];
  /** `docker exec` into this container fails (a login the container does not give). */
  execFails?: boolean;
}
export interface InventoryHostOptions {
  containers: FakeInvContainer[];
  volumes?: Array<{ name: string; mountpoint?: string }>;
  /** `du -skx <path>` answers: a number of KiB, or "fail" (unreadable / timed out). A path not listed fails. */
  du?: Record<string, number | "fail">;
  hub?: { pingCode?: number; partMiB?: number; capMiB?: number; reportCode?: number; unreachable?: boolean };
  hostname?: string;
  dockerDown?: boolean;
  /** The body the fake curl serves for `<hub>/install/migrator.sh` (to a file with `-o`, else to stdout). */
  migratorSh?: string;
}

const DOCKER_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_HOST_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(["docker", ...args]) + "\\n");
const cmd = args[0];
if (st.dockerDown) { console.error("Cannot connect to the Docker daemon"); process.exit(1); }
if (cmd === "version") { console.log("27.3.1"); }
else if (cmd === "ps") {
  for (const c of st.containers) console.log([c.id, c.name, c.image, c.state || "running"].join("|"));
} else if (cmd === "inspect") {
  const id = args[args.length - 1];
  const fmt = args[args.indexOf("-f") + 1] || "";
  const c = st.containers.find((x) => x.id === id);
  if (!c) { console.error("No such object"); process.exit(1); }
  if (fmt.includes(".Config.Env")) { for (const e of c.env || []) console.log(e); }
  else if (fmt.includes(".Path")) { console.log(c.path || ""); for (const a of c.args || []) console.log(a); }
  else if (fmt.trim() === "{{.Image}}") { console.log("sha256:" + id); }
  else for (const m of c.mounts || []) console.log([m.type, m.name || "", m.source, m.dest, m.rw === false ? "false" : "true"].join("|"));
} else if (cmd === "exec") {
  const c = st.containers.find((x) => x.id === args[1]);
  if (!c || c.state !== "running" || c.execFails) { console.error("Error response from daemon: cannot exec"); process.exit(1); }
  const env = {};
  for (const e of c.env || []) { const i = e.indexOf("="); env[e.slice(0, i)] = e.slice(i + 1); }
  if (args[2] === "psql") {
    const user = args[args.indexOf("-U") + 1];
    if (user !== (env.POSTGRES_USER || "postgres") || !args.includes("--dbname=postgres")) { console.error("FATAL: role does not exist"); process.exit(2); }
    for (const d of c.databases || []) if (!["template0", "template1", "postgres"].includes(d)) console.log(d);
  } else if (args[2] === "sh" && args[3] === "-c") {
    const pw = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD;
    if (!pw || !args[4].includes("-uroot")) { console.error("ERROR 1045 (28000): Access denied"); process.exit(1); }
    for (const d of c.databases || []) console.log(d);
  } else { console.error("fake docker: unsupported exec"); process.exit(2); }
} else if (cmd === "image" && args[1] === "inspect") {
  const imgId = args[args.length - 1].replace(/^sha256:/, "");
  const c = st.containers.find((x) => x.id === imgId);
  if (!c) { console.error("No such image"); process.exit(1); }
  for (const d of c.repoDigests || []) console.log(d);
} else if (cmd === "volume" && args[1] === "ls") {
  for (const v of st.volumes) console.log(v.name);
} else if (cmd === "volume" && args[1] === "inspect") {
  const v = st.volumes.find((x) => x.name === args[args.length - 1]);
  if (!v) process.exit(1);
  console.log(v.mountpoint || "/var/lib/docker/volumes/" + v.name + "/_data");
} else { console.error("fake docker: unsupported verb " + cmd); process.exit(2); }
`;

const DU_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_HOST_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(["du", ...args]) + "\\n");
const p = args[args.length - 1];
const v = st.du[p];
if (typeof v !== "number") { console.error("du: cannot read " + p); process.exit(1); }
console.log(v + "\\t" + p);
`;

const CURL_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_HOST_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch (e) { stdin = ""; }
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(["curl", ...args]) + "\\n");
fs.appendFileSync(dir + "/curl-stdin.log", stdin);
const url = args[args.length - 1];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const out = opt("-o");
const hub = st.hub;
const reply = (code, body) => { if (out && out !== "/dev/null" && body !== undefined) fs.writeFileSync(out, body); if (args.includes("-w")) process.stdout.write(String(code)); process.exit(0); };
if (hub.unreachable) { if (args.includes("-w")) process.stdout.write("000"); process.exit(7); }
if (url.endsWith("/host-probe/ping")) reply(hub.pingCode || 200, JSON.stringify({ ok: true, partMiB: hub.partMiB || 128 }));
else if (url.endsWith("/host-probe/sink")) {
  const f = opt("-T");
  const size = f ? fs.statSync(f).size : 0;
  fs.appendFileSync(dir + "/sink.log", size + "\\n");
  reply(size > (hub.capMiB || 1024) * 1048576 ? 413 : 200, "{}");
} else if (url.endsWith("/host-report")) {
  const d = opt("--data-binary");
  if (d && d.startsWith("@")) fs.writeFileSync(dir + "/posted.txt", fs.readFileSync(d.slice(1)));
  reply(hub.reportCode || 200, "{}");
} else if (url.endsWith("/install/migrator.sh")) {
  const body = fs.existsSync(dir + "/migrator.sh") ? fs.readFileSync(dir + "/migrator.sh") : null;
  if (!body) process.exit(22);
  if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
  process.exit(0);
} else reply(404, "");
`;

export class InventoryHostFake {
  readonly dir: string;

  constructor(opts: InventoryHostOptions) {
    this.dir = mkdtempSync(join(tmpdir(), "tugra-invhost-"));
    const state = {
      containers: opts.containers.map((c) => ({ ...c, state: c.state ?? "running" })),
      volumes: opts.volumes ?? [],
      du: opts.du ?? {},
      hub: { pingCode: 200, partMiB: 128, capMiB: 1024, reportCode: 200, unreachable: false, ...(opts.hub ?? {}) },
      dockerDown: !!opts.dockerDown,
    };
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(state));
    writeFileSync(join(this.dir, "calls.jsonl"), "");
    writeFileSync(join(this.dir, "curl-stdin.log"), "");
    for (const [name, body] of [
      ["docker", DOCKER_JS],
      ["du", DU_JS],
      ["curl", CURL_JS],
    ] as const) {
      writeFileSync(join(this.dir, name), body);
      chmodSync(join(this.dir, name), 0o755);
    }
    if (opts.migratorSh) writeFileSync(join(this.dir, "migrator.sh"), opts.migratorSh);
    writeFileSync(join(this.dir, "hostname"), `#!/bin/sh\necho ${opts.hostname ?? "host-a"}\n`);
    chmodSync(join(this.dir, "hostname"), 0o755);
  }

  /** Run a shell program with the fake tools first on PATH. `input` is the stdin of the program. */
  sh(program: string, env: Record<string, string> = {}, input = ""): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("sh", ["-c", program], {
      input,
      encoding: "utf8",
      env: { PATH: `${this.dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_HOST_DIR: this.dir, HOME: this.dir, ...env },
    });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }

  calls(): string[][] {
    return readFileSync(join(this.dir, "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  file(rel: string): string | null {
    const p = join(this.dir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
