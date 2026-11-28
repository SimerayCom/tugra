import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImageIdsScript, buildServiceDetailScript, buildServiceReadyScript, buildServiceVolumeScript, parseImageIds, parseServiceDetail, parseServiceReady } from "./inplace-service-scripts";
import { parseAlias } from "./inplace-scripts";

const ID = "a".repeat(64);
const ID2 = "b".repeat(64);
const ctr = { id: ID, name: "ghost-abc", image: "ghost:5" };

describe("source safety", () => {
  it("never removes, kills, prunes or deletes, never reads an environment, never execs into a container", () => {
    const all = [
      buildServiceDetailScript([ctr]),
      buildImageIdsScript(["ghost:5"]),
      buildServiceVolumeScript([{ kind: "volume", from: "u_data", to: "tugra_a_data", project: "tugra_a", key: "data" }, { kind: "bind", from: "/srv/up", to: "tugra_a_up", project: "tugra_a", key: "up" }]),
      buildServiceReadyScript("tugra_a"),
    ];
    for (const s of all) {
      // the one `docker run` is the read-only existence test of a host folder (tugra_host_test): no network, no capabilities, read-only bind, `test` as the entrypoint
      const runs = s.split("\n").filter((l) => /docker\s+run\b/.test(l));
      for (const l of runs) expect(l).toMatch(/--network none .*--cap-drop ALL .*,readonly".*--entrypoint test /);
      expect(s.replace(/^.*docker\s+run\b.*$/gm, "")).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|stop|start|update|run|exec|container\s+rm)\b/);
      expect(s).not.toMatch(/docker\s+volume\s+(rm|prune)/);
      expect(s).not.toMatch(/\.Config\.Env|\.Env\b|--env|printenv/);
      expect(s).not.toMatch(/rm\s+-[a-z]*r/);
    }
  });
  it("the detail script reads two labels only: the compose service name and the image's own version", () => {
    const s = buildServiceDetailScript([ctr]);
    expect(s).toContain("com.docker.compose.service");
    expect(s).toContain("org.opencontainers.image.version");
    expect(s.match(/\.Config\.Labels/g)).toHaveLength(2);
    expect(s).not.toMatch(/\.Config\.Cmd|\.Config\.Entrypoint/);
  });
});

describe("validation: nothing hostile reaches a shell", () => {
  it("refuses a bad container, image, volume, path, project and key", () => {
    expect(() => buildServiceDetailScript([{ ...ctr, id: "short" }])).toThrow();
    expect(() => buildServiceDetailScript([{ ...ctr, name: "x; id" }])).toThrow();
    expect(() => buildImageIdsScript([])).toThrow();
    expect(() => buildImageIdsScript(["a b"])).toThrow();
    expect(() => buildImageIdsScript(["ghost:${TAG}"])).toThrow();
    expect(() => buildImageIdsScript(Array.from({ length: 65 }, (_, i) => `i${i}:1`))).toThrow();
    const ok = { kind: "volume" as const, from: "u_data", to: "tugra_a_data", project: "tugra_a", key: "data" };
    expect(() => buildServiceVolumeScript([{ ...ok, from: "a;b" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, to: "$(id)" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, project: "Bad Project" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, key: "k;x" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, kind: "bind", from: "relative/path" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, kind: "bind", from: "/srv/../etc" }])).toThrow();
    expect(() => buildServiceVolumeScript([{ ...ok, kind: "bind", from: "/srv/a b" }])).toThrow();
    expect(() => buildServiceReadyScript("Bad Project")).toThrow();
    expect(() => buildServiceReadyScript("a;b")).toThrow();
  });
});

