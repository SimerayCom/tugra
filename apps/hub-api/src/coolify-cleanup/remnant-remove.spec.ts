import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupRemnant } from "@tugra/shared";
import { assertRemovable, buildRemoveScript, parseRemoveOutput, UnsafeRemnantError } from "./remnant-remove";

const rem = (kind: CleanupRemnant["kind"], name: string): CleanupRemnant => ({ kind, name, sizeBytes: null });
const UUID = "abcd1234efgh5678ijkl9012";

describe("assertRemovable: the allow-list a hub bug cannot widen", () => {
  it("accepts exactly what the cleanup may remove", () => {
    for (const r of [rem("container", "coolify-proxy"), rem("container", `${UUID}-1`), rem("network", "coolify"), rem("network", UUID), rem("image", "ghcr.io/coollabsio/sentinel:0.0.16"), rem("directory", "/data/coolify/proxy"), rem("directory", "/data/coolify/applications/app1")]) {
      expect(() => assertRemovable(r)).not.toThrow();
    }
  });
  it("refuses the control plane, foreign images, other networks and every path outside the list", () => {
    const bad = [
      rem("container", "coolify"),
      rem("container", "coolify-db"),
      rem("container", "x; rm -rf /"),
      rem("container", "-v"),
      rem("network", "bridge"),
      rem("network", "mynet"),
      rem("image", "postgres:16"),
      rem("image", "ghcr.io/coollabsio/coolify-helper:1;id"),
      rem("directory", "/data/coolify"),
      rem("directory", "/data/coolify/databases/abc"),
      rem("directory", "/data/coolify/backups"),
      rem("directory", "/data/coolify/proxy/../../etc"),
      rem("directory", "/data/coolify/applications"),
      rem("directory", "/data/coolify/applications/a/b"),
      rem("directory", "/etc"),
      rem("directory", "/var/lib/docker/volumes/x"),
      { ...rem("container", "coolify-proxy"), keep: true, reason: "running" as const },
    ];
    for (const r of bad) expect(() => assertRemovable(r)).toThrow(UnsafeRemnantError);
  });
  it("buildRemoveScript refuses the whole list when any item is outside the allow-list", () => {
    expect(() => buildRemoveScript([rem("container", "coolify-proxy"), rem("directory", "/home")])).toThrow(UnsafeRemnantError);
  });
});

describe("the removal script: what it can and cannot do", () => {
  const script = buildRemoveScript([rem("container", "coolify-proxy"), rem("network", "coolify"), rem("image", "ghcr.io/coollabsio/sentinel:1"), rem("directory", "/data/coolify/proxy")]);
  it("is valid sh", () => {
    expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
  });
  it("never removes a volume, never prunes, never forces an image, never uses -v with rm", () => {
    for (const bad of [/docker volume/, /\bprune\b/, /rmi -f/, /rmi --force/, /docker rm (-\w*v)/, /docker system/, /--volumes/, /docker run/, /docker exec/, /\bkill\b/]) expect(script).not.toMatch(bad);
  });
  it("uses rm -rf only on the validated, quoted directory variable list", () => {
    const rms = script.split("\n").filter((l) => /rm -rf/.test(l));
    expect(rms).toHaveLength(1);
    expect(rms[0]).toContain('rm -rf -- "$p"');
    expect(script.split("\n")).toContain("rm_directory '/data/coolify/proxy'");
  });
  it("stays small per item: a large fleet's list fits under the per-argument limit of the host wrapper", () => {
    const many = Array.from({ length: 600 }, (_, i) => rem("container", `app-${String(i).padStart(4, "0")}-170000`));
    const big = buildRemoveScript(many);
    // base64 inside the wrapper is 4/3 of this, and one argument may not pass 128 KiB (131072 bytes)
    expect(Math.ceil((big.length * 4) / 3)).toBeLessThan(100_000);
  });
});

