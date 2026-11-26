import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScanScript, classifyScan, containerBelongsTo, listHash, parseHumanSize, parseScan, ScanError, type ScanResult } from "./remnant-scan";

const UUID = "abcd1234efgh5678ijkl9012";
const scan = (over: Partial<ScanResult> = {}): ScanResult => ({ volumes: [], containers: [], networks: [], images: [], mounts: [], dirs: [], ...over });
const find = (c: ReturnType<typeof classifyScan>, kind: string, name: string) => c.remnants.find((r) => r.kind === kind && r.name === name);

describe("the scan script", () => {
  const script = buildScanScript();
  it("is read-only: no removal, stop, prune or write verb anywhere", () => {
    for (const bad of [/\brm\b/, /\brmi\b/, /\bprune\b/, /\bstop\b/, /\bkill\b/, /docker volume (rm|create|prune)/, /\bmkdir\b/, /\bchmod\b/, />\s*\/(?!dev\/null)/]) expect(script).not.toMatch(bad);
  });
  it("is valid sh", () => {
    expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
  });
  it("reads docker volume NAMES (for the checklist) and, for a local bind volume, the host folder behind it (so that folder counts as in use) and nothing else about them", () => {
    expect(script.match(/docker volume \w+/g)).toEqual(["docker volume ls", "docker volume ls", "docker volume inspect"]);
    expect(script).toContain("TUGRA_CU_V|{{.Name}}");
    expect(script.match(/volume inspect -f '([^']+)'/)?.[1]).toBe('{{index .Options "device"}}');
  });
});

