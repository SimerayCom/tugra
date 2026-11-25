import { posix } from "node:path";
import { assertSafeDockerOptions } from "../deploy/docker-options-safety";
import { tokenizeDockerOptions } from "../deploy/deploy-script";
import type { Pm2Fact, Pm2FactsUser } from "./pm2-facts";
import { hashPlan, mountDirProblem, nodeMajorFromEngines, nodeMajorFromNvmrc, nodeMajorFromPath, planAll, planProcess, type ScanSiteLite } from "./pm2-plan";

const DIGEST = "a".repeat(64);
const CWD = "/home/acme/htdocs/app.example.com";

function fact(over: Partial<Pm2Fact> = {}): Pm2Fact {
  return {
    name: "app",
    nameExact: true,
    status: "online",
    script: `${CWD}/server.js`,
    cwd: CWD,
    interpreter: "/home/acme/.nvm/versions/node/v20.11.1/bin/node",
    mode: "fork",
    instances: 1,
    argsOverflow: false,
    args: [],
    nodeArgs: [],
    interpreterArgs: [],
    port: 3000,
    envCount: 4,
    envSkipped: 20,
    envDigest: DIGEST,
    nvmrc: "",
    enginesNode: "",
    cwdExists: true,
    scriptExists: true,
    cwdUid: 1001,
    cwdGid: 1001,
    ...over,
  };
}
const USER: Pm2FactsUser = { user: "acme", home: "/home/acme", uid: 1001, gid: 1001, daemon: true, procs: [] };
const plan = (over: Partial<Pm2Fact> = {}, ctx: { sites?: ScanSiteLite[]; override?: Parameters<typeof planProcess>[2]["override"]; user?: Pm2FactsUser } = {}) =>
  planProcess(ctx.user ?? USER, fact(over), { sites: ctx.sites ?? [], override: ctx.override });

describe("node version resolution", () => {
  it("reads the major from the interpreter path (nvm, n, volta, tarball)", () => {
    expect(nodeMajorFromPath("/home/u/.nvm/versions/node/v20.11.1/bin/node")).toBe(20);
    expect(nodeMajorFromPath("/usr/local/n/versions/node/18.19.0/bin/node")).toBe(18);
    expect(nodeMajorFromPath("/home/u/.volta/tools/image/node/22.3.0/bin/node")).toBe(22);
    expect(nodeMajorFromPath("/opt/node-v16.20.2-linux-x64/bin/node")).toBe(16);
    expect(nodeMajorFromPath("/usr/bin/node")).toBeNull();
    expect(nodeMajorFromPath("/home/u/app-1.2.3/bin/node")).toBeNull(); // 1 is not a node major
  });
  it(".nvmrc: numbers, v-prefix, lts codenames; floating aliases name nothing", () => {
    expect(nodeMajorFromNvmrc("v20")).toBe(20);
    expect(nodeMajorFromNvmrc("18.17.1")).toBe(18);
    expect(nodeMajorFromNvmrc("lts/iron")).toBe(20);
    expect(nodeMajorFromNvmrc("lts/*")).toBeNull();
    expect(nodeMajorFromNvmrc("node")).toBeNull();
    expect(nodeMajorFromNvmrc("")).toBeNull();
  });
  it("engines.node: pins, ranges, alternatives; anything it cannot read is unknown", () => {
    expect(nodeMajorFromEngines("20.x")).toBe(20);
    expect(nodeMajorFromEngines("^20.1.0")).toBe(20);
    expect(nodeMajorFromEngines(">=18")).toBe(18);
    expect(nodeMajorFromEngines(">=18 <23")).toBe(18);
    expect(nodeMajorFromEngines(">=20.0.0 <21")).toBe(20);
    expect(nodeMajorFromEngines("^20 || ^22")).toBe(20);
    expect(nodeMajorFromEngines("16")).toBe(16); // a pin outside the candidate lines is honoured
    expect(nodeMajorFromEngines("*")).toBeNull();
    expect(nodeMajorFromEngines("")).toBeNull();
    expect(nodeMajorFromEngines("lts")).toBeNull();
  });
  it("precedence: interpreter path > .nvmrc > engines; an override beats all; none -> needs-node", () => {
    expect(plan({ nvmrc: "v18", enginesNode: "^22" }).plan.nodeSource).toBe("interpreter");
    const p = plan({ interpreter: "node", nvmrc: "v18", enginesNode: "^22" }).plan;
    expect([p.nodeMajor, p.nodeSource]).toEqual([18, "nvmrc"]);
    const e = plan({ interpreter: "node", enginesNode: "^22" }).plan;
    expect([e.nodeMajor, e.nodeSource]).toEqual([22, "engines"]);
    const o = plan({ interpreter: "node", nvmrc: "v18" }, { override: { nodeMajor: 24 } }).plan;
    expect([o.nodeMajor, o.nodeSource, o.image]).toEqual([24, "override", "node:24"]);
    const none = plan({ interpreter: "node" }).plan;
    expect(none.status).toBe("needs-node");
    expect(none.nodeMajor).toBeNull();
    expect(plan({ interpreter: "node" }).exec).toBeNull();
  });
});