describe("parsers fail closed", () => {
  const base = (id: string) => [`TUGRA_IP_RESTART|${id}|always`, `TUGRA_IP_IMAGE|${id}|sha256:${"c".repeat(64)}`, `TUGRA_IP_MOUNT|${id}|volume|u_data|/var/lib/docker/volumes/u_data/_data|/data|true`];
  it("the detail parser reads the service label, the networks with their aliases and the published port count", () => {
    const out = [...base(ID), `TUGRA_IP_SVCCTR|${ID}|ghost|2`, `TUGRA_IP_NET|${ID}|abc|ghost,0123456789ab,`, `TUGRA_IP_NET|${ID}|coolify|`, "TUGRA_IP_DETAIL_END"].join("\n");
    const m = parseServiceDetail(out, [ctr])!;
    expect(m.get(ID)).toEqual({
      id: ID,
      name: "ghost-abc",
      image: "ghost:5",
      imageId: `sha256:${"c".repeat(64)}`,
      restart: "always",
      service: "ghost",
      mounts: [{ type: "volume", source: "u_data", destination: "/data", rw: true }],
      networks: [{ name: "abc", aliases: ["ghost", "0123456789ab"] }, { name: "coolify", aliases: [] }],
      published: 2,
    });
  });
  it("an empty label is a container with no compose service; a missing service line makes the container unreadable (absent), never 'no service'", () => {
    const out = [...base(ID), `TUGRA_IP_SVCCTR|${ID}||0`, ...base(ID2), "TUGRA_IP_DETAIL_END"].join("\n");
    const m = parseServiceDetail(out, [ctr, { ...ctr, id: ID2, name: "other" }])!;
    expect(m.get(ID)!.service).toBeNull();
    expect(m.has(ID2)).toBe(false);
  });
  it("hostile label, network and alias values are dropped", () => {
    const out = [...base(ID), `TUGRA_IP_SVCCTR|${ID}|bad name;id|0`, `TUGRA_IP_NET|${ID}|ok|fine,bad alias,`, `TUGRA_IP_NET|${ID}|bad net!|x,`, "TUGRA_IP_DETAIL_END"].join("\n");
    const m = parseServiceDetail(out, [ctr])!.get(ID)!;
    expect(m.service).toBeNull();
    expect(m.networks).toEqual([{ name: "ok", aliases: ["fine"] }]);
  });
  it("a cut or END-less output is null", () => {
    expect(parseServiceDetail(`${base(ID).join("\n")}\nTUGRA_IP_SVCCTR|${ID}|ghost|0`, [ctr])).toBeNull();
    expect(parseServiceDetail("TUGRA_IP_DETAIL_END…(truncated)", [ctr])).toBeNull();
  });
  it("image ids: every reference must be answered", () => {
    const id = `sha256:${"d".repeat(64)}`;
    expect(parseImageIds(`TUGRA_IP_IMGID|a:1|${id}\nTUGRA_IP_IMGID|b:1|missing\nTUGRA_IP_IMGID_END`, ["a:1", "b:1"])).toEqual(new Map([["a:1", id], ["b:1", "missing"]]));
    expect(parseImageIds(`TUGRA_IP_IMGID|a:1|${id}\nTUGRA_IP_IMGID_END`, ["a:1", "b:1"])).toBeNull();
    expect(parseImageIds(`TUGRA_IP_IMGID|a:1|${id}`, ["a:1"])).toBeNull();
    expect(parseImageIds(`TUGRA_IP_IMGID|a:1|notanid\nTUGRA_IP_IMGID_END`, ["a:1"])).toBeNull();
    expect(parseImageIds(`TUGRA_IP_IMGID|zzz:1|${id}\nTUGRA_IP_IMGID_END…(truncated)`, ["a:1"])).toBeNull();
  });
  it("members: state, health and restart count; a bad line is dropped and the END marker is required", () => {
    const out = ["noise", "TUGRA_IP_SVC|web|/p-web-1|running|healthy|0", "TUGRA_IP_SVC|db|/p-db-1|restarting|none|3", "TUGRA_IP_SVC|bad name|/x|running|none|0", "TUGRA_IP_SVC|web|/p-web-2|running|weird|0", "TUGRA_IP_SVC|web|/p-web-3|RUNNING|none|0", "TUGRA_IP_SVC_END"].join("\n");
    expect(parseServiceReady(out)).toEqual([
      { service: "web", name: "p-web-1", state: "running", health: "healthy", restarts: 0 },
      { service: "db", name: "p-db-1", state: "restarting", health: "none", restarts: 3 },
    ]);
    expect(parseServiceReady("TUGRA_IP_SVC|web|/p|running|none|0")).toBeNull();
    expect(parseServiceReady("TUGRA_IP_SVC_END…(truncated)")).toBeNull();
    expect(parseServiceReady("TUGRA_IP_SVC_END")).toEqual([]);
  });
});