describe("the scan script on a fake /data/coolify: what counts as the owner's data", () => {
  it("marks a resource directory as data when it holds anything besides compose files and .env", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "scan-lab-")));
    try {
      const root = join(base, "data", "coolify");
      const bin = join(base, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "docker"), 0o755);
      const put = (p: string) => {
        mkdirSync(join(root, p, ".."), { recursive: true });
        writeFileSync(join(root, p), "x");
      };
      put("services/plain1/docker-compose.yaml");
      put("services/plain1/.env");
      put("services/data1/docker-compose.yaml");
      put("services/data1/pgdata/PG_VERSION");
      put("applications/up1/uploads/a.jpg");
      put("applications/plain2/docker-compose.yml");
      put("proxy/acme.json");
      const script = buildScanScript().split("/data/coolify").join(root);
      const r = spawnSync("sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
      expect(r.status).toBe(0);
      const dirs = Object.fromEntries(parseScan(r.stdout.split(root).join("/data/coolify")).dirs.map((d) => [d.path, d.data]));
      expect(dirs["/data/coolify/services/plain1"]).toBe(false);
      expect(dirs["/data/coolify/applications/plain2"]).toBe(false);
      expect(dirs["/data/coolify/services/data1"]).toBe(true);
      expect(dirs["/data/coolify/applications/up1"]).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("parseScan", () => {
  const out = [
    "Welcome banner",
    "TUGRA_CU_BEGIN",
    "TUGRA_CU_C|coolify-proxy|traefik:v3.1|exited|true",
    "TUGRA_CU_C|coolify-sentinel|ghcr.io/coollabsio/sentinel:0.0.16|running|",
    "TUGRA_CU_N|coolify|0",
    "TUGRA_CU_N|bridge|?",
    "TUGRA_CU_V|abc-data",
    "TUGRA_CU_V|bad name with spaces",
    "TUGRA_CU_I|ghcr.io/coollabsio/coolify-helper:1.0.8|abc123|35.5MB",
    "TUGRA_CU_M|/coolify-proxy|/data/coolify/proxy;/var/run/docker.sock;",
    "TUGRA_CU_D|/data/coolify/proxy|2048|plain",
    "TUGRA_CU_D|/data/coolify/applications/y|10|data",
    "TUGRA_CU_D|/data/coolify/applications/x|link",
    "TUGRA_CU_D|/etc/passwd|1",
    "TUGRA_CU_END",
    "",
  ].join("\n");
  it("reads every record, drops banners and paths outside /data/coolify", () => {
    const r = parseScan(out);
    expect(r.containers).toHaveLength(2);
    expect(r.containers[0]).toEqual({ name: "coolify-proxy", image: "traefik:v3.1", state: "exited", managed: true });
    expect(r.networks).toEqual([{ name: "coolify", attached: 0 }, { name: "bridge", attached: null }]);
    expect(r.volumes).toEqual(["abc-data"]);
    expect(r.images[0]).toMatchObject({ ref: "ghcr.io/coollabsio/coolify-helper:1.0.8", sizeBytes: 35_500_000 });
    expect(r.mounts[0]).toEqual({ container: "coolify-proxy", sources: ["/data/coolify/proxy", "/var/run/docker.sock"] });
    expect(r.dirs).toEqual([
      { path: "/data/coolify/proxy", sizeBytes: 2048 * 1024, link: false, data: false },
      { path: "/data/coolify/applications/y", sizeBytes: 10 * 1024, link: false, data: true },
      { path: "/data/coolify/applications/x", sizeBytes: null, link: true, data: true },
    ]);
  });
  it("a bind volume's host folder is read as a mount of that volume; a device that is not an absolute path or a bad name is dropped", () => {
    const r = parseScan(["TUGRA_CU_BEGIN", "TUGRA_CU_B|tugra_a_content|/data/coolify/services/u/uploads", "TUGRA_CU_B|bad name|/x", "TUGRA_CU_B|v|relative", "TUGRA_CU_B|w|/a;/b", "TUGRA_CU_END"].join("\n"));
    expect(r.mounts).toEqual([{ container: "volume:tugra_a_content", sources: ["/data/coolify/services/u/uploads"] }]);
  });
  it("a cut listing is unreadable, never empty", () => {
    expect(() => parseScan("TUGRA_CU_BEGIN\nTUGRA_CU_C|a|b|exited|")).toThrow(ScanError);
    expect(() => parseScan("")).toThrow(ScanError);
  });
  it("no docker is its own error", () => {
    expect(() => parseScan("TUGRA_CU_NO_DOCKER")).toThrow(expect.objectContaining({ code: "no_docker" }));
  });
  it("parses docker's human sizes", () => {
    expect(parseHumanSize("1.2GB")).toBe(1_200_000_000);
    expect(parseHumanSize("512kB")).toBe(512_000);
    expect(parseHumanSize("lots")).toBeNull();
  });
});

describe("classifyScan: containers", () => {
  it("an exited coolify-proxy, a sentinel (even running), a helper and an exited managed container are removable", () => {
    const c = classifyScan(
      scan({
        containers: [
          { name: "coolify-proxy", image: "traefik:v3.1", state: "exited", managed: true },
          { name: "coolify-sentinel", image: "ghcr.io/coollabsio/sentinel:0.0.16", state: "running", managed: false },
          { name: "helper1", image: "ghcr.io/coollabsio/coolify-helper:1.0.8", state: "exited", managed: false },
          { name: `${UUID}-123`, image: `${UUID}:abc`, state: "exited", managed: true },
        ],
      }),
      { knownUuids: [UUID], completeUuids: [UUID] },
    );
    for (const n of ["coolify-proxy", "coolify-sentinel", "helper1", `${UUID}-123`]) expect(find(c, "container", n)?.keep).toBeUndefined();
  });

  it("a stopped managed container is removable only when its uuid is known AND matched complete; any other is kept", () => {
    const stopped = [
      { name: `${UUID}-123`, image: "x", state: "exited", managed: true }, // application: <uuid>-<stamp>
      { name: `plausible-${UUID}`, image: "x", state: "exited", managed: true }, // service: <name>-<uuid>
      { name: "zzzz9999yyyy8888xxxx7777", image: "x", state: "exited", managed: true }, // created in Coolify after the read
      { name: "old-app", image: "x", state: "exited", managed: true }, // no uuid in the name at all
    ];
    const none = classifyScan(scan({ containers: stopped }), { knownUuids: [UUID] }); // known but not matched complete
    for (const x of stopped) expect(find(none, "container", x.name)).toMatchObject({ keep: true, reason: "unknown" });
    const some = classifyScan(scan({ containers: stopped }), { knownUuids: [UUID], completeUuids: [UUID] });
    expect(find(some, "container", `${UUID}-123`)?.keep).toBeUndefined();
    expect(find(some, "container", `plausible-${UUID}`)?.keep).toBeUndefined();
    expect(find(some, "container", "zzzz9999yyyy8888xxxx7777")).toMatchObject({ keep: true, reason: "unknown" });
    expect(find(some, "container", "old-app")).toMatchObject({ keep: true, reason: "unknown" });
    // complete but not known to the stored read: nothing
    const unknown = classifyScan(scan({ containers: stopped }), { knownUuids: [], completeUuids: [UUID] });
    expect(find(unknown, "container", `${UUID}-123`)).toMatchObject({ keep: true });
  });

  it("containerBelongsTo matches a whole dash-separated token only", () => {
    expect(containerBelongsTo(UUID, UUID)).toBe(true);
    expect(containerBelongsTo(`${UUID}-99`, UUID)).toBe(true);
    expect(containerBelongsTo(`db-${UUID}`, UUID)).toBe(true);
    expect(containerBelongsTo(`${UUID}x`, UUID)).toBe(false);
    expect(containerBelongsTo(`x${UUID}`, UUID)).toBe(false);
    expect(containerBelongsTo("anything", "short")).toBe(false);
  });

  it("a running proxy, a running helper and a running managed app are kept, never removed", () => {
    const c = classifyScan(
      scan({
        containers: [
          { name: "coolify-proxy", image: "traefik:v3.1", state: "running", managed: true },
          { name: "h", image: "coollabsio/coolify-helper:1", state: "running", managed: false },
          { name: "app1", image: "x:y", state: "running", managed: true },
        ],
      }),
      { knownUuids: [] },
    );
    for (const n of ["coolify-proxy", "h", "app1"]) expect(find(c, "container", n)).toMatchObject({ keep: true, reason: "running" });
  });

  it("a user's own container (no Coolify name, image or label) is not even listed", () => {
    const c = classifyScan(scan({ containers: [{ name: "postgres-main", image: "postgres:16", state: "exited", managed: false }] }), { knownUuids: [] });
    expect(c.remnants).toEqual([]);
  });

  it("a Coolify control-plane container means the whole server is the Coolify host: nothing is removable", () => {
    const c = classifyScan(
      scan({ containers: [{ name: "coolify-db", image: "postgres:15", state: "running", managed: false }, { name: "coolify-proxy", image: "traefik", state: "exited", managed: true }], networks: [{ name: "coolify", attached: 0 }] }),
      { knownUuids: [] },
    );
    expect(c.controlPlane).toBe(true);
    expect(c.remnants.every((r) => r.keep)).toBe(true);
    expect(c.remnants).toEqual([{ kind: "container", name: "coolify-db", sizeBytes: null, keep: true, reason: "control_plane" }]);
  });
});

describe("classifyScan: networks and images", () => {
  it("removes an empty Coolify network and an empty per-resource one the hub names; keeps one with containers; ignores the rest", () => {
    const c = classifyScan(
      scan({ networks: [{ name: "coolify", attached: 0 }, { name: UUID, attached: 0 }, { name: "coolify-overlay", attached: 2 }, { name: "bridge", attached: 0 }, { name: "mynet", attached: 0 }, { name: "zzzz9999yyyy8888xxxx7777", attached: 0 }] }),
      { knownUuids: [UUID] },
    );
    expect(find(c, "network", "coolify")?.keep).toBeUndefined();
    expect(find(c, "network", UUID)?.keep).toBeUndefined();
    expect(find(c, "network", "coolify-overlay")).toMatchObject({ keep: true, reason: "in_use" });
    expect(find(c, "network", "bridge")).toBeUndefined();
    expect(find(c, "network", "mynet")).toBeUndefined();
    expect(find(c, "network", "zzzz9999yyyy8888xxxx7777")).toBeUndefined(); // looks like a uuid but the hub does not know it
  });

  it("an unknown attachment count is kept, not removed", () => {
    expect(find(classifyScan(scan({ networks: [{ name: "coolify", attached: null }] }), { knownUuids: [] }), "network", "coolify")).toMatchObject({ keep: true, reason: "in_use" });
  });

  it("only Coolify's own images are listed; one a kept container uses is kept; app-built images are never touched", () => {
    const c = classifyScan(
      scan({
        containers: [{ name: "coolify-proxy", image: "ghcr.io/coollabsio/coolify-helper:1.0.8", state: "running", managed: true }],
        images: [
          { ref: "ghcr.io/coollabsio/coolify-helper:1.0.8", id: "a", sizeBytes: 5 },
          { ref: "ghcr.io/coollabsio/sentinel:0.0.16", id: "b", sizeBytes: 7 },
          { ref: `${UUID}:abcdef`, id: "c", sizeBytes: 9 },
          { ref: "postgres:16", id: "d", sizeBytes: 9 },
          { ref: "traefik:v3.1", id: "e", sizeBytes: 9 },
        ],
      }),
      { knownUuids: [UUID] },
    );
    expect(find(c, "image", "ghcr.io/coollabsio/coolify-helper:1.0.8")).toMatchObject({ keep: true, reason: "in_use" });
    expect(find(c, "image", "ghcr.io/coollabsio/sentinel:0.0.16")).toMatchObject({ sizeBytes: 7 });
    expect(find(c, "image", "ghcr.io/coollabsio/sentinel:0.0.16")?.keep).toBeUndefined();
    for (const n of [`${UUID}:abcdef`, "postgres:16", "traefik:v3.1"]) expect(find(c, "image", n)).toBeUndefined();
  });
});

describe("classifyScan: directories under /data/coolify", () => {
  const dir = (path: string, sizeBytes: number | null = 1024, link = false, data = false) => ({ path, sizeBytes, link, data });
  it("Coolify's own machinery is removable; database dumps and backups are the owner's data and are kept", () => {
    const c = classifyScan(
      scan({ dirs: [dir("/data/coolify/proxy"), dir("/data/coolify/ssh"), dir("/data/coolify/databases/abc"), dir("/data/coolify/backups"), dir("/data/coolify/weird"), dir(`/data/coolify/applications/${UUID}`)] }),
      { knownUuids: [UUID], completeUuids: [UUID] },
    );
    expect(find(c, "directory", "/data/coolify/proxy")?.keep).toBeUndefined();
    expect(find(c, "directory", "/data/coolify/ssh")?.keep).toBeUndefined();
    expect(find(c, "directory", `/data/coolify/applications/${UUID}`)?.keep).toBeUndefined();
    expect(find(c, "directory", "/data/coolify/databases/abc")).toMatchObject({ keep: true, reason: "user_data" });
    expect(find(c, "directory", "/data/coolify/backups")).toMatchObject({ keep: true, reason: "user_data" });
    expect(find(c, "directory", "/data/coolify/weird")).toMatchObject({ keep: true, reason: "unknown" });
  });

  it("a directory ANY container mounts (itself, a child or a parent) is in use, including one that is itself about to be removed", () => {
    const base = scan({
      containers: [
        { name: "coolify-proxy", image: "traefik", state: "exited", managed: true },
        { name: "web", image: "x", state: "running", managed: true },
      ],
      dirs: [dir("/data/coolify/proxy"), dir(`/data/coolify/applications/${UUID}`), dir("/data/coolify/applications/zzzz9999yyyy8888xxxx7777")],
      mounts: [
        { container: "coolify-proxy", sources: ["/data/coolify/proxy"] },
        { container: "web", sources: [`/data/coolify/applications/${UUID}/files`, "/data/coolify/applications"] },
      ],
    });
    const c = classifyScan(base, { knownUuids: [UUID, "zzzz9999yyyy8888xxxx7777"], completeUuids: [UUID, "zzzz9999yyyy8888xxxx7777"] });
    expect(find(c, "directory", "/data/coolify/proxy")).toMatchObject({ keep: true, reason: "in_use" }); // the stopped proxy still mounts it
    expect(find(c, "directory", `/data/coolify/applications/${UUID}`)).toMatchObject({ keep: true, reason: "in_use" });
    expect(find(c, "directory", "/data/coolify/applications/zzzz9999yyyy8888xxxx7777")).toMatchObject({ keep: true, reason: "in_use" }); // the parent is mounted
  });

  it("a stopped managed container's bind data under /data/coolify/services/<uuid> is never removed with it", () => {
    const c = classifyScan(
      scan({
        containers: [{ name: `db-${UUID}`, image: "postgres:16", state: "exited", managed: true }],
        dirs: [dir(`/data/coolify/services/${UUID}`, 5_000_000, false, true)],
        mounts: [{ container: `db-${UUID}`, sources: [`/data/coolify/services/${UUID}/pgdata`] }],
      }),
      { knownUuids: [UUID], completeUuids: [UUID] },
    );
    expect(find(c, "container", `db-${UUID}`)?.keep).toBeUndefined(); // the container may go
    expect(find(c, "directory", `/data/coolify/services/${UUID}`)).toMatchObject({ keep: true }); // its data stays
  });

  it("a service folder that a Tugra bind volume points at is in use even when it holds nothing but compose files (it may hold an empty data folder)", () => {
    const c = classifyScan(
      scan({
        dirs: [dir(`/data/coolify/services/${UUID}`, 4_000, false, false)],
        mounts: [{ container: "volume:tugra_app_content", sources: [`/data/coolify/services/${UUID}/uploads`] }],
      }),
      { knownUuids: [UUID], completeUuids: [UUID] },
    );
    expect(find(c, "directory", `/data/coolify/services/${UUID}`)).toMatchObject({ keep: true, reason: "in_use" });
    // the same folder with no such volume is removable
    const free = classifyScan(scan({ dirs: [dir(`/data/coolify/services/${UUID}`, 4_000, false, false)] }), { knownUuids: [UUID], completeUuids: [UUID] });
    expect(find(free, "directory", `/data/coolify/services/${UUID}`)?.keep).toBeUndefined();
  });

  it("an applications or services directory is removable only for a uuid matched complete, and never when it holds more than compose files", () => {
    const U2 = "wxyz1234abcd5678efgh9012";
    const dirs = [dir(`/data/coolify/applications/${UUID}`), dir(`/data/coolify/services/${UUID}`, 1, false, true), dir(`/data/coolify/applications/${U2}`), dir("/data/coolify/services/notauuid")];
    const c = classifyScan(scan({ dirs }), { knownUuids: [UUID], completeUuids: [UUID] });
    expect(find(c, "directory", `/data/coolify/applications/${UUID}`)?.keep).toBeUndefined();
    expect(find(c, "directory", `/data/coolify/services/${UUID}`)).toMatchObject({ keep: true, reason: "user_data" });
    expect(find(c, "directory", `/data/coolify/applications/${U2}`)).toMatchObject({ keep: true, reason: "unknown" }); // created after the read
    expect(find(c, "directory", "/data/coolify/services/notauuid")).toMatchObject({ keep: true, reason: "unknown" });
    const known = classifyScan(scan({ dirs }), { knownUuids: [UUID] }); // known, but the checklist did not match it complete
    expect(find(known, "directory", `/data/coolify/applications/${UUID}`)).toMatchObject({ keep: true, reason: "unknown" });
  });

  it("a symlink is never removable", () => {
    expect(find(classifyScan(scan({ dirs: [dir("/data/coolify/proxy", null, true)] }), { knownUuids: [] }), "directory", "/data/coolify/proxy")).toMatchObject({ keep: true, reason: "unknown" });
  });

  it("a docker volume is never a remnant, even one named like Coolify's: there is no volume remnant kind at all", () => {
    const c = classifyScan(scan({ volumes: [`${UUID}-data`], dirs: [dir("/data/coolify/proxy")] }), { knownUuids: [UUID] });
    expect(c.remnants.every((r) => ["container", "network", "image", "directory"].includes(r.kind))).toBe(true);
  });
});

describe("listHash", () => {
  const a = { kind: "container" as const, name: "coolify-proxy", sizeBytes: null };
  const b = { kind: "image" as const, name: "ghcr.io/coollabsio/sentinel:1", sizeBytes: 5 };
  it("depends on the removable names only, in any order", () => {
    expect(listHash([a, b])).toBe(listHash([b, a]));
    expect(listHash([a, b])).not.toBe(listHash([a]));
    expect(listHash([a, { ...b, sizeBytes: 99 }])).toBe(listHash([a, b]));
  });
  it("ignores kept entries, so a changing kept list does not invalidate a confirmation, but a new removable one does", () => {
    expect(listHash([a, { kind: "directory", name: "/data/coolify/backups", sizeBytes: 1, keep: true, reason: "user_data" }])).toBe(listHash([a]));
  });
});
