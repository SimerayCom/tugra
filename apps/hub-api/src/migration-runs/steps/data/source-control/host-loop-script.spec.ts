import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMigratorInstallScript } from "../../../../install/migrator-install-script";
import { SourceHostFake, ctrId } from "../testing/source-host-fake";
import { InventoryHostFake } from "../inventory/testing/inventory-host-fake";
import { HostLoopWorld, type WorldServer } from "../inventory/testing/host-loop-world";
import { parseReportBody } from "../inventory/host-protocol";
import { buildHostLoopScript, launchAttemptFor, onlyFlags, wrapHostLoopCommand, type HostLoopInput } from "./host-loop-script";

const TOKEN = `tugra_mig_${"B".repeat(43)}`;
const HUB = "https://hub.example.test";
const RUN = "cmrun00000001";
const ROOT = "/tmp/tugra-loop-test-root";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface Built {
  world: HostLoopWorld;
  hosts: Record<string, SourceHostFake>;
}

/** Two fake source hosts behind a fake Coolify host. `extra` adds servers (unreachable, keyless...). */
function world(opts: { containers?: Record<string, ConstructorParameters<typeof SourceHostFake>[0]["containers"]>; extra?: WorldServer[]; psqlFails?: boolean; postFails?: boolean; curlFails?: boolean; migratorSh?: string } = {}): Built {
  const a = new SourceHostFake({ containers: opts.containers?.a ?? [], curlFails: opts.curlFails, migratorSh: opts.migratorSh });
  const b = new SourceHostFake({ containers: opts.containers?.b ?? [], migratorSh: opts.migratorSh });
  const servers: WorldServer[] = [
    { uuid: "srv-a", ip: "10.0.0.1", port: 22, user: "root", keyUuid: "keyaaaa", hostDir: a.dir },
    { uuid: "srv-b", ip: "10.0.0.2", port: 2222, user: "root", keyUuid: "keybbbb", hostDir: b.dir },
    ...(opts.extra ?? []),
  ];
  const w = new HostLoopWorld({ servers, psqlFails: opts.psqlFails, postFails: opts.postFails }, [ROOT, "/etc/tugra/migrate"]);
  cleanups.push(() => {
    w.dispose();
    a.dispose();
    b.dispose();
  });
  return { world: w, hosts: { a, b } };
}

const input = (w: HostLoopWorld, over: Partial<HostLoopInput> = {}): HostLoopInput => ({
  runId: RUN,
  step: "DATA_SEED",
  phase: "inspect",
  hubBase: HUB,
  token: TOKEN,
  hosts: [
    { ref: "srv-a", flags: ["--arms", "all", "--dry-run", ...onlyFlags(["database:srv-a:db1"])], freezeItems: [] },
    { ref: "srv-b", flags: ["--arms", "all", "--dry-run", ...onlyFlags(["database:srv-b:db2"])], freezeItems: [] },
  ],
  keyDir: w.keyDir,
  parallel: 1,
  connectTimeoutSec: 15,
  retries: 1,
  root: ROOT,
  ...over,
});

const loopLines = (text: string) => parseReportBody(text).loop.map((l) => `${l.ref}:${l.state}:${l.code}`);