describe("planProcess: a supported process", () => {
  it("fork mode, node from the interpreter path: exact in-place spec", () => {
    const { plan: p, exec } = plan({ args: ["--port", "3000"], nodeArgs: ["--max-old-space-size=512"] });
    expect(p.status).toBe("ready");
    expect(p.reasons).toEqual([]);
    expect(p.image).toBe("node:20");
    expect(p.command).toEqual(["node", "--max-old-space-size=512", `${CWD}/server.js`, "--port", "3000"]);
    expect(p.workDir).toBe(CWD);
    expect(p.mountDir).toBe(CWD);
    expect([p.uid, p.gid]).toEqual([1001, 1001]);
    expect(p.port).toBe(3000);
    expect(p.portSource).toBe("env");
    expect(exec?.dockerOptions).toBe(`--network host -u 1001:1001 -w ${CWD} -v ${CWD}:${CWD}`);
    expect(exec?.interpreterDir).toBe("/home/acme/.nvm/versions/node/v20.11.1/bin");
    expect(exec?.userUid).toBe(1001);
  });
  it("the generated docker options pass the owner-override gate, are refused without it, and tokenize exactly", () => {
    const o = plan().exec!.dockerOptions;
    expect(() => assertSafeDockerOptions(o, { allowPrivileged: true })).not.toThrow();
    expect(() => assertSafeDockerOptions(o)).toThrow(); // --network host and the host bind need the owner's grant
    expect(tokenizeDockerOptions(o)).toEqual(["--network", "host", "-u", "1001:1001", "-w", CWD, "-v", `${CWD}:${CWD}`]);
  });
  it("the plan view never carries an environment value, only the count", () => {
    const json = JSON.stringify(plan({ envCount: 4 }).plan);
    expect(json).toContain('"envCount":4');
    expect(json).not.toMatch(/"env":/);
  });
  it("missing env is fine (count 0)", () => {
    const p = plan({ envCount: 0, port: undefined }).plan;
    expect(p.status).toBe("ready");
    expect(p.envCount).toBe(0);
  });
  it("npm / yarn start run through the tool, the script path is the tool, not a file in the directory", () => {
    const p = plan({ script: "/usr/bin/npm", interpreter: "none", args: ["start"], nvmrc: "v20", scriptExists: true }).plan;
    expect(p.status).toBe("ready");
    expect(p.command).toEqual(["npm", "start"]);
    expect(plan({ script: "/home/acme/.nvm/versions/node/v20.1.0/bin/yarn", interpreter: "none", args: ["start"], nvmrc: "20" }).plan.command).toEqual(["yarn", "start"]);
  });
  it("an interpreter of 'none' on a .js file is node", () => {
    expect(plan({ interpreter: "none", nvmrc: "v20" }).plan.command[0]).toBe("node");
  });
  it("an explicit uid/gid on the process wins over the account's", () => {
    const { plan: p, exec } = plan({ uid: 1500, gid: 1600 });
    expect([p.uid, p.gid]).toEqual([1500, 1600]);
    expect(exec?.dockerOptions).toContain("-u 1500:1600");
    expect(p.warnings).toContain("owner-differs"); // the directory belongs to 1001
  });
  it("root is allowed but flagged; an EOL node is flagged", () => {
    const root: Pm2FactsUser = { user: "root", home: "/root", uid: 0, gid: 0, daemon: true, procs: [] };
    const p = planProcess(root, fact({ cwd: "/root/app", script: "/root/app/a.js", cwdUid: 0, interpreter: "/root/.nvm/versions/node/v16.20.2/bin/node" }), { sites: [] }).plan;
    expect(p.status).toBe("ready");
    expect(p.warnings).toEqual(expect.arrayContaining(["root", "node-eol"]));
  });
  it("cluster mode with ONE instance runs as a single fork-like process, with a note", () => {
    const p = plan({ mode: "cluster", instances: 1 }).plan;
    expect(p.status).toBe("ready");
    expect(p.warnings).toContain("cluster-single");
  });
});

