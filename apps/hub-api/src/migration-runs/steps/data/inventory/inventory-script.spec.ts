import { InventoryHostFake, type InventoryHostOptions } from "./testing/inventory-host-fake";
import { inventoryShellLines } from "./inventory-script";
import { parseReportBody } from "./host-protocol";
import { renderMigratorInstallScript } from "../../../../install/migrator-install-script";
import { spawnSync } from "node:child_process";

/** What the script's own os probe yields on this machine (empty on macOS, the PRETTY_NAME on a Linux runner). */
const runnerOs = (): string =>
  spawnSync("sh", ["-c", `( . /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME" ) | tr '\\t\\r\\n' '???'`], { encoding: "utf8" }).stdout;

const TOKEN = `tugra_mig_${"A".repeat(43)}`;
const HUB = "https://hub.example.test";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

let fake: InventoryHostFake | null = null;
afterEach(() => {
  fake?.dispose();
  fake = null;
});

/** The function under test, wrapped like migrator.sh wraps it (die + the token in the environment). */
function run(opts: InventoryHostOptions, extraEnv: Record<string, string> = {}, ref = "srv-1") {
  fake = new InventoryHostFake(opts);
  const program = [
    "set -eu",
    'die() { printf "tugra-migrator: %s\\n" "$1" >&2; exit "${2:-2}"; }',
    ...inventoryShellLines(),
    `TUGRA_MIGRATION_TOKEN=${TOKEN}`,
    "export TUGRA_MIGRATION_TOKEN",
    `tugra_inventory ${ref} ${HUB}`,
  ].join("\n");
  const r = fake.sh(program, extraEnv);
  return { ...r, parsed: parseReportBody(r.stdout) };
}

const base: InventoryHostOptions = {
  containers: [
    { id: A, name: "db0aaaaaaaaaaaaaaaaaaaaaa", image: "postgres:16-alpine", mounts: [{ type: "volume", name: "pg-data", source: "/var/lib/docker/volumes/pg-data/_data", dest: "/var/lib/postgresql/data" }] },
    { id: B, name: "minio0bbbbbbbbbbbbbbbbbbbbb", image: "minio/minio:RELEASE.2025-04-22T22-12-26Z", mounts: [{ type: "bind", source: "/mnt/data-1/minio", dest: "/data" }] },
    { id: C, name: "app0cccccccccccccccccccc-170000000000", image: "ghcr.io/example/app:1", mounts: [{ type: "tmpfs", source: "", dest: "/tmp" }] },
  ],
  volumes: [{ name: "pg-data" }, { name: "orphan-vol" }],
  du: { "/var/lib/docker/volumes/pg-data/_data": 2048, "/var/lib/docker/volumes/orphan-vol/_data": 12, "/mnt/data-1/minio": 4096 },
};