describe("buildHostLoopScript: input validation (it runs as root on the Coolify host)", () => {
  const w = { keyDir: "/data/coolify/ssh/keys" } as HostLoopWorld;
  const ok = input(w);

  it("is valid POSIX shell (sh -n) for every step", () => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-syn-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const step of ["DATA_SEED", "DATA_FINAL", "FREEZE", "INVENTORY"] as const) {
      const f = join(dir, `${step}.sh`);
      writeFileSync(f, buildHostLoopScript({ ...ok, step, phase: step === "DATA_FINAL" ? "final" : "inspect", hosts: ok.hosts.map((h) => ({ ...h, freezeItems: ["app:srv-a:abcdefghijklmnopqrstuvwx"] })) }));
      expect(spawnSync("sh", ["-n", f]).status).toBe(0);
    }
  });

  it("refuses anything that is not safe to embed", () => {
    const bad: Array<Partial<HostLoopInput>> = [
      { token: "tugra_mig_short" },
      { token: `${TOKEN}; reboot` },
      { hubBase: "https://hub.example.test;reboot" },
      { runId: "run id; x" },
      { keyDir: "/data/../etc" },
      { keyDir: "/data/keys; reboot" },
      { keyDir: "relative/keys" },
      { parallel: 0 },
      { parallel: 9 },
      { connectTimeoutSec: 4 },
      { retries: 6 },
      { hosts: [] },
      { hosts: [{ ref: "srv a", flags: [], freezeItems: [] }] },
      { hosts: [{ ref: "x'; reboot; '", flags: [], freezeItems: [] }] },
      { hosts: [{ ref: "srv-a", flags: ["--only", "a b"], freezeItems: [] }] },
      { hosts: [{ ref: "srv-a", flags: ["$(reboot)"], freezeItems: [] }] },
      { hosts: [{ ref: "srv-a", flags: [], freezeItems: ["app:x:y;reboot"] }] },
      { hosts: [ok.hosts[0], ok.hosts[0]] },
      { step: "VERIFY" as never },
      { phase: undefined },
    ];
    for (const b of bad) expect(() => buildHostLoopScript({ ...ok, ...b })).toThrow();
  });

  it("the inspect and warm-db phases use different remote run directories, the final phase its own", () => {
    expect(launchAttemptFor("inspect")).not.toBe(launchAttemptFor("warm-db"));
    const s = (phase: "inspect" | "warm-db" | "final") => buildHostLoopScript({ ...ok, step: phase === "final" ? "DATA_FINAL" : "DATA_SEED", phase });
    expect(s("inspect")).toContain(`${RUN}-seed-1`);
    expect(s("warm-db")).toContain(`${RUN}-seed-2`);
    expect(s("final")).toContain(`${RUN}-final-1`);
  });

  it("selects the database through the Coolify database for uuid, ip, port, user and the key's uuid only (never key material)", () => {
    const s = buildHostLoopScript(ok);
    expect(s).toMatch(/select s\.uuid, s\.ip, s\.port, s\.\\"user\\", coalesce\(k\.uuid/);
    expect(s).not.toMatch(/private_key\b[^s]/); // the table private_keys is joined for its uuid; the key column is never selected
    expect(s).not.toMatch(/k\.private_key/);
  });

  it("the token appears exactly once in the script (every host's remote text is fed from it)", () => {
    expect(buildHostLoopScript(ok).split(TOKEN).length - 1).toBe(1);
  });
});

