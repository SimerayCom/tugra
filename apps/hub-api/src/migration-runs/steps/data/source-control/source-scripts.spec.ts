import {
  buildSourceInspectScript,
  buildSourceStartScript,
  buildSourceStateScript,
  buildSourceStopScript,
  containerNameMatches,
  parseSourceInspect,
  parseStartOutput,
  parseStateOutput,
  parseStopOutput,
  shq,
} from "./source-scripts";
import { SourceHostFake, ctrId } from "../testing/source-host-fake";

const A = ctrId("a");
const B = ctrId("b");
const C = ctrId("c");
const D = ctrId("d");

describe("containerNameMatches", () => {
  it("accepts the exact uuid and the <uuid>-<deploy digits> application naming", () => {
    expect(containerNameMatches("abc", "abc", "application")).toBe(true);
    expect(containerNameMatches("abc-170000000000", "abc", "application")).toBe(true);
  });
  it("accepts the Coolify 4.7 ISO deploy suffix too (<uuid>-YYYYMMDDTHHMMSS)", () => {
    expect(containerNameMatches("abc-20261110T153012", "abc", "application")).toBe(true);
    expect(containerNameMatches("abc-20261110T153012", "abc", "service")).toBe(true);
  });
  it("refuses ISO near misses and previews", () => {
    for (const n of ["abc-pr-12", "abc-20261110t153012", "abc-20261110T1530", "abc-20261110T153012x", "abc-20261110T153012-1", "abc-2026111T1530123", "abc-T153012", "abcd-20261110T153012"]) {
      expect([n, containerNameMatches(n, "abc", "application")]).toEqual([n, false]);
    }
  });
  it("a known custom container-name prefix matches `<prefix>-<suffix>` in both generations, and only that", () => {
    expect(containerNameMatches("shop-20261110T153012", "abc", "application", ["shop"])).toBe(true);
    expect(containerNameMatches("shop-170000000000", "abc", "application", ["shop"])).toBe(true);
    expect(containerNameMatches("shop-20261110T153012", "abc", "application")).toBe(false); // prefix unknown to the caller
    expect(containerNameMatches("shop-pr-3", "abc", "application", ["shop"])).toBe(false);
    expect(containerNameMatches("shopx-20261110T153012", "abc", "application", ["shop"])).toBe(false);
    expect(containerNameMatches("-20261110T153012", "abc", "application", [""])).toBe(false);
  });
  it("refuses look-alikes", () => {
    expect(containerNameMatches("abc-1", "abc", "application")).toBe(false); // not a deploy timestamp
    expect(containerNameMatches("abcd", "abc", "application")).toBe(false);
    expect(containerNameMatches("xabc", "abc", "application")).toBe(false);
    expect(containerNameMatches("web-abc", "abc", "application")).toBe(false); // only a SERVICE component may carry a prefix
  });
  it("a service component container ends with -<uuid>", () => {
    expect(containerNameMatches("web-svc1", "svc1", "service")).toBe(true);
    expect(containerNameMatches("-svc1", "svc1", "service")).toBe(false);
  });
});