describe("host inventory script (run for real against a fake docker/du/curl)", () => {
  it("reports every container, its mounts, every volume with its link count, and the bind sizes measured with du", () => {
    const r = run(base);
    expect(r.code).toBe(0);
    const inv = r.parsed.inventory.get("srv-1")!;
    expect(inv.complete).toBe(true);
    expect(inv.rejected).toBe(0);
    expect(inv.host).toEqual({ name: "host-a", docker: "27.3.1", os: runnerOs() }); // the script reads the real /etc/os-release
    expect(inv.containers.map((c) => [c.name, c.image, c.state])).toEqual([
      ["db0aaaaaaaaaaaaaaaaaaaaaa", "postgres:16-alpine", "running"],
      ["minio0bbbbbbbbbbbbbbbbbbbbb", "minio/minio:RELEASE.2025-04-22T22-12-26Z", "running"],
      ["app0cccccccccccccccccccc-170000000000", "ghcr.io/example/app:1", "running"],
    ]);
    // tmpfs mounts are not data and are not listed
    expect(inv.mounts.map((m) => [m.type, m.name, m.source, m.dest])).toEqual([
      ["volume", "pg-data", "/var/lib/docker/volumes/pg-data/_data", "/var/lib/postgresql/data"],
      ["bind", null, "/mnt/data-1/minio", "/data"],
    ]);
    expect(inv.volumes).toEqual([
      { name: "pg-data", mountpoint: "/var/lib/docker/volumes/pg-data/_data", sizeKiB: 2048, links: 1 },
      { name: "orphan-vol", mountpoint: "/var/lib/docker/volumes/orphan-vol/_data", sizeKiB: 12, links: 0 },
    ]);
    expect(inv.binds).toEqual([{ source: "/mnt/data-1/minio", sizeKiB: 4096 }]);
  });

  it("C19: a bind or volume whose size cannot be measured is reported as unknown, never as 0", () => {
    const r = run({ ...base, du: { "/var/lib/docker/volumes/pg-data/_data": 2048 } }); // the orphan volume and the bind fail
    const inv = r.parsed.inventory.get("srv-1")!;
    expect(inv.binds).toEqual([{ source: "/mnt/data-1/minio", sizeKiB: null }]);
    expect(inv.volumes.find((v) => v.name === "orphan-vol")!.sizeKiB).toBeNull();
    expect(inv.volumes.find((v) => v.name === "pg-data")!.sizeKiB).toBe(2048);
    // a genuinely empty directory is a measured 0, which stays distinguishable from unknown
    const z = run({ ...base, du: { ...base.du, "/mnt/data-1/minio": 0 } });
    expect(z.parsed.inventory.get("srv-1")!.binds[0].sizeKiB).toBe(0);
  });

  it("is read-only: only version / ps / inspect / volume ls|inspect and du are called, never a verb that changes the host", () => {
    run(base);
    const verbs = fake!
      .calls()
      .filter((c) => c[0] === "docker")
      .map((c) => (c[1] === "volume" ? `volume ${c[2]}` : c[1]));
    expect(new Set(verbs)).toEqual(new Set(["version", "ps", "inspect", "image", "volume ls", "volume inspect"]));
    for (const c of fake!.calls()) if (c[0] === "docker") expect(["rm", "stop", "kill", "prune", "start", "run", "exec", "pull"]).not.toContain(c[1]);
  });

  it("the migration token is never on an argv: curl gets it as a config on stdin", () => {
    run(base);
    for (const c of fake!.calls()) expect(c.join(" ")).not.toContain(TOKEN);
    expect(fake!.file("curl-stdin.log")).toContain(`Authorization: Bearer ${TOKEN}`);
  });

  it("R8: the reach probe passes the hub's configured part size and reports the largest accepted upload", () => {
    const r = run(base);
    expect(r.parsed.reach).toEqual([expect.objectContaining({ ref: "srv-1", pingCode: 200, hubPartMiB: 128, maxPassedMiB: 128, failedAtMiB: null })]);
    expect(fake!.file("sink.log")!.trim().split("\n")).toEqual([String(128 * 1048576)]); // one upload: the first size passed
  });

  it("R8: behind a body cap the probe steps down and reports the cap, so the operator can pick a part size", () => {
    const r = run({ ...base, hub: { partMiB: 128, capMiB: 100 } });
    expect(r.parsed.reach[0]).toMatchObject({ pingCode: 200, hubPartMiB: 128, maxPassedMiB: 64, failedAtMiB: 128 });
    const r2 = run({ ...base, hub: { partMiB: 128, capMiB: 20 } });
    expect(r2.parsed.reach[0]).toMatchObject({ maxPassedMiB: 0, failedAtMiB: 32 }); // even the minimum part is refused
  });

  it("R8: a hub the host cannot reach is reported (code 000) and does not abort the inventory", () => {
    const r = run({ ...base, hub: { unreachable: true } });
    expect(r.code).toBe(0);
    expect(r.parsed.reach[0]).toMatchObject({ pingCode: 0, hubPartMiB: null, maxPassedMiB: null });
    expect(r.parsed.inventory.get("srv-1")!.complete).toBe(true);
  });

  it("posts the whole report to the hub (stdout and the POST carry the same text) and TUGRA_NO_POST / TUGRA_NO_REACH are honoured", () => {
    const r = run(base);
    expect(fake!.file("posted.txt")).toContain("TUGRA_INV\tend\t");
    expect(r.stderr).toContain("TUGRA_POST\t200");
    const quiet = run(base, { TUGRA_NO_POST: "1", TUGRA_NO_REACH: "1" });
    expect(fake!.file("posted.txt")).toBeNull();
    expect(quiet.parsed.reach).toEqual([]);
    expect(quiet.parsed.inventory.get("srv-1")!.complete).toBe(true);
  });

  it("labels every line with the server ref it was given", () => {
    const r = run(base, {}, "my-srv");
    expect([...r.parsed.inventory.keys()]).toEqual(["my-srv"]);
    expect(r.parsed.reach[0].ref).toBe("my-srv");
  });

  it("fails cleanly, reporting nothing, when the docker daemon is down", () => {
    const r = run({ ...base, dockerDown: true });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("docker ps failed");
    expect(r.parsed.inventory.size).toBe(0);
  });

  it("a path with characters outside the safe charset is dropped by the parser and counted, never trusted", () => {
    const r = run({ ...base, containers: [{ ...base.containers[1], mounts: [{ type: "bind", source: "/mnt/odd path;rm", dest: "/data" }] }] });
    const inv = r.parsed.inventory.get("srv-1")!;
    expect(inv.mounts).toEqual([]);
    expect(inv.rejected).toBeGreaterThan(0);
  });
});

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const SECRET = "S3cr3tPassw0rdValue";

