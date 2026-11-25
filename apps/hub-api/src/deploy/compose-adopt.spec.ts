import { execFileSync } from "node:child_process";
import {
  ComposeAdoptSchema,
  adoptMountDirs,
  adoptPathProblem,
  adoptedComposeCmd,
  buildAdoptReadScript,
  foreignProjectDir,
  parseAdoptRead,
  parseComposeAdopt,
  type ComposeAdopt,
} from "./compose-adopt";
import { buildComposeDownScript, buildComposeRestartScript, buildComposeStopScript, buildComposeStartScript, buildComposeUpScript, buildContainersScript, buildLogsScript, composeProject } from "./compose-script";
import type { AppSpec } from "./deploy-script";

const SHA = "a".repeat(64);
const adopt = (over: Partial<ComposeAdopt> = {}): ComposeAdopt => ({
  v: 1,
  project: "shop",
  workingDir: "/srv/shop",
  files: [{ path: "/srv/shop/docker-compose.yml", sha256: SHA, bytes: 120 }, { path: "/srv/shop/compose.prod.yml", sha256: SHA, bytes: 40 }],
  services: [{ name: "web", image: "node:22", ports: [8080], volumes: [] }],
  adoptedAt: "2026-12-05T10:00:00.000Z",
  ...over,
});
const spec = (a: ComposeAdopt | null = adopt()): AppSpec => ({ id: "cl123", source: "COMPOSE", composeAdopt: a ?? undefined, env: { SECRET: "x" }, hostPort: null, containerPort: 80 });

describe("adoptPathProblem", () => {
  it("accepts ordinary project locations", () => {
    for (const p of ["/srv/shop", "/home/ubuntu/apps/shop", "/opt/stacks/my-app_2", "/root/shop", "/var/www/shop/docker-compose.yml"]) expect(adoptPathProblem(p)).toBeNull();
  });
  it("rejects shell syntax, traversal and relative paths", () => {
    for (const p of ["/srv/my shop", "/srv/a;b", "/srv/$(x)", "/srv/`x`", "/srv/a'b", "/srv/../etc", "/srv/./x", "srv/shop", "/srv//shop", "", "/srv/sh*p"]) expect(adoptPathProblem(p)).toBe("syntax");
  });
  it("rejects a whole top-level tree and the root", () => {
    expect(adoptPathProblem("/opt")).toBe("too_shallow");
    expect(adoptPathProblem("/")).not.toBeNull();
  });
  it("denies system roots and Tugra's own state", () => {
    for (const p of ["/proc/1", "/sys/fs", "/dev/shm", "/var/lib/docker/volumes", "/etc/tugra/compose", "/usr/local/x", "/run/user", "/var/run/docker"]) expect(adoptPathProblem(p)).toBe("denied");
  });
  it("knows other platforms' trees", () => {
    expect(foreignProjectDir("/data/coolify/applications/abc")).toBe("coolify");
    expect(foreignProjectDir("/etc/dokploy/compose/x/code")).toBe("dokploy");
    expect(foreignProjectDir("/srv/shop")).toBeNull();
  });
});

describe("parseComposeAdopt", () => {
  it("returns null for anything that is not a strictly valid registration (fail closed to 'not adopted')", () => {
    expect(parseComposeAdopt(null)).toBeNull();
    expect(parseComposeAdopt("x")).toBeNull();
    expect(parseComposeAdopt({ ...adopt(), project: "Bad Name" })).toBeNull();
    expect(parseComposeAdopt({ ...adopt(), workingDir: "/srv/a b" })).toBeNull();
    expect(parseComposeAdopt({ ...adopt(), files: [] })).toBeNull();
    expect(parseComposeAdopt({ ...adopt(), files: [{ path: "/etc/tugra/x.yml", sha256: SHA, bytes: 1 }] })).toBeNull();
    expect(parseComposeAdopt(adopt())).toEqual(adopt());
  });
});

describe("the adopted compose command", () => {
  it("runs compose in a helper of the agent's own image with read-only mounts and no recreate-prone extras", () => {
    const cmd = adoptedComposeCmd(adopt(), "up -d");
    expect(cmd).toContain("docker run --rm --pull never");
    expect(cmd).toContain('--entrypoint docker "$IMG" compose');
    expect(cmd).toContain("--project-directory '/srv/shop' -p 'shop' -f '/srv/shop/docker-compose.yml' -f '/srv/shop/compose.prod.yml' up -d");
    expect(cmd).toContain("-v '/srv/shop:/srv/shop:ro'");
    expect(cmd).toContain("-v /var/run/docker.sock:/var/run/docker.sock");
    expect(cmd).toContain("--cap-drop ALL");
    expect(cmd).not.toMatch(/--privileged|--pid|--network host/);
    expect(adoptMountDirs(adopt())).toEqual(["/srv/shop"]);
  });
  it("mounts a config file's directory when it sits elsewhere", () => {
    const a = adopt({ files: [{ path: "/srv/shop/compose.yml", sha256: SHA, bytes: 1 }, { path: "/srv/shared/base.yml", sha256: SHA, bytes: 1 }] });
    expect(adoptMountDirs(a)).toEqual(["/srv/shop", "/srv/shared"]);
  });
  it("is valid shell and quotes every path (bash -n)", () => {
    const scripts = [buildComposeUpScript(spec()), buildComposeUpScript(spec(), true), buildComposeStopScript(spec()), buildComposeStartScript(spec()), buildComposeRestartScript(spec()), buildComposeDownScript(spec()), buildLogsScript(spec(), 50), buildAdoptReadScript(adopt())];
    for (const s of scripts) expect(() => execFileSync("bash", ["-n"], { input: s })).not.toThrow();
  });
});