describe("source scripts: shell safety", () => {
  const recorded = [{ id: A, name: "abc-170000000000", image: "ghcr.io/x/web:1", ports: "", itemRef: "app:s:abc" }];

  it("never contains a destructive docker verb", () => {
    const scripts = [buildSourceInspectScript([{ itemRef: "app:s:abc" }]), buildSourceStopScript(recorded), buildSourceStartScript(recorded), buildSourceStateScript(recorded)];
    for (const s of scripts) {
      expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|volume|network|container)\b/);
      expect(s).not.toMatch(/\brm\s+-/);
    }
    expect(buildSourceStopScript(recorded)).toContain("docker stop -t 120");
  });

  it("refuses a malformed recorded container instead of building a script", () => {
    for (const bad of [
      { ...recorded[0], id: "abc" },
      { ...recorded[0], id: A.toUpperCase() },
      { ...recorded[0], name: "x; reboot" },
      { ...recorded[0], image: "img && id" },
    ]) {
      expect(() => buildSourceStopScript([bad])).toThrow();
      expect(() => buildSourceStartScript([bad])).toThrow();
      expect(() => buildSourceStateScript([bad])).toThrow();
    }
    expect(() => buildSourceStopScript(recorded, 0)).toThrow();
    expect(() => buildSourceInspectScript([{ itemRef: "app:s:a b" }])).toThrow();
    expect(() => buildSourceInspectScript([{ itemRef: "volume:s:abc:data" }])).toThrow();
  });

  it("quotes every value (a quote in a name cannot break out)", () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("parseSourceInspect", () => {
  const items = [{ itemRef: "app:s:abc" }, { itemRef: "service:s:svc1" }];
  const line = (...f: string[]) => ["TUGRA_CTR", ...f].join("\t");

  it("keeps only well-formed lines whose name really belongs to the item", () => {
    const out = [
      line("app:s:abc", A, "abc-170000000000", "ghcr.io/x/web:1", "80/tcp", "running"),
      line("app:s:abc", B, "abc-1", "img", "", "running"), // not a deploy suffix
      line("app:s:abc", "nothex", "abc", "img", "", "running"),
      line("app:s:abc", C, "abc", "img; rm -rf /", "", "running"),
      line("app:s:unknown", D, "abc", "img", "", "running"), // an item the run did not ask about
      line("service:s:svc1", D, "web-svc1", "img:2", "", "exited"),
      "garbage",
      "TUGRA_CTR\ttoo\tfew",
    ].join("\n");
    const got = parseSourceInspect(out, items);
    expect(got.map((c) => c.id)).toEqual([A, D]);
    expect(got[1].state).toBe("exited");
  });

  it("de-duplicates by id", () => {
    const l = line("app:s:abc", A, "abc", "img", "", "running");
    expect(parseSourceInspect(`${l}\n${l}`, items)).toHaveLength(1);
  });
});

describe("parsers of stop / start / state output", () => {
  it("only accept known outcomes for ids the run asked about", () => {
    expect(parseStopOutput(`TUGRA_STOP\t${A}\tstopped\nTUGRA_STOP\t${B}\tweird\nTUGRA_STOP\t${C}\tstopped\n`, [A, B])).toEqual(new Map([[A, "stopped"]]));
    expect(parseStartOutput(`TUGRA_START\t${A}\tstarted\n`, [A]).get(A)).toBe("started");
    expect(parseStateOutput(`TUGRA_STATE\t${A}\ttrue\nTUGRA_STATE\t${B}\tgone\n`, [A, B])).toEqual(new Map([[A, "true"], [B, "gone"]]));
  });
});

describe("source scripts executed against a fake source host", () => {
  let host: SourceHostFake;
  afterEach(() => host?.dispose());

  const fleet = () => [
    { id: A, name: "abc-170000000000", image: "ghcr.io/x/web:1", ports: "0.0.0.0:80->80/tcp", running: true },
    { id: B, name: "svc1", image: "redis:7", ports: "", running: true },
    { id: C, name: "web-svc1", image: "nginx:1", ports: "", running: true },
    { id: D, name: "unrelated", image: "postgres:16", ports: "", running: true },
  ];
  const items = [{ itemRef: "app:s:abc" }, { itemRef: "service:s:svc1" }];

  it("discovers only the containers that belong to the items, then stops and restarts exactly those", async () => {
    host = new SourceHostFake({ containers: fleet() });
    const insp = await host.run("srv", buildSourceInspectScript(items), "migrate", 20_000);
    const found = parseSourceInspect(insp.output, items);
    expect(found.map((c) => c.name).sort()).toEqual(["abc-170000000000", "svc1", "web-svc1"]);

    const stop = await host.run("srv", buildSourceStopScript(found), "migrate", 20_000);
    const res = parseStopOutput(stop.output, found.map((c) => c.id));
    expect([...res.values()]).toEqual(["stopped", "stopped", "stopped"]);
    expect(host.container(A).running).toBe(false);
    expect(host.container(D).running).toBe(true); // the unrelated container is untouched
    expect(host.forbiddenCalls()).toEqual([]);

    const state = parseStateOutput((await host.run("srv", buildSourceStateScript(found), "migrate", 20_000)).output, found.map((c) => c.id));
    expect([...state.values()]).toEqual(["false", "false", "false"]);

    const start = await host.run("srv", buildSourceStartScript(found), "migrate", 20_000);
    expect([...parseStartOutput(start.output, found.map((c) => c.id)).values()]).toEqual(["started", "started", "started"]);
    expect(host.container(A).running).toBe(true);
    expect(host.forbiddenCalls()).toEqual([]);
  });

  it("discovers, stops and restarts a Coolify 4.7 app container (<uuid>-YYYYMMDDTHHMMSS) and ignores its preview", async () => {
    host = new SourceHostFake({
      containers: [
        { id: A, name: "abc-20261110T153012", image: "ghcr.io/x/web:1", ports: "", running: true },
        { id: B, name: "abc-pr-7", image: "ghcr.io/x/web:pr", ports: "", running: true },
        { id: D, name: "unrelated", image: "postgres:16", ports: "", running: true },
      ],
    });
    const one = [{ itemRef: "app:s:abc" }];
    const found = parseSourceInspect((await host.run("srv", buildSourceInspectScript(one), "migrate", 20_000)).output, one);
    expect(found.map((c) => c.name)).toEqual(["abc-20261110T153012"]);
    const stop = parseStopOutput((await host.run("srv", buildSourceStopScript(found), "migrate", 20_000)).output, [A]);
    expect(stop.get(A)).toBe("stopped");
    expect(host.container(B).running).toBe(true);
  });

  it("a recreated container (same name, new id) is `gone`: the NEW container with the old name is not stopped", async () => {
    host = new SourceHostFake({ containers: fleet() });
    const found = parseSourceInspect((await host.run("srv", buildSourceInspectScript(items), "migrate", 20_000)).output, items);
    host.recreate(A, ctrId("e"));
    const stop = parseStopOutput((await host.run("srv", buildSourceStopScript(found), "migrate", 20_000)).output, found.map((c) => c.id));
    expect(stop.get(A)).toBe("gone");
    expect(host.container(ctrId("e")).running).toBe(true);
  });

  it("a container whose image no longer matches the record is a `mismatch` and is not touched", async () => {
    host = new SourceHostFake({ containers: fleet() });
    const found = parseSourceInspect((await host.run("srv", buildSourceInspectScript(items), "migrate", 20_000)).output, items);
    const tampered = found.map((c) => (c.id === B ? { ...c, image: "evil:latest" } : c));
    const stop2 = parseStopOutput((await host.run("srv", buildSourceStopScript(tampered), "migrate", 20_000)).output, tampered.map((c) => c.id));
    expect(stop2.get(B)).toBe("mismatch");
    expect(host.container(B).running).toBe(true);
  });

  it("reports a failed stop honestly and keeps going with the rest", async () => {
    host = new SourceHostFake({ containers: fleet(), failStop: [B] });
    const found = parseSourceInspect((await host.run("srv", buildSourceInspectScript(items), "migrate", 20_000)).output, items);
    const res = parseStopOutput((await host.run("srv", buildSourceStopScript(found), "migrate", 20_000)).output, found.map((c) => c.id));
    expect(res.get(B)).toBe("failed");
    expect(res.get(A)).toBe("stopped");
    expect(host.container(B).running).toBe(true);
  });

  it("start refuses to start a recreated impostor", async () => {
    host = new SourceHostFake({ containers: fleet() });
    const found = parseSourceInspect((await host.run("srv", buildSourceInspectScript(items), "migrate", 20_000)).output, items);
    await host.run("srv", buildSourceStopScript(found), "migrate", 20_000);
    host.recreate(A, ctrId("e")); // someone recreated it while it was stopped
    const start = parseStartOutput((await host.run("srv", buildSourceStartScript(found), "migrate", 20_000)).output, found.map((c) => c.id));
    expect(start.get(A)).toBe("gone");
  });
});