describe("planProcess: what is refused, and why", () => {
  const reasons = (over: Partial<Pm2Fact>) => plan(over).plan.reasons;
  it("not running", () => expect(reasons({ status: "stopped" })).toContain("not-running"));
  it("cluster mode with several instances", () => {
    expect(reasons({ mode: "cluster", instances: 4 })).toContain("cluster-instances");
    expect(plan({ mode: "cluster", instances: 4 }).plan.status).toBe("unsupported");
  });
  it("a duplicate fork name is ambiguous", () => expect(reasons({ mode: "fork", instances: 2 })).toContain("duplicate-name"));
  it.each([["python3"], ["/usr/bin/python3"], ["bash"], ["php"], ["ruby"], ["bun"], ["ts-node"], ["deno"]])("non-node interpreter %s is unsupported and named", (interp) => {
    const p = plan({ interpreter: interp, script: `${CWD}/worker.py` }).plan;
    expect(p.status).toBe("unsupported");
    expect(p.reasons).toContain("interpreter");
    expect(p.interpreter).toBe(posix.basename(interp));
    expect(p.command).toEqual([]);
  });
  it("a binary / shell script / ts file started with 'none' is not a node process", () => {
    expect(reasons({ interpreter: "none", script: `${CWD}/run.sh` })).toContain("script-kind");
    expect(reasons({ interpreter: "none", script: `${CWD}/bin/server` })).toContain("script-kind");
    expect(reasons({ interpreter: "node", script: `${CWD}/main.ts` })).toContain("script-kind");
    expect(reasons({ interpreter: "none", script: "/usr/bin/pnpm", args: ["start"] })).toContain("script-kind");
  });
  it("name hazards: numeric, 'all', 'default', leading dash, control chars in the saved name", () => {
    for (const n of ["123", "all", "ALL", "default", "-x", " lead", "a  b"]) expect(reasons({ name: n })).toContain("name-unsafe");
    expect(reasons({ nameExact: false })).toContain("name-unsafe");
    expect(reasons({ name: "My App-1.2" })).not.toContain("name-unsafe");
  });
  it("directory hazards", () => {
    expect(reasons({ cwd: "" })).toContain("no-cwd");
    expect(reasons({ cwd: "relative/dir" })).toContain("no-cwd");
    expect(reasons({ cwdExists: false })).toContain("cwd-missing");
    for (const c of ["/", "/home", "/root", "/home/acme", "/etc", "/etc/tugra", "/var", "/var/lib/docker/x", "/var/run/x", "/home/acme/.ssh", "/home/acme/.pm2/x", "/proc/1", "/x", "/home/acme/a b", "/home/acme/a:b", "/home/acme/../root/x", "/home/acme//x/", "/home/acme/x/"]) {
      expect([c, reasons({ cwd: c, script: `${c}/a.js` }).includes("cwd-unsafe")]).toEqual([c, true]);
    }
  });
  it("a mount that would contain the PM2 home (and every other process's environment) is refused", () => {
    expect(mountDirProblem("/home/acme", "/home/acme")).toBe("cwd-unsafe");
    expect(mountDirProblem("/srv/apps", "/srv/apps/home")).toBe("cwd-unsafe");
    expect(mountDirProblem("/srv/apps/one", "/home/acme")).toBeNull();
    expect(mountDirProblem("/var/www/app", "/home/acme")).toBeNull();
    expect(mountDirProblem("/opt/app", "/home/acme")).toBeNull();
  });
  it("the script must be a file inside the mounted directory", () => {
    expect(reasons({ script: "/home/acme/other/server.js" })).toContain("script-outside");
    expect(reasons({ script: "server.js" })).toContain("script-outside");
    expect(reasons({ script: `${CWD}/missing.js`, scriptExists: false })).toContain("script-missing");
  });
  it("arguments with control characters, or a cut list, are refused (never guessed)", () => {
    expect(reasons({ args: ["a\nb"] })).toContain("args-unsafe");
    expect(reasons({ argsOverflow: true })).toContain("args-unsafe");
    expect(reasons({ script: "/usr/bin/npm", interpreter: "none", args: ["start"], nodeArgs: ["--inspect"], nvmrc: "20" })).toContain("args-unsafe");
  });
  it("several reasons are all reported", () => {
    const r = reasons({ status: "stopped", interpreter: "python3", cwd: "" });
    expect(r).toEqual(expect.arrayContaining(["not-running", "interpreter", "no-cwd"]));
  });
});