// ───────────────────────────── real execution on fixtures ─────────────────────────────

let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplace-svc-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeBin = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const run = (script: string, env: Record<string, string> = {}) => spawnSync("/bin/sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_DIR: dir, TUGRA_AGENT_IMAGE: "tugra-agent:test", ...env }, encoding: "utf8" });

/** A docker that knows volumes (name -> mountpoint, device option) and logs every create. */
const fakeDocker = `
case "$1" in
  run)
    # the host-folder existence test: the daemon of the HOST binds <src> (a missing source is refused) and runs \`test <flag> /x/<base>\`
    src=$(printf '%s' "$*" | sed -n 's/.*src=\\([^,]*\\),dst=.*/\\1/p')
    # /host-only/svc exists on the HOST (the daemon sees it) and nowhere in this shell
    [ -d "$src" ] || [ "$src" = /host-only ] || { echo "docker: Error response from daemon: invalid mount config for type \\"bind\\": bind source path does not exist: $src" >&2; exit 125; }
    while [ "$1" != "test" ]; do shift; done; shift 2; base="\${2#/x/}"
    [ "$src/$base" = /host-only/svc ] && exit 0
    case "$1" in -d) [ -d "$src/$base" ];; *) [ -e "$src/$base" ];; esac
    exit $?;;
esac
case "$1 $2" in
  "volume inspect")
    shift 2; fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
    name="$1"
    [ -f "$FAKE_DIR/vol-$name" ] || exit 1
    case "$fmt" in
      *Mountpoint*) echo "$FAKE_DIR/mount-$name";;
      *device*) cat "$FAKE_DIR/vol-$name";;
    esac
    exit 0;;
  "volume create")
    shift 2; dev=""; name=""; labels=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --opt) case "$2" in device=*) dev="\${2#device=}";; esac; shift 2;;
        --label) labels="$labels $2"; shift 2;;
        --driver) shift 2;;
        *) name="$1"; shift;;
      esac
    done
    printf '%s' "$dev" > "$FAKE_DIR/vol-$name"
    echo "$name$labels" >> "$FAKE_DIR/creates"
    exit 0;;
esac
exit 1
`;

describe("volume alias, executed against a fake docker", () => {
  it("creates a bind volume on another volume's data directory, stamped for compose, and answers created; again it answers present", () => {
    writeBin("docker", fakeDocker);
    writeFileSync(join(dir, "vol-u_data"), "");
    const s = buildServiceVolumeScript([{ kind: "volume", from: "u_data", to: "tugra_a_data", project: "tugra_a", key: "data" }]);
    const r1 = run(s);
    expect(parseAlias(r1.stdout, ["tugra_a_data"])!.get("tugra_a_data")).toBe("created");
    expect(readFileSync(join(dir, "creates"), "utf8")).toBe("tugra_a_data com.docker.compose.project=tugra_a com.docker.compose.volume=data\n");
    expect(readFileSync(join(dir, "vol-tugra_a_data"), "utf8")).toBe(`${dir}/mount-u_data`);
    expect(parseAlias(run(s).stdout, ["tugra_a_data"])!.get("tugra_a_data")).toBe("present");
  });
  it("a host folder is the device; a missing folder is nosource and nothing is created", () => {
    writeBin("docker", fakeDocker);
    mkdirSync(join(dir, "up"));
    const ok = run(buildServiceVolumeScript([{ kind: "bind", from: join(dir, "up"), to: "tugra_a_up", project: "tugra_a", key: "up" }]));
    expect(parseAlias(ok.stdout, ["tugra_a_up"])!.get("tugra_a_up")).toBe("created");
    expect(readFileSync(join(dir, "vol-tugra_a_up"), "utf8")).toBe(join(dir, "up"));
    const gone = run(buildServiceVolumeScript([{ kind: "bind", from: join(dir, "nope"), to: "tugra_a_x", project: "tugra_a", key: "x" }]));
    expect(parseAlias(gone.stdout, ["tugra_a_x"])!.get("tugra_a_x")).toBe("nosource");
  });
  it("a host folder the agent's own filesystem cannot see is found through the daemon (the bug: /data/coolify/services/... was always nosource)", () => {
    writeBin("docker", fakeDocker);
    // /host-only/svc exists for the daemon only: this shell's own [ -d ] would say no
    expect(existsSync("/host-only/svc")).toBe(false);
    const r = run(buildServiceVolumeScript([{ kind: "bind", from: "/host-only/svc", to: "tugra_a_svc", project: "tugra_a", key: "svc" }]), {});
    expect(parseAlias(r.stdout, ["tugra_a_svc"])!.get("tugra_a_svc")).toBe("created");
    expect(readFileSync(join(dir, "vol-tugra_a_svc"), "utf8")).toBe("/host-only/svc");
  });
  it("no agent image to ask with: the answer is failed (could not tell), never nosource (missing)", () => {
    writeBin("docker", fakeDocker);
    mkdirSync(join(dir, "up2"));
    const r = spawnSync("/bin/sh", ["-c", buildServiceVolumeScript([{ kind: "bind", from: join(dir, "up2"), to: "tugra_a_up2", project: "tugra_a", key: "up2" }])], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_DIR: dir }, encoding: "utf8" });
    expect(parseAlias(r.stdout, ["tugra_a_up2"])!.get("tugra_a_up2")).toBe("failed");
  });
  it("a Tugra volume that exists and points elsewhere is foreign and is left alone; a Coolify volume that is gone is nosource", () => {
    writeBin("docker", fakeDocker);
    writeFileSync(join(dir, "vol-u_data"), "");
    writeFileSync(join(dir, "vol-tugra_a_data"), "/somewhere/else");
    const r = run(buildServiceVolumeScript([{ kind: "volume", from: "u_data", to: "tugra_a_data", project: "tugra_a", key: "data" }, { kind: "volume", from: "ghost_vol", to: "tugra_a_other", project: "tugra_a", key: "other" }]));
    const m = parseAlias(r.stdout, ["tugra_a_data", "tugra_a_other"])!;
    expect(m.get("tugra_a_data")).toBe("foreign");
    expect(m.get("tugra_a_other")).toBe("nosource");
    expect(readFileSync(join(dir, "vol-tugra_a_data"), "utf8")).toBe("/somewhere/else");
    expect(() => readFileSync(join(dir, "creates"), "utf8")).toThrow();
  });
});

