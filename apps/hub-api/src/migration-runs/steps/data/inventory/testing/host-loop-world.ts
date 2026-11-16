/**
 * A fake COOLIFY HOST for the host-loop specs: a temp directory with a fake `ssh`, `docker` (only `exec ... psql`, the Coolify
 * database lookup), `curl` (the report POST to the hub) and `sleep`, so the script the hub prints runs for REAL under `sh`.
 *
 * The fake `ssh` plays the network: it needs the key file it was given to exist, answers 255 for a host that is down or unknown
 * (like a refused connection), and otherwise runs the remote command locally with the matching fake SOURCE HOST first on PATH
 * (a `SourceHostFake` or an `InventoryHostFake`), feeding it the stdin it received. The remote run-directory roots are
 * redirected into each fake host's own directory, so two hosts never share a run directory (a stand-in for two machines).
 * Every ssh argv is logged to `ssh.jsonl` so a spec can assert that no token or key material reaches an argv.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorldServer {
  uuid: string;
  ip: string;
  port?: number;
  user?: string;
  /** The Coolify private key uuid; the key FILE `ssh_key@<keyUuid>` exists unless `noKeyFile` is set. */
  keyUuid?: string;
  noKeyFile?: boolean;
  /** The directory of the fake source host (SourceHostFake.dir / InventoryHostFake.dir); absent = the host is down. */
  hostDir?: string;
}

export interface HostLoopWorldOptions {
  servers: WorldServer[];
  /** The Coolify database lookup fails. */
  psqlFails?: boolean;
  /** The curl that POSTs to the hub fails. */
  postFails?: boolean;
  /** The first N posts to the hub fail, then it answers (a hub that was briefly unreachable). */
  postFailsFirst?: number;
  /** The Coolify host is itself a source (`host.docker.internal`): its docker calls go to this fake host directory. */
  localHostDir?: string;
}

const SSH_JS = (remoteRoots: string[]) => `#!${process.execPath}
const fs = require("fs");
const cp = require("child_process");
const dir = process.env.FAKE_WORLD_DIR;
const world = JSON.parse(fs.readFileSync(dir + "/world.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/ssh.jsonl", JSON.stringify(args) + "\\n");
let key = null, i = 0;
while (i < args.length && args[i].startsWith("-")) {
  if (args[i] === "-i") key = args[i + 1];
  i += 2;
}
const target = args[i], cmd = args[i + 1];
const ip = target.split("@")[1];
const srv = world.servers.find((s) => s.ip === ip);
if (!key || !fs.existsSync(key) || !srv || !srv.hostDir) { process.stderr.write("ssh: connect to host " + ip + " port 22: Connection refused\\n"); process.exit(255); }
let input = fs.readFileSync(0, "utf8");
for (const root of ${JSON.stringify(remoteRoots)}) input = input.split(root).join(srv.hostDir + "/runs");
const r = cp.spawnSync("sh", ["-c", cmd], { input, encoding: "utf8", env: { PATH: srv.hostDir + ":" + process.env.ORIG_PATH, FAKE_HOST_DIR: srv.hostDir, HOME: srv.hostDir } });
process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
process.exit(r.status === null ? 1 : r.status);
`;