describe("parseRemoveOutput", () => {
  const items = [rem("container", "a"), rem("network", "coolify")];
  it("reads the result lines", () => {
    expect(parseRemoveOutput("TUGRA_CU_R|container|a|ok\nTUGRA_CU_R|network|coolify|in_use\nTUGRA_CU_DONE\n", items)).toEqual([
      { kind: "container", name: "a", code: "ok" },
      { kind: "network", name: "coolify", code: "in_use" },
    ]);
  });
  it("an item with no line, or output that never finished, is failed: unknown is never ok", () => {
    expect(parseRemoveOutput("TUGRA_CU_R|container|a|ok\nTUGRA_CU_DONE\n", items)[1].code).toBe("failed");
    expect(parseRemoveOutput("TUGRA_CU_R|container|a|ok\n", items).map((r) => r.code)).toEqual(["failed", "failed"]);
  });
  it("an unknown code is ignored", () => {
    expect(parseRemoveOutput("TUGRA_CU_R|container|a|deleted-everything\nTUGRA_CU_DONE\n", items)[0].code).toBe("failed");
  });
});

// ── the real script against a fake docker and a fake /data/coolify ──────────────────────────────────────────────────────────────

const FAKE_DOCKER = `#!/bin/bash
ST="$FAKE_STATE"
echo "$*" >> "$ST/calls.log"
cmd="$1"; shift
key() { echo "$1" | tr '/:' '__'; }
case "$cmd" in
  inspect)
    fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
    f="$ST/c/$1"; [ -f "$f" ] || exit 1
    case "$fmt" in
      "") exit 0 ;;
      *Config.Image*) grep '^image=' "$f" | cut -d= -f2- ;;
      *coolify.managed*) grep '^label=' "$f" | cut -d= -f2- ;;
      *State.Running*) grep '^running=' "$f" | cut -d= -f2- ;;
      *Mounts*) grep '^mounts=' "$f" | cut -d= -f2- ;;
    esac ;;
  ps) ls "$ST/c" 2>/dev/null ;;
  rm)
    force=0; if [ "$1" = "-f" ]; then force=1; shift; fi
    f="$ST/c/$1"; [ -f "$f" ] || exit 1
    if grep -q '^running=true' "$f" && [ $force = 0 ]; then exit 1; fi
    rm -f "$f" ;;
  network)
    sub="$1"; shift
    case "$sub" in
      inspect) fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi; [ -f "$ST/n/$1" ] || exit 1; [ -n "$fmt" ] && cat "$ST/n/$1"; exit 0 ;;
      rm) [ -f "$ST/n/$1" ] || exit 1; [ "$(cat "$ST/n/$1")" = 0 ] || exit 1; rm -f "$ST/n/$1" ;;
    esac ;;
  image) [ "$1" = inspect ] && { [ -f "$ST/i/$(key "$2")" ] || exit 1; } ;;
  rmi) k=$(key "$1"); [ -f "$ST/i/$k" ] || exit 1; [ -f "$ST/i/$k.inuse" ] && exit 1; rm -f "$ST/i/$k" ;;
esac
exit 0
`;

interface Lab {
  root: string;
  st: string;
  bin: string;
  run: (items: CleanupRemnant[]) => ReturnType<typeof parseRemoveOutput>;
  calls: () => string;
}

function lab(setup: (l: { st: string; root: string; container: (n: string, o?: { image?: string; label?: string; running?: boolean; mounts?: string[] }) => void; network: (n: string, c: number) => void; image: (r: string, inuse?: boolean) => void; dir: (p: string, files?: string[]) => void }) => void): Lab {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-lab-")));
  const st = join(base, "state");
  const bin = join(base, "bin");
  const root = join(base, "data", "coolify");
  for (const d of [join(st, "c"), join(st, "n"), join(st, "i"), bin, root]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const api = {
    st,
    root,
    container: (n: string, o: { image?: string; label?: string; running?: boolean; mounts?: string[] } = {}) =>
      writeFileSync(join(st, "c", n), `image=${o.image ?? "x"}\nlabel=${o.label ?? ""}\nrunning=${o.running ? "true" : "false"}\nmounts=${(o.mounts ?? []).join(" ")}\n`),
    network: (n: string, c: number) => writeFileSync(join(st, "n", n), String(c)),
    image: (r: string, inuse = false) => {
      const k = r.replace(/[/:]/g, "_");
      writeFileSync(join(st, "i", k), "");
      if (inuse) writeFileSync(join(st, "i", `${k}.inuse`), "");
    },
    dir: (p: string, files: string[] = ["file"]) => {
      mkdirSync(join(root, p), { recursive: true });
      for (const f of files) {
        mkdirSync(join(root, p, f, ".."), { recursive: true });
        writeFileSync(join(root, p, f), "x");
      }
    },
  };
  setup(api);
  return {
    root,
    st,
    bin,
    calls: () => (existsSync(join(st, "calls.log")) ? readFileSync(join(st, "calls.log"), "utf8") : ""),
    run: (items) => {
      // The only rewrite: /data/coolify -> the lab's directory. Validation ran against the real paths.
      const script = buildRemoveScript(items).split("/data/coolify").join(root);
      const r = spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_STATE: st, HOME: base }, encoding: "utf8" });
      expect(r.status).toBe(0);
      return parseRemoveOutput(r.stdout.split(root).join("/data/coolify"), items);
    },
  };
}
const cleanup: Lab[] = [];
afterAll(() => cleanup.forEach((l) => rmSync(join(l.st, ".."), { recursive: true, force: true })));
const L = (setup: Parameters<typeof lab>[0]) => {
  const l = lab(setup);
  cleanup.push(l);
  return l;
};
const codes = (res: ReturnType<typeof parseRemoveOutput>) => Object.fromEntries(res.map((r) => [`${r.kind}:${r.name}`, r.code]));

