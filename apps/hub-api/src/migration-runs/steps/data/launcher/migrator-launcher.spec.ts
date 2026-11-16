import { join } from "node:path";
import { buildLaunchScript, buildLauncherStatusScript, buildLauncherStopScript, launcherDir, MIGRATE_RUN_ROOT, parseLaunchOutput, parseLauncherStatus, parseMigratorResult } from "./migrator-launcher";
import { SourceHostFake, ctrId } from "../testing/source-host-fake";

const TOKEN = `tugra_mig_${"A".repeat(43)}`;
const RUN = "cmabc123def456";

describe("launcher input validation", () => {
  const base = { runId: RUN, attempt: 1, hubBase: "https://hub.example.com", token: TOKEN, flags: ["--arms", "all", "--dry-run"] };
  it("builds under the production root by default", () => {
    expect(launcherDir(RUN, 2)).toBe(`${MIGRATE_RUN_ROOT}/${RUN}-2`);
    expect(buildLaunchScript(base)).toContain(`D='${MIGRATE_RUN_ROOT}/${RUN}-1'`);
  });
  it("refuses an unsafe hub base, token, flag, run id, attempt or root", () => {
    expect(() => buildLaunchScript({ ...base, hubBase: "https://x;rm -rf /" })).toThrow();
    expect(() => buildLaunchScript({ ...base, token: "tugra_mig_short" })).toThrow();
    expect(() => buildLaunchScript({ ...base, flags: ["--arms", "all; id"] })).toThrow();
    expect(() => buildLaunchScript({ ...base, flags: ["$(id)"] })).toThrow();
    expect(() => buildLaunchScript({ ...base, runId: "../../etc" })).toThrow();
    expect(() => buildLaunchScript({ ...base, attempt: -1 })).toThrow();
    expect(() => buildLaunchScript({ ...base, root: "/tmp/a b" })).toThrow();
    expect(() => buildLauncherStatusScript("x y", 1)).toThrow();
  });
  it("the token is written to a file exactly once and is on no command line of the script", () => {
    const s = buildLaunchScript(base);
    expect(s.split(TOKEN).length - 1).toBe(1);
    const line = s.split("\n").find((l) => l.includes(TOKEN))!;
    expect(line.startsWith("printf '%s' '")).toBe(true); // a builtin writing a 0600 file, not an exec
    expect(line).toContain('> "$D/tok"');
    expect(s).toContain("umask 077");
    expect(s).toContain("chmod 700");
    expect(s).not.toMatch(/(curl|docker|sh)\b[^\n]*tugra_mig_/);
    expect(s).not.toContain("--token");
  });
  it("never uses a destructive docker verb", () => {
    for (const s of [buildLaunchScript(base), buildLauncherStatusScript(RUN, 1), buildLauncherStopScript()]) {
      expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|volume|network)\b/);
    }
    expect(buildLauncherStopScript()).toContain("docker stop");
  });
});

describe("parsers", () => {
  it("parses launch outcomes and treats anything unreadable as unknown", () => {
    expect(parseLaunchOutput("TUGRA_LAUNCH\tstarted\n")).toBe("started");
    expect(parseLaunchOutput("noise\nTUGRA_LAUNCH\talready\n")).toBe("already");
    expect(parseLaunchOutput("TUGRA_LAUNCH\tfetch-failed")).toBe("fetch-failed");
    expect(parseLaunchOutput("")).toBe("unknown");
    expect(parseLaunchOutput("TUGRA_LAUNCH\twhatever")).toBe("unknown");
  });
  it("parses the migrator result line down to safe fields", () => {
    const r = parseMigratorResult(
      JSON.stringify({
        tool: "tugra-migrate",
        exit: 1,
        code: "partial",
        counts: { restored: 2, failed: 1, "bad key!": 3, nan: "x" },
        items: [{ itemRef: "database:_:a", state: "failed", reason: "dest-dirty" }, { itemRef: "x", state: "<script>" }, { state: "ok" }],
        secret: "nope",
      }),
    );
    expect(r).toEqual({ exit: 1, code: "partial", counts: { restored: 2, failed: 1 }, items: [{ itemRef: "database:_:a", state: "failed", reason: "dest-dirty" }] });
    expect(parseMigratorResult("not json")).toBeNull();
    expect(parseMigratorResult(JSON.stringify({ tool: "other", exit: 0 }))).toBeNull();
    expect(parseMigratorResult(JSON.stringify({ tool: "tugra-migrate", exit: "0" }))).toBeNull();
  });
  it("status parsing never reports an unreadable answer as running", () => {
    expect(parseLauncherStatus("TUGRA_MIG\tnone\n")).toEqual({ state: "none" });
    expect(parseLauncherStatus("TUGRA_MIG\trunning\n")).toEqual({ state: "running" });
    expect(parseLauncherStatus("TUGRA_MIG\tdied\n")).toEqual({ state: "died" });
    expect(parseLauncherStatus("")).toEqual({ state: "died" });
    expect(parseLauncherStatus("garbage")).toEqual({ state: "died" });
    expect(parseLauncherStatus("TUGRA_MIG\tfinished\t0\nTUGRA_MIG_OUT\t{\"tool\":\"tugra-migrate\",\"exit\":0,\"code\":\"ok\"}\n")).toEqual({
      state: "finished",
      rc: 0,
      result: { exit: 0, code: "ok", counts: {}, items: [] },
    });
    expect(parseLauncherStatus("TUGRA_MIG\tfinished\t7\n")).toEqual({ state: "finished", rc: 7, result: null });
  });
});