describe("coolify-host-loop runner: DATA_SEED / DATA_FINAL, run for real against fake hosts", () => {
  it("launches the migrator on every host over its own key with that host's --only items, streams the status back, and finishes", () => {
    const { world: w, hosts } = world();
    const r = w.run(buildHostLoopScript(input(w)));
    expect(r.code).toBe(0);
    const posted = w.posted();
    expect(loopLines(posted)).toEqual(expect.arrayContaining(["srv-a:connecting:ssh", "srv-a:launched:started", "srv-a:finished:ok", "srv-b:connecting:ssh", "srv-b:launched:started", "srv-b:finished:ok"]));
    // each host's migrator got ITS items only, the hub base, and the token in the ENVIRONMENT
    for (const [h, ref] of [
      [hosts.a, "database:srv-a:db1"],
      [hosts.b, "database:srv-b:db2"],
    ] as const) {
      const inv = h.file("migrator.invocation")!;
      expect(inv).toContain(`ARGS: --hub ${HUB} --arms all --dry-run --only ${ref}`);
      expect(inv).toContain("TOKEN_IN_ENV: yes");
    }
    // the right key file and port per host; the fake hosts were reached with BatchMode
    const ssh = w.sshCalls();
    expect(ssh.some((c) => c.includes("-i") && c[c.indexOf("-i") + 1] === join(w.keyDir, "ssh_key@keyaaaa") && c.includes("root@10.0.0.1") && c[c.indexOf("-p") + 1] === "22")).toBe(true);
    expect(ssh.some((c) => c[c.indexOf("-i") + 1] === join(w.keyDir, "ssh_key@keybbbb") && c.includes("root@10.0.0.2") && c[c.indexOf("-p") + 1] === "2222")).toBe(true);
    for (const c of ssh) expect(c).toEqual(expect.arrayContaining(["BatchMode=yes", "IdentitiesOnly=yes"]));
    expect(r.stdout).toContain("[srv-a] finished ok");
  });

  it("never puts the token, or any key material, on an argv (ssh, curl, docker) and posts it to the hub as a curl config on stdin", () => {
    const { world: w } = world();
    w.run(buildHostLoopScript(input(w)));
    for (const c of [...w.sshCalls(), ...w.curlCalls(), ...w.dockerCalls()]) {
      expect(c.join(" ")).not.toContain(TOKEN);
      expect(c.join(" ")).not.toContain("not a real key");
    }
    expect(w.curlStdin()).toContain(`Authorization: Bearer ${TOKEN}`);
    // the Coolify database was asked about the run's hosts only, and read-only (select)
    const exec = w.dockerCalls().find((c) => c[0] === "exec")!;
    expect(exec.join(" ")).toContain("'srv-a','srv-b'");
    expect(exec[exec.length - 1]).toMatch(/^select /);
  });

  it("is idempotent and resumable: a second run re-attaches (already) and does not start a second migrator", () => {
    const { world: w, hosts } = world();
    const script = buildHostLoopScript(input(w));
    w.run(script);
    const second = w.run(script);
    expect(second.code).toBe(0);
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-a:already:already"]));
    expect((hosts.a.file("curl.log") ?? "").trim().split("\n")).toHaveLength(1); // migrator.sh was fetched once
  });

  it("an unreachable host is retried, reported `unreachable`, does not stop the others, and the script exits non-zero", () => {
    const { world: w, hosts } = world({ extra: [{ uuid: "srv-c", ip: "10.0.0.3", keyUuid: "keycccc" }] });
    const r = w.run(buildHostLoopScript(input(w, { hosts: [...input(w).hosts, { ref: "srv-c", flags: ["--arms", "all"], freezeItems: [] }] })));
    expect(r.code).not.toBe(0);
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-c:unreachable:ssh-failed", "srv-a:finished:ok", "srv-b:finished:ok"]));
    expect(w.sshCalls().filter((c) => c.includes("root@10.0.0.3"))).toHaveLength(2); // 1 try + retries(1)
    expect(hosts.a.file("migrator.invocation")).not.toBeNull();
    expect(r.stdout).toContain("1 of 3 hosts need attention");
  });

  it("a server whose key file is missing is `no-key` (ssh is never attempted), an unknown server `no-host`, a failed lookup `lookup-failed`", () => {
    const { world: w } = world({ extra: [{ uuid: "srv-k", ip: "10.0.0.4", keyUuid: "keykkkk", noKeyFile: true }] });
    const hosts = [...input(w).hosts, { ref: "srv-k", flags: ["--arms", "all"], freezeItems: [] }, { ref: "srv-zz", flags: ["--arms", "all"], freezeItems: [] }];
    w.run(buildHostLoopScript(input(w, { hosts })));
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-k:no-key:key-missing", "srv-zz:no-host:host-unknown"]));
    expect(w.sshCalls().some((c) => c.includes("root@10.0.0.4"))).toBe(false);

    const { world: w2 } = world({ psqlFails: true });
    const r2 = w2.run(buildHostLoopScript(input(w2)));
    expect(r2.code).not.toBe(0);
    expect(loopLines(w2.posted())).toEqual(expect.arrayContaining(["srv-a:no-host:lookup-failed", "srv-b:no-host:lookup-failed"]));
  });

  it("R8: a source host that cannot fetch from the hub is reported as such (hub-unreachable-from-host)", () => {
    const { world: w } = world({ curlFails: true });
    const r = w.run(buildHostLoopScript(input(w)));
    expect(r.code).not.toBe(0);
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-a:failed:hub-unreachable-from-host"]));
  });

  it("a migrator that ends with a failure code is reported finished/exit-N; TUGRA_LOOP_RELAUNCH=1 archives that launch and starts again", () => {
    const failing = "#!/bin/sh\necho '{\"tool\":\"tugra-migrate\",\"exit\":6,\"code\":\"precondition\",\"counts\":{},\"items\":[]}'\nexit 6\n";
    const { world: w, hosts } = world({ migratorSh: failing });
    const script = buildHostLoopScript(input(w));
    w.run(script);
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-a:finished:exit-6"]));
    // without relaunch the same dead launch is just re-reported
    w.run(script);
    expect((hosts.a.file("curl.log") ?? "").trim().split("\n")).toHaveLength(1);
    // the operator fixed the cause: the host now has a working migrator and asks for a relaunch
    writeFileSync(join(hosts.a.dir, "migrator.sh"), "#!/bin/sh\n{ echo \"ARGS: $*\"; } > \"$FAKE_HOST_DIR/migrator.invocation\"\necho '{\"tool\":\"tugra-migrate\",\"exit\":0,\"code\":\"ok\",\"counts\":{},\"items\":[]}'\nexit 0\n");
    const r = w.run(script, { TUGRA_LOOP_RELAUNCH: "1" });
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-a:launched:started"]));
    expect(hosts.a.file("migrator.invocation")).toContain("--only database:srv-a:db1");
    expect(r.stdout).toContain("[srv-a] finished ok");
  });

  it("TUGRA_LOOP_ONLY restricts a re-run to the named hosts; TUGRA_LOOP_NO_WAIT launches and returns", () => {
    const { world: w, hosts } = world();
    const script = buildHostLoopScript(input(w));
    w.run(script, { TUGRA_LOOP_ONLY: "srv-b", TUGRA_LOOP_NO_WAIT: "1" });
    expect(hosts.a.file("migrator.invocation")).toBeNull();
    const lines = loopLines(w.posted());
    expect(lines).toContain("srv-b:launched:started");
    expect(lines.some((l) => l.startsWith("srv-a:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("srv-b:finished"))).toBe(false); // no waiting
  });

  it("with the hub unreachable from the Coolify host the loop still runs everything (the post is best effort)", () => {
    const { world: w, hosts } = world({ postFails: true });
    const r = w.run(buildHostLoopScript(input(w)));
    expect(r.code).toBe(0);
    expect(hosts.a.file("migrator.invocation")).not.toBeNull();
    expect(r.stderr).toContain("could not post to the hub");
  });

  it("runs hosts in parallel up to the option and still reports every host once", () => {
    const { world: w } = world();
    const r = w.run(buildHostLoopScript(input(w, { parallel: 2 })));
    expect(r.code).toBe(0);
    expect(loopLines(w.posted()).filter((l) => l.endsWith(":finished:ok")).sort()).toEqual(["srv-a:finished:ok", "srv-b:finished:ok"]);
  });

  it("the pasted command (a quoted here-document through `sh -s`) runs the same script without writing the token to a file", () => {
    const { world: w } = world();
    const r = w.runCommand(wrapHostLoopCommand(buildHostLoopScript(input(w))));
    expect(r.code).toBe(0);
    expect(loopLines(w.posted())).toContain("srv-a:finished:ok");
    expect(spawnSync("grep", ["-rl", TOKEN, w.dir, "--exclude=curl-stdin.log", "--exclude=posted.txt", "--exclude=script.sh"], { encoding: "utf8" }).stdout).toBe("");
  });
});

describe("coolify-host-loop runner: FREEZE (identity-checked stop and unfreeze on each host)", () => {
  const A = ctrId("a");
  const B = ctrId("b");
  const C = ctrId("c");
  const UA = "uuaaaaaaaaaaaaaaaaaaaaaa";
  const UB = "uubbbbbbbbbbbbbbbbbbbbbb";
  const UC = "uucccccccccccccccccccccc";
  const freezeInput = (w: HostLoopWorld, over: Partial<HostLoopInput> = {}): HostLoopInput =>
    input(w, {
      step: "FREEZE",
      phase: undefined,
      hosts: [
        { ref: "srv-a", flags: [], freezeItems: [`app:srv-a:${UA}`, `database:srv-a:${UB}`] },
        { ref: "srv-b", flags: [], freezeItems: [`app:srv-b:${UC}`] },
      ],
      ...over,
    });
  const containers = {
    a: [
      { id: A, name: `${UA}-170000000000`, image: "ghcr.io/x/web:1", running: true },
      { id: B, name: UB, image: "postgres:16", running: false }, // already stopped by the owner: must never be started again
    ],
    b: [{ id: C, name: UC, image: "ghcr.io/x/worker:1", running: true }],
  };

  it("stops exactly the running containers of each host, records them, and reports the outcome per host", () => {
    const { world: w, hosts } = world({ containers });
    const r = w.run(buildHostLoopScript(freezeInput(w)));
    expect(r.code).toBe(0);
    expect(hosts.a.container(A).running).toBe(false);
    expect(hosts.b.container(C).running).toBe(false);
    const parsed = parseReportBody(w.posted());
    expect(parsed.freeze.get("srv-a")).toMatchObject({ outcome: "done", stopped: { [A]: "stopped" }, recorded: [expect.objectContaining({ id: A, name: `${UA}-170000000000` })] });
    expect(parsed.freeze.get("srv-b")!.stopped).toEqual({ [C]: "stopped" });
    expect(loopLines(w.posted())).toEqual(expect.arrayContaining(["srv-a:finished:frozen", "srv-b:finished:frozen"]));
    for (const h of [hosts.a, hosts.b]) expect(h.forbiddenCalls()).toEqual([]);
  });

  it("an item no container matches blocks the stop (nothing is stopped) until the operator's attestation mints the script with allowUnresolved", () => {
    const { world: w, hosts } = world({ containers });
    const items = [`app:srv-a:${UA}`, `database:srv-a:uuzzzzzzzzzzzzzzzzzzzzzz`];
    const blocked = freezeInput(w, { hosts: [{ ref: "srv-a", flags: [], freezeItems: items }] });
    const r1 = w.run(buildHostLoopScript(blocked));
    expect(r1.code).not.toBe(0);
    expect(hosts.a.container(A).running).toBe(true);
    expect(loopLines(w.posted())).toContain("srv-a:failed:unresolved-items");
    expect(parseReportBody(w.posted()).freeze.get("srv-a")!.unresolved).toEqual([items[1]]);
    w.run(buildHostLoopScript({ ...blocked, allowUnresolved: true }));
    expect(hosts.a.container(A).running).toBe(false);
  });

  it("TUGRA_LOOP_ACTION=unfreeze starts exactly the recorded containers (not the one the owner had stopped) and is safe to repeat", () => {
    const { world: w, hosts } = world({ containers });
    const script = buildHostLoopScript(freezeInput(w));
    w.run(script);
    const r = w.run(script, { TUGRA_LOOP_ACTION: "unfreeze" });
    expect(r.code).toBe(0);
    expect(hosts.a.container(A).running).toBe(true);
    expect(hosts.a.container(B).running).toBe(false);
    expect(hosts.b.container(C).running).toBe(true);
    expect(parseReportBody(w.posted()).freeze.get("srv-a")!.started).toEqual({ [A]: "started" });
    // a second unfreeze has no record left and reports that instead of starting anything
    const again = w.run(script, { TUGRA_LOOP_ACTION: "unfreeze" });
    expect(again.code).not.toBe(0);
    expect(loopLines(w.posted())).toContain("srv-a:failed:no-record");
  });

  it("a container recreated under the same name (new id) is a mismatch and is never touched", () => {
    const { world: w, hosts } = world({ containers });
    const script = buildHostLoopScript(freezeInput(w));
    w.run(script);
    hosts.a.recreate(A, ctrId("d"));
    w.run(script, { TUGRA_LOOP_ACTION: "unfreeze" });
    expect(parseReportBody(w.posted()).freeze.get("srv-a")!.started).toEqual({ [A]: "gone" });
    expect(hosts.a.container(ctrId("d")).running).toBe(false); // the new container was not started
  });

  it("re-running the freeze re-reports the record and stops again (idempotent)", () => {
    const { world: w, hosts } = world({ containers });
    const script = buildHostLoopScript(freezeInput(w));
    w.run(script);
    hosts.a.setRunning(A, true); // something started it again
    const r = w.run(script);
    expect(r.code).toBe(0);
    expect(hosts.a.container(A).running).toBe(false);
  });

  it("the Coolify host itself (host.docker.internal) is a source too: its freeze runs locally, without ssh", () => {
    const local = new SourceHostFake({ containers: [{ id: A, name: `${UA}-170000000000`, image: "ghcr.io/x/web:1", running: true }] });
    const rootDir = mkdtempSync(join(tmpdir(), "tugra-localroot-"));
    const servers: WorldServer[] = [{ uuid: "srv-l", ip: "host.docker.internal", keyUuid: "keylllll" }];
    const w = new HostLoopWorld({ servers, localHostDir: local.dir }, [ROOT]);
    cleanups.push(() => {
      w.dispose();
      local.dispose();
      rmSync(rootDir, { recursive: true, force: true });
    });
    const r = w.run(buildHostLoopScript({ ...freezeInput(w), root: rootDir, hosts: [{ ref: "srv-l", flags: [], freezeItems: [`app:srv-l:${UA}`] }] }));
    expect(r.code).toBe(0);
    expect(local.container(A).running).toBe(false);
    expect(w.sshCalls()).toEqual([]);
  });
});

describe("coolify-host-loop runner: INVENTORY (R2/R6/R8 through the loop)", () => {
  const TOK = TOKEN;
  function invWorld(opts: { unreachableHub?: boolean; pingCode?: number } = {}) {
    const script = renderMigratorInstallScript({ image: "ghcr.io/example/agent:1" });
    const inv = new InventoryHostFake({
      containers: [{ id: ctrId("a"), name: "db0aaaaaaaaaaaaaaaaaaaaaa", image: "postgres:16-alpine", mounts: [{ type: "volume", name: "pg-data", source: "/x", dest: "/var/lib/postgresql/data" }] }],
      volumes: [{ name: "pg-data" }],
      du: { "/var/lib/docker/volumes/pg-data/_data": 100 },
      migratorSh: script,
      hub: { unreachable: opts.unreachableHub, pingCode: opts.pingCode },
    });
    const w = new HostLoopWorld({ servers: [{ uuid: "srv-a", ip: "10.0.0.1", keyUuid: "keyaaaa", hostDir: inv.dir }] }, [ROOT]);
    cleanups.push(() => {
      w.dispose();
      inv.dispose();
    });
    return { w, inv };
  }
  const invInput = (w: HostLoopWorld): HostLoopInput => input(w, { step: "INVENTORY", phase: undefined, hosts: [{ ref: "srv-a", flags: [], freezeItems: [] }] });

  it("runs migrator.sh --inventory on the host with the token via stdin and forwards the labelled report to the hub", () => {
    const { w } = invWorld();
    const r = w.run(buildHostLoopScript(invInput(w)));
    expect(r.code).toBe(0);
    const parsed = parseReportBody(w.posted());
    expect(parsed.inventory.get("srv-a")).toMatchObject({ complete: true, containers: [expect.objectContaining({ name: "db0aaaaaaaaaaaaaaaaaaaaaa" })] });
    expect(parsed.reach[0]).toMatchObject({ ref: "srv-a", pingCode: 200, maxPassedMiB: 128 });
    expect(loopLines(w.posted())).toContain("srv-a:finished:ok");
    for (const c of w.sshCalls()) expect(c.join(" ")).not.toContain(TOK);
  });

  it("R8: a host that cannot even fetch migrator.sh from the hub is reported as hub-unreachable-from-host (and nothing is posted for it)", () => {
    const { w } = invWorld({ unreachableHub: true });
    const r = w.run(buildHostLoopScript(invInput(w)));
    expect(r.code).not.toBe(0);
    expect(loopLines(w.posted())).toContain("srv-a:failed:hub-unreachable-from-host");
    expect(parseReportBody(w.posted()).inventory.size).toBe(0);
  });

  it("R8: a hub that answers the fetch but refuses the probe (a proxy error) is carried back as the REACH report", () => {
    const { w } = invWorld({ pingCode: 502 });
    const r = w.run(buildHostLoopScript(invInput(w)));
    expect(r.code).toBe(0);
    expect(parseReportBody(w.posted()).reach[0]).toMatchObject({ ref: "srv-a", pingCode: 502, maxPassedMiB: null });
  });
});