describe("port and domains", () => {
  const sites: ScanSiteLite[] = [
    { names: ["app.example.com"], root: CWD, kind: "proxy", port: 4100, siteUser: "acme" },
    { names: ["other.example.com"], root: "/home/acme/htdocs/other.example.com", kind: "proxy", port: 4200, siteUser: "acme" },
    { names: ["php.example.com"], root: "/home/acme/htdocs/php.example.com", kind: "php", siteUser: "acme" },
  ];
  it("the saved PORT wins; the CloudPanel vhost of the directory names the domains", () => {
    const p = plan({ port: 4100 }, { sites }).plan;
    expect([p.port, p.portSource, p.domains]).toEqual([4100, "env", ["app.example.com"]]);
  });
  it("no PORT: the proxy port of the site whose root holds the directory", () => {
    const p = plan({ port: undefined }, { sites }).plan;
    expect([p.port, p.portSource, p.domains]).toEqual([4100, "site", ["app.example.com"]]);
  });
  it("no PORT and no unique site: unknown port, a warning, a plain 'keeps running' check", () => {
    const p = plan({ port: undefined, cwd: "/home/acme/htdocs/unknown", script: "/home/acme/htdocs/unknown/a.js" }, { sites }).plan;
    expect([p.port, p.portSource]).toEqual([null, "none"]);
    expect(p.warnings).toContain("no-port");
    expect(plan({ port: undefined, cwd: "/home/acme/htdocs/unknown", script: "/home/acme/htdocs/unknown/a.js" }, { sites }).exec?.healthPort).toBeNull();
  });
  it("a probe path is kept only with a port, and only when well-formed", () => {
    expect(plan({}, { override: { probePath: "/health" } }).plan.probePath).toBe("/health");
    expect(plan({ port: undefined }, { override: { probePath: "/health" } }).plan.probePath).toBeNull();
    for (const bad of ["health", "/a?b=1", "/a b", "/$(x)", "/a;b", "//x\n"]) expect(plan({}, { override: { probePath: bad } }).plan.probePath).toBeNull();
  });
});

describe("planHash", () => {
  it("is stable, and changes with the environment digest, the command, the port, the uid and the node major", () => {
    const base = plan().plan.planHash;
    expect(plan().plan.planHash).toBe(base);
    expect(plan({ envDigest: "b".repeat(64) }).plan.planHash).not.toBe(base);
    expect(plan({ args: ["--x"] }).plan.planHash).not.toBe(base);
    expect(plan({ port: 3001 }).plan.planHash).not.toBe(base);
    expect(plan({ uid: 5, gid: 5 }).plan.planHash).not.toBe(base);
    expect(plan({}, { override: { nodeMajor: 22 } }).plan.planHash).not.toBe(base);
    expect(hashPlan(plan().plan, DIGEST)).toBe(base);
  });
});

describe("planAll", () => {
  it("plans every process of every home and applies per-process overrides by user/name", () => {
    const users: Pm2FactsUser[] = [
      { ...USER, procs: [fact({ name: "a" }), fact({ name: "b", interpreter: "node" })] },
      { user: "other", home: "/home/other", uid: 1002, gid: 1002, daemon: true, procs: [fact({ name: "a", cwd: "/home/other/x", script: "/home/other/x/s.js", cwdUid: 1002 })] },
    ];
    const out = planAll(users, [], { "acme/b": { nodeMajor: 22 } });
    expect(out.map((p) => [p.plan.key, p.plan.status])).toEqual([
      ["acme/a", "ready"],
      ["acme/b", "ready"],
      ["other/a", "ready"],
    ]);
    expect(out[1].plan.image).toBe("node:22");
  });
});
