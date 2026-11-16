/**
 * A fake SOURCE HOST for the data steps' specs: a temp directory with a fake `docker` and a fake `curl` on PATH, so the
 * hub-built scripts (inspect / stop / start / state / launcher) run for REAL under `bash -c`, exactly as the agent runs them,
 * and the specs assert on what the host actually experienced (which containers changed state, which docker verbs were
 * called, what reached an argv) instead of on the text of the scripts.
 *
 * The fake docker keeps its containers in `state.json` and appends every invocation to `calls.jsonl`:
 *  - `ps -a --no-trunc --format <tpl>` and `ps -q --filter name=^<prefix>`,
 *  - `inspect -f <tpl> <id>` (`.Id`, `.Name`, `.Config.Image`, `.State.Running`),
 *  - `stop [-t N] <id>` and `start <id>` (an id listed in `failStop` / `failStart` fails),
 *  - anything else is recorded and succeeds (`pull`, `run`, ...).
 * `forbiddenCalls()` returns every call a source host must never see from the engine (`rm`, `kill`, `prune`, `rmi`, ...).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceHostPort } from "../data-contract";

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  ports?: string;
  running: boolean;
}

export interface SourceHostFakeOptions {
  containers: FakeContainer[];
  /** Ids whose `docker stop` / `docker start` fails. */
  failStop?: string[];
  failStart?: string[];
  /** The body of the fake migrator.sh the fake curl serves (default: echo a clean JSON line and exit 0). */
  migratorSh?: string;
  /** Make the fake curl fail (the hub is unreachable from the source host). */
  curlFails?: boolean;
}

const DOCKER_JS = `#!${process.execPath}
const fs = require("fs");
const dir = process.env.FAKE_HOST_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\\n");
const save = () => fs.writeFileSync(dir + "/state.json", JSON.stringify(st));
const render = (tpl, c) =>
  tpl
    .replace(/\\{\\{\\.ID\\}\\}/g, c.id)
    .replace(/\\{\\{\\.Id\\}\\}/g, c.id)
    .replace(/\\{\\{\\.Names\\}\\}/g, c.name)
    .replace(/\\{\\{\\.Name\\}\\}/g, "/" + c.name)
    .replace(/\\{\\{\\.Image\\}\\}/g, c.image)
    .replace(/\\{\\{\\.Config\\.Image\\}\\}/g, c.image)
    .replace(/\\{\\{\\.Ports\\}\\}/g, c.ports || "")
    .replace(/\\{\\{\\.State\\}\\}/g, c.running ? "running" : "exited")
    .replace(/\\{\\{\\.State\\.Running\\}\\}/g, c.running ? "true" : "false");
const cmd = args[0];
if (cmd === "ps") {
  const q = args.includes("-q");
  const fi = args.indexOf("--filter");
  const filter = fi >= 0 ? args[fi + 1] : "";
  const fmtI = args.indexOf("--format");
  const tpl = fmtI >= 0 ? args[fmtI + 1] : "{{.ID}}";
  let list = st.containers;
  if (!args.includes("-a")) list = list.filter((c) => c.running);
  if (filter.startsWith("name=^")) list = list.filter((c) => c.name.startsWith(filter.slice(6)));
  for (const c of list) console.log(q ? c.id : render(tpl, c));
} else if (cmd === "inspect") {
  const fi = args.indexOf("-f");
  const tpl = fi >= 0 ? args[fi + 1] : "{{.Id}}";
  const id = args[args.length - 1];
  const c = st.containers.find((x) => x.id === id);
  if (!c) { console.error("Error: No such object: " + id); process.exit(1); }
  console.log(render(tpl, c));
} else if (cmd === "stop" || cmd === "start") {
  const id = args[args.length - 1];
  const c = st.containers.find((x) => x.id === id);
  const fails = cmd === "stop" ? st.failStop : st.failStart;
  if (!c || fails.includes(id)) { console.error("Error response from daemon"); process.exit(1); }
  c.running = cmd === "start";
  save();
  console.log(id);
}
`;