describe("image digests (R11)", () => {
  it("reports the registry digests of the image of every RUNNING container, and none for a stopped one", () => {
    const r = run({
      containers: [
        { id: A, name: "meili0aaaaaaaaaaaaaaaaaaaaa", image: "getmeili/meilisearch:latest", repoDigests: [`getmeili/meilisearch@${D1}`] },
        { id: B, name: "gotenberg-1", image: "gotenberg/gotenberg", repoDigests: [`gotenberg/gotenberg@${D1}`, `ghcr.io/example/gotenberg@${D2}`] },
        { id: C, name: "old-one", image: "nginx:latest", state: "exited", repoDigests: [`nginx@${D2}`] },
      ],
    });
    const inv = r.parsed.inventory.get("srv-1")!;
    expect(inv.complete).toBe(true);
    expect(inv.rejected).toBe(0);
    expect(inv.containers.map((c) => [c.name, c.repoDigests ?? []])).toEqual([
      ["meili0aaaaaaaaaaaaaaaaaaaaa", [`getmeili/meilisearch@${D1}`]],
      ["gotenberg-1", [`gotenberg/gotenberg@${D1}`, `ghcr.io/example/gotenberg@${D2}`]],
      ["old-one", []],
    ]);
  });

  it("a locally built image has no RepoDigests: nothing is reported for it and the inventory is still whole", () => {
    const r = run({ containers: [{ id: A, name: "built-here", image: "app:local" }] });
    expect(r.parsed.inventory.get("srv-1")).toMatchObject({ complete: true, rejected: 0, containers: [expect.objectContaining({ name: "built-here" })] });
    expect(r.parsed.inventory.get("srv-1")!.containers[0].repoDigests).toBeUndefined();
  });

  it("a digest line of a different shape, or for an unknown container, is dropped and counted", () => {
    const text = ["ctr\t" + [A, "x", "postgres:16", "running"].join("\t"), "rdig\t" + [A, "repo@sha256:short"].join("\t"), "rdig\t" + [B, `repo@${D1}`].join("\t"), "end\t3"].map((l) => `TUGRA_AT\tsrv-1\tTUGRA_INV\t${l}`).join("\n");
    const inv = parseReportBody(text).inventory.get("srv-1")!;
    expect(inv.rejected).toBe(2);
    expect(inv.containers[0].repoDigests).toBeUndefined();
  });
});

describe("database facts (R2): non-secret identity, never the password", () => {
  const db = (over: Partial<InventoryHostOptions["containers"][number]> & { image: string }): InventoryHostOptions => ({ containers: [{ id: A, name: "db-x", ...over }] });

  it("reads the user, database and version of a PostgreSQL container and reports that a password exists, without sending it", () => {
    const r = run(db({ image: "postgres:17-alpine", env: ["POSTGRES_USER=appuser", "POSTGRES_DB=appdb", `POSTGRES_PASSWORD=${SECRET}`, "PG_MAJOR=17"] }));
    expect(r.parsed.inventory.get("srv-1")!.containers[0].db).toEqual({ user: "appuser", database: "appdb", cred: "env", version: "17" });
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
    expect(fake!.file("posted.txt")).not.toContain(SECRET);
    for (const c of fake!.calls()) expect(c.join(" ")).not.toContain(SECRET);
  });

  it("PostgreSQL defaults: user postgres, database = user; a *_FILE secret is `file`, no password at all is `none`", () => {
    const file = run(db({ image: "postgres:16", env: ["POSTGRES_PASSWORD_FILE=/run/secrets/pw"] }));
    expect(file.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ user: "postgres", database: "postgres", cred: "file" });
    const none = run(db({ image: "postgres:16", env: [] }));
    expect(none.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ cred: "none" });
  });

  it("MySQL / MariaDB: root first (unless the root password is random), else the app user; the database must be named", () => {
    const root = run(db({ image: "mariadb:11", env: ["MARIADB_ROOT_PASSWORD=x", "MARIADB_DATABASE=shop", "MARIADB_MAJOR=11"] }));
    expect(root.parsed.inventory.get("srv-1")!.containers[0].db).toEqual({ user: "root", database: "shop", cred: "env", version: "11" });
    const app = run(db({ image: "mysql:8.0", env: ["MYSQL_RANDOM_ROOT_PASSWORD=yes", "MYSQL_ROOT_PASSWORD=ignored", "MYSQL_USER=shopper", "MYSQL_PASSWORD=x", "MYSQL_DATABASE=shop", "MYSQL_MAJOR=8.0"] }));
    expect(app.parsed.inventory.get("srv-1")!.containers[0].db).toEqual({ user: "shopper", database: "shop", cred: "env", version: "8.0" });
    const file = run(db({ image: "mysql:8", env: ["MYSQL_ROOT_PASSWORD_FILE=/run/secrets/pw", "MYSQL_DATABASE=shop"] }));
    expect(file.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ cred: "file" });
    const nodb = run(db({ image: "mysql:8", env: ["MYSQL_ROOT_PASSWORD=x"] }));
    expect(nodb.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ database: null, cred: "env" });
  });

  it("Redis family: a password on the server's command line or in the environment is `env`; an ACL user is `acl`; neither is `none`", () => {
    const argv = run(db({ image: "redis:7", path: "redis-server", args: ["--requirepass", SECRET], env: ["REDIS_VERSION=7.2.4"] }));
    expect(argv.parsed.inventory.get("srv-1")!.containers[0].db).toEqual({ user: null, database: null, cred: "env", version: "7.2.4" });
    expect(argv.stdout).not.toContain(SECRET);
    const env = run(db({ image: "eqalpha/keydb:latest", env: [`KEYDB_PASSWORD=${SECRET}`] }));
    expect(env.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ cred: "env" });
    const acl = run(db({ image: "redis:7", env: ["REDIS_USERNAME=app", "REDIS_PASSWORD=x"] }));
    expect(acl.parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ cred: "acl" });
    expect(run(db({ image: "redis:7" })).parsed.inventory.get("srv-1")!.containers[0].db).toMatchObject({ cred: "none" });
  });

  it("a value outside the identifier charset is reported as unknown, and a container that is not a database carries no facts at all", () => {
    const odd = run(db({ image: "postgres:16", env: ["POSTGRES_USER=bad user;x", "POSTGRES_DB=ok_db", "POSTGRES_PASSWORD=x", "PG_MAJOR=sixteen"] }));
    expect(odd.parsed.inventory.get("srv-1")!.containers[0].db).toEqual({ user: null, database: "ok_db", cred: "env", version: null });
    expect(odd.parsed.inventory.get("srv-1")!.rejected).toBe(0);
    const web = run(db({ image: "ghcr.io/example/web:1", env: [`SECRET_KEY=${SECRET}`] }));
    expect(web.parsed.inventory.get("srv-1")!.containers[0].db).toBeUndefined();
    expect(web.stdout).not.toContain(SECRET);
  });
});