describe("deploy and lifecycle scripts of an adopted app", () => {
  it("deploy uses the project's own name and files, writes nothing, ignores Tugra env and never removes orphans", () => {
    const up = buildComposeUpScript(spec());
    expect(up).toContain("-p 'shop'");
    expect(up).toContain("-f '/srv/shop/docker-compose.yml'");
    expect(up).toContain("up -d");
    expect(up).not.toMatch(/remove-orphans|base64|\.env|--env-file|tugra_cl123|printf|rm -rf|\/etc\/tugra\/compose/);
    expect(up).not.toContain("SECRET");
    expect(buildComposeUpScript(spec(), true)).toContain("up -d --pull always");
  });
  it("down removes the containers only: never volumes, never the directory", () => {
    const down = buildComposeDownScript(spec(), { volumes: true });
    expect(down).toContain(" down");
    expect(down).not.toMatch(/ down -v|rm -rf/);
  });
  it("stop / start / restart / logs target the same project and files", () => {
    for (const [s, sub] of [[buildComposeStopScript(spec()), "stop"], [buildComposeStartScript(spec()), "start"], [buildComposeRestartScript(spec()), "restart"], [buildLogsScript(spec(), 99), "logs --no-color --tail 99 2>&1"]] as const) {
      expect(s).toContain(`-p 'shop' -f '/srv/shop/docker-compose.yml' -f '/srv/shop/compose.prod.yml' ${sub}`);
    }
  });
  it("the project name replaces tugra_<id> for container lookups, but only when adopted", () => {
    expect(composeProject({ id: "cl123", composeAdopt: adopt() })).toBe("shop");
    expect(composeProject({ id: "cl123" })).toBe("tugra_cl123");
    expect(composeProject({ id: "cl123", composeAdopt: { project: "evil name" } })).toBe("tugra_cl123");
    expect(buildContainersScript(spec())).toContain("label=com.docker.compose.project=shop");
  });
  it("a Tugra-owned compose app is byte-identical to before (no helper, tugra_<id> project)", () => {
    const own = buildComposeUpScript({ id: "cl123", source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n", env: {}, hostPort: null, containerPort: 80 });
    expect(own).toContain("-p tugra_cl123");
    expect(own).not.toContain("tugra.role=compose-helper");
  });
});

describe("reading the files on the host", () => {
  it("is read-only, network-less, capability-stripped and passes paths as arguments, not code", () => {
    const s = buildAdoptReadScript(adopt());
    expect(s).toContain("--network none");
    expect(s).toContain("--cap-drop ALL");
    expect(s).toContain(":ro'");
    expect(s).not.toMatch(/--privileged|docker\.sock/);
    expect(s).toMatch(/sh '\/srv\/shop\/docker-compose.yml' '\/srv\/shop\/compose.prod.yml'$/);
  });
  it("parses fingerprints and small contents, index-aligned; a missing file is not ok", () => {
    const yml = "services:\n  web:\n    image: nginx\n";
    const out = [
      `TUGRA_ADOPT_FILE 1 ok ${yml.length} ${"b".repeat(64)}`,
      "TUGRA_ADOPT_CONTENT_BEGIN",
      Buffer.from(yml).toString("base64"),
      "TUGRA_ADOPT_CONTENT_END",
      "TUGRA_ADOPT_FILE 2 missing 0 -",
    ].join("\n");
    const r = parseAdoptRead(out, 2);
    expect(r[0]).toMatchObject({ ok: true, bytes: yml.length, sha256: "b".repeat(64), content: yml });
    expect(r[1]).toMatchObject({ ok: false, content: null });
  });
  it("ignores malformed or out-of-range lines and non-base64 content", () => {
    const out = ["TUGRA_ADOPT_FILE 9 ok 1 " + "c".repeat(64), "TUGRA_ADOPT_FILE 1 ok 5 zz", "TUGRA_ADOPT_FILE 1 ok 5 " + "d".repeat(64), "TUGRA_ADOPT_CONTENT_BEGIN", "not base64 !!", "TUGRA_ADOPT_CONTENT_END"].join("\n");
    const r = parseAdoptRead(out, 1);
    expect(r[0]).toMatchObject({ ok: true, content: null });
  });
});

describe("schema", () => {
  it("caps services, files and volumes", () => {
    expect(ComposeAdoptSchema.safeParse({ ...adopt(), services: Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, image: "x", ports: [], volumes: [] })) }).success).toBe(false);
    expect(ComposeAdoptSchema.safeParse({ ...adopt(), files: Array.from({ length: 9 }, () => ({ path: "/srv/shop/a.yml", sha256: SHA, bytes: 1 })) }).success).toBe(false);
  });
});