describe("the launcher scripts executed against a fake source host", () => {
  let host: SourceHostFake;
  afterEach(() => host?.dispose());

  const waitFinished = async (root: string, attempt = 1) => {
    for (let i = 0; i < 100; i++) {
      const st = parseLauncherStatus((await host.run("srv", buildLauncherStatusScript(RUN, attempt, root), "migrate", 15_000)).output);
      if (st.state === "finished") return st;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the fake migrator never finished");
  };

  it("launches detached, hands the token over by environment only, deletes the token file and records the result", async () => {
    host = new SourceHostFake({ containers: [] });
    const root = join(host.dir, "runs");
    const script = buildLaunchScript({ runId: RUN, attempt: 1, hubBase: "https://hub.example.com", token: TOKEN, flags: ["--arms", "all", "--resync", "--verify", "--verify-mode", "estimate"], root });
    const launched = await host.run("srv", script, "migrate", 15_000);
    expect(parseLaunchOutput(launched.output)).toBe("started");
    const fin = await waitFinished(root);
    expect(fin).toMatchObject({ state: "finished", rc: 0 });
    if (fin.state !== "finished") throw new Error("unreachable");
    expect(fin.result?.counts).toEqual({ restored: 2, failed: 0 });

    // what the (fake) migrator.sh saw: the flags as ARGS, the token ONLY in its environment
    const inv = host.file("migrator.invocation")!;
    expect(inv).toContain("ARGS: --hub https://hub.example.com --arms all --resync --verify --verify-mode estimate");
    expect(inv).toContain("TOKEN_IN_ENV: yes");
    expect(inv).not.toContain(TOKEN);
    // the token file is gone and nothing written to the run dir contains the token
    expect(host.file(`runs/${RUN}-1/tok`)).toBeNull();
    for (const f of ["flags", "hub", "run.sh", "out", "err", "rc", "started"]) expect(host.file(`runs/${RUN}-1/${f}`) ?? "").not.toContain(TOKEN);
    // it fetched the migrator from the hub that minted the token, and used no destructive docker verb
    expect(host.file("curl.log")).toContain("https://hub.example.com/install/migrator.sh");
    expect(host.forbiddenCalls()).toEqual([]);
  });

  it("is idempotent: a second launch for the same (run, attempt) starts nothing", async () => {
    host = new SourceHostFake({ containers: [] });
    const root = join(host.dir, "runs");
    const script = buildLaunchScript({ runId: RUN, attempt: 1, hubBase: "https://hub.example.com", token: TOKEN, flags: ["--arms", "all"], root });
    expect(parseLaunchOutput((await host.run("srv", script, "migrate", 15_000)).output)).toBe("started");
    expect(parseLaunchOutput((await host.run("srv", script, "migrate", 15_000)).output)).toBe("already");
    await waitFinished(root);
    expect(host.file("curl.log")!.trim().split("\n")).toHaveLength(1);
  });

  it("a hub that cannot be reached from the source host leaves no token behind", async () => {
    host = new SourceHostFake({ containers: [], curlFails: true });
    const root = join(host.dir, "runs");
    const script = buildLaunchScript({ runId: RUN, attempt: 1, hubBase: "https://hub.example.com", token: TOKEN, flags: ["--dry-run"], root });
    expect(parseLaunchOutput((await host.run("srv", script, "migrate", 15_000)).output)).toBe("fetch-failed");
    expect(host.file(`runs/${RUN}-1/tok`)).toBeNull();
    expect(parseLauncherStatus((await host.run("srv", buildLauncherStatusScript(RUN, 1, root), "migrate", 15_000)).output)).toEqual({ state: "none" });
  });

  it("reports a non-zero migrator exit with its result line", async () => {
    host = new SourceHostFake({
      containers: [],
      migratorSh: `#!/bin/sh\necho '{"tool":"tugra-migrate","exit":1,"code":"partial","counts":{"failed":1},"items":[{"itemRef":"database:_:db1","state":"failed","reason":"dest-dirty"}]}'\nexit 1\n`,
    });
    const root = join(host.dir, "runs");
    await host.run("srv", buildLaunchScript({ runId: RUN, attempt: 1, hubBase: "https://hub.example.com", token: TOKEN, flags: ["--arms", "all"], root }), "migrate", 15_000);
    const fin = await waitFinished(root);
    expect(fin).toMatchObject({ state: "finished", rc: 1 });
    if (fin.state === "finished") expect(fin.result?.items[0]).toEqual({ itemRef: "database:_:db1", state: "failed", reason: "dest-dirty" });
  });

  it("the stop script stops only the migrator's own containers", async () => {
    host = new SourceHostFake({
      containers: [
        { id: ctrId("a"), name: "tugra-migrator-123", image: "agent", running: true },
        { id: ctrId("b"), name: "app-1", image: "web", running: true },
      ],
    });
    const res = await host.run("srv", buildLauncherStopScript(), "migrate", 15_000);
    expect(res.output).toContain("TUGRA_MIG\tstopped");
    expect(host.container(ctrId("a")).running).toBe(false);
    expect(host.container(ctrId("b")).running).toBe(true);
  });

  it("status: a live migrator container counts as running even when the runner process is gone", async () => {
    host = new SourceHostFake({ containers: [{ id: ctrId("a"), name: "tugra-migrator-9", image: "agent", running: true }] });
    const root = join(host.dir, "runs");
    await host.run("srv", `mkdir -p '${root}/${RUN}-1' && : > '${root}/${RUN}-1/started'`, "migrate", 15_000);
    expect(parseLauncherStatus((await host.run("srv", buildLauncherStatusScript(RUN, 1, root), "migrate", 15_000)).output)).toEqual({ state: "running" });
  });
});