describe("readiness and image ids, executed against a fake docker", () => {
  it("lists every container of the project with its service, state, health and restart count", () => {
    writeBin(
      "docker",
      `
case "$1" in
  ps) echo c1; echo c2;;
  inspect)
    shift; [ "$1" = "-f" ] && shift
    case "$2" in
      c1) echo "TUGRA_IP_SVC|web|/p-web-1|running|healthy|0";;
      c2) echo "TUGRA_IP_SVC|db|/p-db-1|running|none|2";;
    esac;;
esac`,
    );
    const r = run(buildServiceReadyScript("tugra_p"));
    expect(parseServiceReady(r.stdout)).toEqual([
      { service: "web", name: "p-web-1", state: "running", health: "healthy", restarts: 0 },
      { service: "db", name: "p-db-1", state: "running", health: "none", restarts: 2 },
    ]);
  });
  it("answers the id of the image a name stands for, and missing for a name the host does not have", () => {
    const id = `sha256:${"e".repeat(64)}`;
    writeBin("docker", `[ "$1 $2" = "image inspect" ] || exit 1; case "$5" in ghost:5) echo ${id};; *) exit 1;; esac`);
    const r = run(buildImageIdsScript(["ghost:5", "nope:1"]));
    expect(parseImageIds(r.stdout, ["ghost:5", "nope:1"])).toEqual(new Map([["ghost:5", id], ["nope:1", "missing"]]));
  });
});