describe("the removal script on a fake host", () => {
  it("removes Coolify's proxy, sentinel and helper, and an exited managed container; leaves a running managed one and a user's own", () => {
    const l = L((x) => {
      x.container("coolify-proxy", { image: "traefik:v3.1", label: "true" });
      x.container("coolify-sentinel", { image: "ghcr.io/coollabsio/sentinel:1", running: true });
      x.container("helper1", { image: "ghcr.io/coollabsio/coolify-helper:1" });
      x.container("old-app", { label: "true" });
      x.container("live-app", { label: "true", running: true });
      x.container("postgres-main", { image: "postgres:16" });
    });
    const res = codes(l.run(["coolify-proxy", "coolify-sentinel", "helper1", "old-app", "live-app", "postgres-main", "gone"].map((n) => rem("container", n))));
    expect(res).toEqual({
      "container:coolify-proxy": "ok",
      "container:coolify-sentinel": "ok",
      "container:helper1": "ok",
      "container:old-app": "ok",
      "container:live-app": "running",
      "container:postgres-main": "refused",
      "container:gone": "absent",
    });
    expect(existsSync(join(l.st, "c", "live-app"))).toBe(true);
    expect(existsSync(join(l.st, "c", "postgres-main"))).toBe(true);
    expect(existsSync(join(l.st, "c", "coolify-proxy"))).toBe(false);
  });

  it("a running coolify-proxy is refused, not force-removed", () => {
    const l = L((x) => x.container("coolify-proxy", { label: "true", running: true }));
    expect(codes(l.run([rem("container", "coolify-proxy")]))).toEqual({ "container:coolify-proxy": "running" });
    expect(existsSync(join(l.st, "c", "coolify-proxy"))).toBe(true);
  });

  it("removes an empty Coolify network and an image nobody uses; an attached network and an image in use stay", () => {
    const l = L((x) => {
      x.network("coolify", 0);
      x.network("coolify-overlay", 2);
      x.image("ghcr.io/coollabsio/sentinel:1");
      x.image("ghcr.io/coollabsio/coolify-helper:1", true);
    });
    const res = codes(l.run([rem("network", "coolify"), rem("network", "coolify-overlay"), rem("image", "ghcr.io/coollabsio/sentinel:1"), rem("image", "ghcr.io/coollabsio/coolify-helper:1"), rem("image", "ghcr.io/coollabsio/coolify-realtime:1")]));
    expect(res).toEqual({
      "network:coolify": "ok",
      "network:coolify-overlay": "in_use",
      "image:ghcr.io/coollabsio/sentinel:1": "ok",
      "image:ghcr.io/coollabsio/coolify-helper:1": "in_use",
      "image:ghcr.io/coollabsio/coolify-realtime:1": "absent",
    });
    expect(existsSync(join(l.st, "n", "coolify-overlay"))).toBe(true);
    expect(existsSync(join(l.st, "i", "ghcr.io_coollabsio_coolify-helper_1"))).toBe(true);
  });

  it("removes Coolify's own directories; refuses a mounted one, a symlink and anything that resolves elsewhere; keeps the owner's data", () => {
    const l = L((x) => {
      x.dir("proxy");
      x.dir("applications/app1", ["docker-compose.yml", ".env"]);
      x.dir("applications/app2");
      x.dir("databases/dbuuid");
      x.dir("backups");
      x.container("web", { label: "true", running: true, mounts: [`${x.root}/applications/app2/files`] });
      mkdirSync(join(x.root, "..", "elsewhere"), { recursive: true });
      writeFileSync(join(x.root, "..", "elsewhere", "precious"), "data");
      symlinkSync(join(x.root, "..", "elsewhere"), join(x.root, "ssh"));
    });
    const res = codes(l.run([rem("directory", "/data/coolify/proxy"), rem("directory", "/data/coolify/applications/app1"), rem("directory", "/data/coolify/applications/app2"), rem("directory", "/data/coolify/ssh"), rem("directory", "/data/coolify/sentinel")]));
    expect(res).toEqual({
      "directory:/data/coolify/proxy": "ok",
      "directory:/data/coolify/applications/app1": "ok",
      "directory:/data/coolify/applications/app2": "mounted",
      "directory:/data/coolify/ssh": "refused",
      "directory:/data/coolify/sentinel": "absent",
    });
    expect(existsSync(join(l.root, "proxy"))).toBe(false);
    expect(existsSync(join(l.root, "applications", "app2", "file"))).toBe(true);
    expect(existsSync(join(l.root, "..", "elsewhere", "precious"))).toBe(true);
    expect(existsSync(join(l.root, "databases", "dbuuid", "file"))).toBe(true);
    expect(existsSync(join(l.root, "backups", "file"))).toBe(true);
    expect(existsSync(l.root)).toBe(true); // not empty: the root stays
  });

  it("a resource directory holding anything besides compose files and .env is the owner's data: refused, even when no container mounts it", () => {
    const l = L((x) => {
      x.dir("services/svc1", ["docker-compose.yaml", ".env"]);
      x.dir("services/svc2", ["docker-compose.yaml", "data/pgdata/PG_VERSION"]);
      x.dir("applications/app3", ["uploads/photo.jpg"]);
    });
    const res = codes(l.run([rem("directory", "/data/coolify/services/svc1"), rem("directory", "/data/coolify/services/svc2"), rem("directory", "/data/coolify/applications/app3")]));
    expect(res).toEqual({
      "directory:/data/coolify/services/svc1": "ok",
      "directory:/data/coolify/services/svc2": "refused",
      "directory:/data/coolify/applications/app3": "refused",
    });
    expect(existsSync(join(l.root, "services", "svc2", "data", "pgdata", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(l.root, "applications", "app3", "uploads", "photo.jpg"))).toBe(true);
  });

  it("a container removed in the same run still protects the directory it mounted (the mounts are read before anything is removed)", () => {
    const l = L((x) => {
      x.dir("services/svc1", ["docker-compose.yaml"]);
      x.container("svc1-web", { label: "true", mounts: [`${x.root}/services/svc1`] }); // stopped, managed: goes in this very run
    });
    const res = codes(l.run([rem("container", "svc1-web"), rem("directory", "/data/coolify/services/svc1")]));
    expect(res).toEqual({ "container:svc1-web": "ok", "directory:/data/coolify/services/svc1": "mounted" });
    expect(existsSync(join(l.root, "services", "svc1", "docker-compose.yaml"))).toBe(true);
  });

  it("removes the empty parents when everything inside went, and only then", () => {
    const l = L((x) => x.dir("proxy"));
    l.run([rem("directory", "/data/coolify/proxy")]);
    expect(existsSync(l.root)).toBe(false);
  });

  it("never calls docker with volume, prune, -v or -f on rmi; a clean run touches nothing else", () => {
    const l = L((x) => {
      x.container("coolify-proxy", { label: "true" });
      x.network("coolify", 0);
      x.image("ghcr.io/coollabsio/sentinel:1");
      x.dir("proxy");
    });
    l.run([rem("container", "coolify-proxy"), rem("network", "coolify"), rem("image", "ghcr.io/coollabsio/sentinel:1"), rem("directory", "/data/coolify/proxy")]);
    const calls = l.calls();
    expect(calls).not.toMatch(/volume|prune|system/);
    expect(calls).not.toMatch(/rmi -f|rm -\w*v/);
    expect(calls).toMatch(/^rm coolify-proxy$/m);
  });
});