describe("migrator.sh --inventory (the real rendered script)", () => {
  const rendered = renderMigratorInstallScript({ image: "ghcr.io/example/agent:1" });
  const runScript = (args: string, env: Record<string, string>) => {
    fake = new InventoryHostFake({ ...base });
    return fake.sh(`sh -c "$SCRIPT" tugra ${args}`, { SCRIPT: rendered, ...env });
  };

  it("runs the inventory instead of the migrator: no docker pull/run, the report is labelled with --server-ref, and the exit code is 0", () => {
    const r = runScript(`--hub ${HUB} --inventory --server-ref srv-9`, { TUGRA_MIGRATION_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    const parsed = parseReportBody(r.stdout);
    expect([...parsed.inventory.keys()]).toEqual(["srv-9"]);
    expect(parsed.inventory.get("srv-9")!.complete).toBe(true);
    for (const c of fake!.calls()) if (c[0] === "docker") expect(["pull", "run", "rm", "stop"]).not.toContain(c[1]);
    for (const c of fake!.calls()) expect(c.join(" ")).not.toContain(TOKEN);
  });

  it("defaults the label to `_` (a single host the operator did not name)", () => {
    const r = runScript(`--hub ${HUB} --inventory`, { TUGRA_MIGRATION_TOKEN: TOKEN });
    expect([...parseReportBody(r.stdout).inventory.keys()]).toEqual(["_"]);
  });

  it("validates its inputs before touching docker: a hostile --server-ref, a missing token and a wrong-shape token", () => {
    const bad = runScript(`--hub ${HUB} --inventory --server-ref 'x; reboot'`, { TUGRA_MIGRATION_TOKEN: TOKEN });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("invalid --server-ref");
    expect(fake!.calls()).toEqual([]);
    const noTok = runScript(`--hub ${HUB} --inventory`, {});
    expect(noTok.code).not.toBe(0);
    expect(noTok.stderr).toContain("TUGRA_MIGRATION_TOKEN is not set");
    const wrong = runScript(`--hub ${HUB} --inventory`, { TUGRA_MIGRATION_TOKEN: "ghp_a_personal_access_token" });
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("malformed migration token");
    expect(wrong.stderr).not.toContain("ghp_a_personal");
  });

  it("without --inventory nothing of the inventory runs (the migrator path is untouched: it fails on the missing socket exactly as before)", () => {
    const r = runScript(`--hub ${HUB}`, { TUGRA_MIGRATION_TOKEN: TOKEN });
    expect(r.stdout).not.toContain("TUGRA_INV");
    expect(fake!.calls().filter((c) => c[0] === "docker" && c[1] === "volume")).toEqual([]);
  });
});