const DOCKER_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_WORLD_DIR;
const world = JSON.parse(fs.readFileSync(dir + "/world.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/docker.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "exec" && world.psqlFails) { console.error("Error: No such container: coolify-db"); process.exit(1); }
if (args[0] === "exec") {
  const sql = args[args.length - 1];
  const wanted = [...sql.matchAll(/'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]);
  for (const s of world.servers) if (wanted.includes(s.uuid)) console.log([s.uuid, s.ip, s.port === undefined ? "" : s.port, s.user || "", s.keyUuid || ""].join("|"));
  process.exit(0);
}
if (world.localHostDir) {
  const r = require("child_process").spawnSync(world.localHostDir + "/docker", args, { stdio: "inherit", env: { ...process.env, FAKE_HOST_DIR: world.localHostDir } });
  process.exit(r.status === null ? 1 : r.status);
}
process.exit(2);
`;

const CURL_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_WORLD_DIR;
const world = JSON.parse(fs.readFileSync(dir + "/world.json", "utf8"));
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(dir + "/curl.jsonl", JSON.stringify(args) + "\\n");
fs.appendFileSync(dir + "/curl-stdin.log", stdin);
if (world.postFails) process.exit(7);
if (world.postFailsFirst) {
  const f = dir + "/curl.count";
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  fs.writeFileSync(f, String(n + 1));
  if (n < world.postFailsFirst) process.exit(7);
}
const d = args.indexOf("--data-binary");
if (d >= 0 && args[d + 1].startsWith("@")) fs.appendFileSync(dir + "/posted.txt", fs.readFileSync(args[d + 1].slice(1)));
process.exit(0);
`;

export class HostLoopWorld {
  readonly dir: string;
  readonly keyDir: string;

  constructor(opts: HostLoopWorldOptions, remoteRoots: string[]) {
    this.dir = mkdtempSync(join(tmpdir(), "tugra-loopworld-"));
    this.keyDir = join(this.dir, "keys");
    mkdirSync(this.keyDir);
    for (const s of opts.servers) {
      if (!s.noKeyFile) writeFileSync(join(this.keyDir, `ssh_key@${s.keyUuid ?? s.uuid}`), "not a real key: the fake ssh only checks that the file exists\n");
      if (s.hostDir) mkdirSync(join(s.hostDir, "runs"), { recursive: true });
    }
    writeFileSync(join(this.dir, "world.json"), JSON.stringify({ servers: opts.servers, psqlFails: !!opts.psqlFails, postFails: !!opts.postFails, postFailsFirst: opts.postFailsFirst ?? 0, localHostDir: opts.localHostDir ?? null }));
    for (const f of ["ssh.jsonl", "docker.jsonl", "curl.jsonl", "curl-stdin.log", "posted.txt"]) writeFileSync(join(this.dir, f), "");
    const bin = join(this.dir, "bin");
    mkdirSync(bin);
    for (const [name, body] of [
      ["ssh", SSH_JS(remoteRoots)],
      ["docker", DOCKER_JS],
      ["curl", CURL_JS],
      ["sleep", "#!/bin/sh\nexec /bin/sleep 0.05\n"],
    ] as const) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
  }

  /** Run a script (as a file, `sh <file>`) with the fake tools first on PATH. */
  run(script: string, env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    const file = join(this.dir, "script.sh");
    writeFileSync(file, script);
    const r = spawnSync("sh", [file], {
      encoding: "utf8",
      env: { PATH: `${join(this.dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, ORIG_PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_WORLD_DIR: this.dir, HOME: this.dir, TUGRA_LOOP_POLL: "0", ...env },
    });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }

  /** Run a pasted command (the heredoc wrapper) through `sh -c`. */
  runCommand(command: string, env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: `${join(this.dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, ORIG_PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_WORLD_DIR: this.dir, HOME: this.dir, TUGRA_LOOP_POLL: "0", ...env },
    });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }

  private lines(rel: string): string[][] {
    return readFileSync(join(this.dir, rel), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }
  sshCalls = (): string[][] => this.lines("ssh.jsonl");
  dockerCalls = (): string[][] => this.lines("docker.jsonl");
  curlCalls = (): string[][] => this.lines("curl.jsonl");
  /** Everything POSTed to the hub, as text. */
  posted = (): string => readFileSync(join(this.dir, "posted.txt"), "utf8");
  /** What the hub-bound curl received on stdin (the config carrying the Authorization header). */
  curlStdin = (): string => readFileSync(join(this.dir, "curl-stdin.log"), "utf8");
  has = (rel: string): boolean => existsSync(join(this.dir, rel));

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