const CURL_SH = `#!/bin/sh
# fake curl: -fsSL URL -o FILE
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$FAKE_HOST_DIR/curl.log"
[ -f "$FAKE_HOST_DIR/curl.fail" ] && exit 22
cp "$FAKE_HOST_DIR/migrator.sh" "$out"
`;

export const DEFAULT_FAKE_MIGRATOR_SH = `#!/bin/sh
# fake migrator.sh: records what it was started with, prints the migrator's single JSON result line
{
  echo "ARGS: $*"
  if [ -n "\${TUGRA_MIGRATION_TOKEN:-}" ]; then echo "TOKEN_IN_ENV: yes"; else echo "TOKEN_IN_ENV: no"; fi
} > "$FAKE_HOST_DIR/migrator.invocation"
echo '{"tool":"tugra-migrate","version":"test","schema":1,"ok":true,"exit":0,"code":"ok","counts":{"restored":2,"failed":0},"items":[{"itemRef":"database:_:db1","engine":"POSTGRES","state":"restored"}]}'
exit 0
`;

export class SourceHostFake implements SourceHostPort {
  readonly dir: string;
  /** Every `(serverId, capability)` an execution was requested under (the fake host is one machine). */
  readonly runs: Array<{ serverId: string; capability: string; script: string }> = [];

  constructor(opts: SourceHostFakeOptions) {
    this.dir = mkdtempSync(join(tmpdir(), "tugra-srchost-"));
    writeFileSync(join(this.dir, "state.json"), JSON.stringify({ containers: opts.containers, failStop: opts.failStop ?? [], failStart: opts.failStart ?? [] }));
    writeFileSync(join(this.dir, "calls.jsonl"), "");
    writeFileSync(join(this.dir, "docker"), DOCKER_JS);
    chmodSync(join(this.dir, "docker"), 0o755);
    writeFileSync(join(this.dir, "curl"), CURL_SH);
    chmodSync(join(this.dir, "curl"), 0o755);
    writeFileSync(join(this.dir, "migrator.sh"), opts.migratorSh ?? DEFAULT_FAKE_MIGRATOR_SH);
    if (opts.curlFails) writeFileSync(join(this.dir, "curl.fail"), "");
  }

  /** `SourceHostPort.run`: executes the script with bash, the fake docker/curl first on PATH. */
  run(serverId: string, script: string, capability: "migrate" | "database", timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    this.runs.push({ serverId, capability, script });
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", script], { env: { PATH: `${this.dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_HOST_DIR: this.dir, HOME: this.dir }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("fake host command timed out"));
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ exitCode: code ?? 1, output: out });
      });
      child.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  containers(): FakeContainer[] {
    return (JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as { containers: FakeContainer[] }).containers;
  }

  container(id: string): FakeContainer {
    const c = this.containers().find((x) => x.id === id);
    if (!c) throw new Error(`no fake container ${id}`);
    return c;
  }

  /** Set a container's running state directly (a precondition of a spec, not something the engine does). */
  setRunning(id: string, running: boolean): void {
    const st = JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as { containers: FakeContainer[] };
    const c = st.containers.find((x) => x.id === id);
    if (!c) throw new Error("unknown container");
    c.running = running;
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(st));
  }

  /** Replace a container (simulates a recreate: same name, new id). */
  recreate(oldId: string, newId: string): void {
    const st = JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as { containers: FakeContainer[] };
    const c = st.containers.find((x) => x.id === oldId);
    if (!c) throw new Error("unknown container");
    c.id = newId;
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(st));
  }

  calls(): string[][] {
    return readFileSync(join(this.dir, "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  /** Docker verbs the engine must never issue against a source host. */
  forbiddenCalls(): string[][] {
    return this.calls().filter((c) => ["rm", "kill", "prune", "rmi", "volume", "system", "network", "container"].includes(c[0]));
  }

  file(rel: string): string | null {
    const p = join(this.dir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A well-formed 64-hex id from a short seed (tests read better with `ctrId("a")`). */
export const ctrId = (seed: string): string => seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "0");
