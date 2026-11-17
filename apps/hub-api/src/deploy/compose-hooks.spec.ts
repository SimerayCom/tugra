import { BadRequestException } from "@nestjs/common";
import { buildComposeUpScript } from "./compose-script";
import { buildComposeGitUpScript } from "./compose-git";
import { composeHookContainerName, composeHookPlan, composeHookPostSteps, composeHookPreSteps } from "./compose-hooks";
import type { AppSpec } from "./deploy-script";

// every member states its own restart policy, so no default-restart override is layered into these byte-exact scripts
const YAML = "services:\n  web:\n    image: nginx\n    restart: always\n  api:\n    image: app:1\n    restart: always\n  worker:\n    build: ./w\n    image: w:1\n    restart: always\n";
const base: AppSpec = { id: "abc", source: "COMPOSE", composeFile: YAML, env: {}, hostPort: null, containerPort: null };
const hooked: AppSpec = { ...base, composeHookService: "api", preDeployCommand: "npm run migrate", postDeployCommand: "npm run warm" };

const gitBase: AppSpec = {
  id: "abc",
  source: "COMPOSE",
  composePath: "docker-compose.yml",
  gitUrl: "https://github.com/u/r.git",
  gitBranch: "main",
  env: {},
  hostPort: null,
  containerPort: null,
};
const SHA = "a".repeat(64);
const idx = (lines: string[], needle: string | RegExp) =>
  lines.findIndex((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

describe("composeHookPlan", () => {
  it("is null when neither command is set (blank counts as unset)", () => {
    expect(composeHookPlan(base, YAML)).toBeNull();
    expect(composeHookPlan({ ...base, composeHookService: "web", preDeployCommand: "  ", postDeployCommand: null }, YAML)).toBeNull();
  });

  it("throws a 400 when the service is missing or not a service of the compose", () => {
    expect(() => composeHookPlan({ ...base, preDeployCommand: "x" }, YAML)).toThrow(BadRequestException);
    expect(() => composeHookPlan({ ...base, composeHookService: "nope", preDeployCommand: "x" }, YAML)).toThrow(/"nope" is not in the compose file \(services: web, api, worker\)/);
    expect(() => composeHookPlan({ ...base, composeHookService: "web", postDeployCommand: "x" }, "not: [valid")).toThrow(BadRequestException);
    expect(() => composeHookPlan({ ...base, composeHookService: "__proto__", postDeployCommand: "x" }, YAML)).toThrow(BadRequestException);
  });

  it("prepare is build iff the service has a build: key", () => {
    expect(composeHookPlan({ ...hooked, composeHookService: "api" }, YAML)!.prepare).toBe("pull");
    expect(composeHookPlan({ ...hooked, composeHookService: "worker" }, YAML)!.prepare).toBe("build");
    expect(composeHookPlan({ ...hooked, composeHookService: "api" }, YAML)).toEqual({ service: "api", pre: "npm run migrate", post: "npm run warm", prepare: "pull" });
  });
});

describe("pasted compose up script with hooks", () => {
  const s = buildComposeUpScript(hooked);
  const lines = s.split("\n");
  const FILE = "/etc/tugra/compose/abc/docker-compose.yml";

  it("orders: pre-hook (pull, rm, run) BEFORE up; logout and ps, then the post-hook", () => {
    const run = idx(lines, "run --rm");
    const up = idx(lines, " up -d ");
    expect(idx(lines, 'echo "TUGRA_PREDEPLOY: running"')).toBeLessThan(idx(lines, "pull --quiet"));
    expect(idx(lines, "pull --quiet")).toBeLessThan(idx(lines, "docker rm -f tugra_abc_hook"));
    expect(idx(lines, "docker rm -f tugra_abc_hook")).toBeLessThan(run);
    expect(run).toBeLessThan(up);
    expect(up).toBeLessThan(idx(lines, / ps$/));
    expect(idx(lines, / ps$/)).toBeLessThan(idx(lines, 'echo "TUGRA_POSTDEPLOY: running"'));
    expect(idx(lines, 'echo "TUGRA_POSTDEPLOY: running"')).toBeLessThan(idx(lines, " exec -T "));
  });

  it("has the exact pre-hook fragment", () => {
    expect(lines).toContain(`docker compose --progress plain -p tugra_abc -f ${FILE} pull --quiet 'api'`);
    expect(lines).toContain("docker rm -f tugra_abc_hook >/dev/null 2>&1 || true");
    expect(lines).toContain(
      `if docker compose -p tugra_abc -f ${FILE} run --rm -T -l traefik.enable=false --name tugra_abc_hook --entrypoint sh 'api' -c 'npm run migrate'; then echo "TUGRA_PREDEPLOY: ok"; else echo "TUGRA_PREDEPLOY: failed"; exit 1; fi`,
    );
  });

  it("the one-off container is never routable: -l traefik.enable=false on run, nothing on the post-hook exec", () => {
    const run = lines.find((l) => l.includes(" run --rm"))!;
    expect(run).toContain(" run --rm -T -l traefik.enable=false --name tugra_abc_hook ");
    const exec = lines.find((l) => l.includes(" exec -T "))!;
    expect(exec).not.toContain("traefik.enable");
    expect(exec).toContain("exec -T 'api' sh -c 'npm run warm'");
  });

  it("run omits --no-deps (a migration must reach its database) and the failure branch is exit 1, never 3", () => {
    const run = lines.find((l) => l.includes(" run --rm"))!;
    expect(run).not.toContain("--no-deps");
    expect(run).toContain("exit 1; fi");
    expect(s).not.toContain("exit 3");
  });

  it("has the exact post-hook fragment and it never fails the deploy", () => {
    const i = lines.indexOf('echo "TUGRA_POSTDEPLOY: running"');
    expect(lines.slice(i)).toEqual([
      'echo "TUGRA_POSTDEPLOY: running"',
      "TUGRA_CID=; TUGRA_I=0",
      "while [ $TUGRA_I -lt 30 ]; do",
      `  TUGRA_CID=$(docker compose -p tugra_abc -f ${FILE} ps -q 'api' 2>/dev/null | head -n1)`,
      `  if [ -n "$TUGRA_CID" ]; then TUGRA_ST=$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$TUGRA_CID" 2>/dev/null || true); case "$TUGRA_ST" in "true healthy"|"true ") break;; esac; fi`,
      "  TUGRA_CID=; TUGRA_I=$((TUGRA_I+1)); sleep 2",
      "done",
      `if [ -n "$TUGRA_CID" ]; then docker compose -p tugra_abc -f ${FILE} exec -T 'api' sh -c 'npm run warm' && echo "TUGRA_POSTDEPLOY: ok" || echo "TUGRA_POSTDEPLOY: failed (ignored)"; else echo "TUGRA_POSTDEPLOY: failed (service not ready, ignored)"; fi`,
    ]);
    expect(lines[lines.length - 1]).not.toMatch(/exit/);
  });

  it("with only a post hook there is no pre-hook step (and vice versa)", () => {
    const post = buildComposeUpScript({ ...hooked, preDeployCommand: null });
    expect(post).not.toContain("TUGRA_PREDEPLOY");
    expect(post).not.toContain("run --rm");
    expect(post).toContain("TUGRA_POSTDEPLOY: running");
    const pre = buildComposeUpScript({ ...hooked, postDeployCommand: null });
    expect(pre).toContain("TUGRA_PREDEPLOY: running");
    expect(pre).not.toContain("TUGRA_POSTDEPLOY");
  });

  it("the registry login precedes the pre-hook (private images pull); the logout follows up", () => {
    const withReg = buildComposeUpScript({ ...hooked, registryAuth: { url: "ghcr.io", user: "bot", token: "t" } }).split("\n");
    expect(idx(withReg, "login")).toBeLessThan(idx(withReg, "pull --quiet"));
    expect(idx(withReg, " up -d ")).toBeLessThan(idx(withReg, "logout"));
  });

  it("shq()s the command (a quote cannot break out) and the service", () => {
    const s2 = buildComposeUpScript({ ...hooked, preDeployCommand: "echo 'a'; rm -rf /", postDeployCommand: "x'y" });
    expect(s2).toContain(`-c 'echo '\\''a'\\''; rm -rf /'; then`);
    expect(s2).toContain(`sh -c 'x'\\''y' &&`);
  });

  it("build-prepared services run `compose build [--no-cache]` instead of pull", () => {
    const w = { ...hooked, composeHookService: "worker" };
    const a = buildComposeUpScript(w);
    expect(a).toContain(`docker compose --progress plain -p tugra_abc -f ${FILE} build 'worker'`);
    expect(a).not.toContain("pull --quiet");
    expect(buildComposeUpScript(w, true)).toContain(`${FILE} build --no-cache 'worker'`);
  });

  it("every compose call in the hook steps carries the same prefix, override file and env-file as up (multiline variable)", () => {
    const e: AppSpec = {
      ...hooked,
      env: { PLAIN: "p", PEM_KEY: "l1\nl2\n" },
      envMeta: { PEM_KEY: { multiline: true } },
      domain: "x.example.com",
      composeWebService: "web",
    };
    const t = buildComposeUpScript(e);
    // (the pre-existing trailing `ps` line of `up` does not carry --env-file; only the hook calls and `up` are asserted)
    const calls = t.split("\n").filter((l) => /docker compose/.test(l) && !/ ps$/.test(l));
    const pre = 'env PEM_KEY="$TUGRA_ML_0" docker compose';
    expect(calls.length).toBe(5); // pull, run, up, ps -q, exec
    for (const l of calls) {
      expect(l).toContain(pre);
      expect(l).toContain("-f /etc/tugra/compose/abc/docker-compose.tugra.yml");
      expect(l).toContain("--env-file /etc/tugra/compose/abc/.env");
    }
    for (const sub of [" pull --quiet", " run --rm", " ps -q", " exec -T", " up -d"]) expect(t).toContain(sub);
  });

  it("the script-size preflight trips on a huge hook command", () => {
    expect(() => buildComposeUpScript({ ...hooked, preDeployCommand: "x".repeat(130_000) })).toThrow();
  });

  it("an unset hook is byte-identical to the legacy script (also blank commands)", () => {
    const plain = buildComposeUpScript(base);
    expect(buildComposeUpScript({ ...base, composeHookService: "api" })).toBe(plain);
    expect(buildComposeUpScript({ ...base, composeHookService: "api", preDeployCommand: " ", postDeployCommand: "" })).toBe(plain);
    expect(plain).not.toContain("TUGRA_PREDEPLOY");
  });

  it("an unknown hook service throws before any script exists (pre-swap failure)", () => {
    expect(() => buildComposeUpScript({ ...hooked, composeHookService: "gone" })).toThrow(BadRequestException);
  });

  it("a rollback (hooks nulled) emits no hook markers", () => {
    const rb = buildComposeUpScript({ ...hooked, preDeployCommand: null, postDeployCommand: null, composeHookService: null });
    expect(rb).not.toContain("TUGRA_PREDEPLOY");
    expect(rb).not.toContain("TUGRA_POSTDEPLOY");
    expect(rb).toBe(buildComposeUpScript(base));
  });
});

describe("git compose up script with hooks", () => {
  const RENDERED = "services:\n  api:\n    image: app:1\n    build:\n      context: /etc/tugra/compose-git/abc/src\n";
  const app: AppSpec = { ...gitBase, composeHookService: "api", preDeployCommand: "migrate", postDeployCommand: "warm" };
  const plan = composeHookPlan(app, RENDERED)!;
  const CLONE = "/etc/tugra/compose-git/abc/src";
  const s = buildComposeGitUpScript(app, SHA, false, plan);
  const lines = s.split("\n");

  it("the plan from the rendered stack picks build for a built service", () => {
    expect(plan.prepare).toBe("build");
  });

  it("contains exactly one git clone (the hook never re-clones) and the sha lock precedes the hook", () => {
    expect((s.match(/git clone/g) ?? []).length).toBe(1);
    expect(idx(lines, `[ "$TUGRA_SHA" =`)).toBeLessThan(idx(lines, "TUGRA_PREDEPLOY: running"));
    expect(s).not.toContain("config 2>/dev/null\n".repeat(2)); // render happens once
  });

  it("orders login -> build -> rm -> run -> up -> logout -> ps -> post and uses the quoted clone file", () => {
    const withReg = buildComposeGitUpScript({ ...app, registryAuth: { url: "ghcr.io", user: "bot", token: "t" } }, SHA, false, plan).split("\n");
    const order = [
      idx(withReg, "login"),
      idx(withReg, " build 'api'"),
      idx(withReg, "docker rm -f tugra_abc_hook"),
      idx(withReg, "run --rm"),
      idx(withReg, " up -d "),
      idx(withReg, "logout"),
      idx(withReg, / ps$/),
      idx(withReg, "TUGRA_POSTDEPLOY: running"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(s).toContain(`-f '${CLONE}/docker-compose.yml' run --rm -T -l traefik.enable=false --name tugra_abc_hook --entrypoint sh 'api' -c 'migrate'`);
  });

  it("carries the override file and env-file (even though ps only does with a prefix) on every hook call", () => {
    const e: AppSpec = { ...app, env: { A: "1" }, serviceDomains: [{ service: "api", hostname: "a.example.com", port: 80 } as never] };
    const t = buildComposeGitUpScript(e, SHA, true, plan);
    const hookCalls = t.split("\n").filter((l) => /docker compose/.test(l) && /build (--no-cache )?'api'|run --rm|ps -q|exec -T/.test(l));
    expect(hookCalls.length).toBe(4);
    for (const l of hookCalls) {
      expect(l).toContain("-f /etc/tugra/compose-git/abc/override.yml");
      expect(l).toContain("--env-file /etc/tugra/compose-git/abc/.env");
    }
    expect(t).toContain(" build --no-cache 'api'");
  });

  it("is byte-identical when hooks are unset / null", () => {
    const legacy = buildComposeGitUpScript(gitBase, SHA, false);
    expect(buildComposeGitUpScript(gitBase, SHA, false, null)).toBe(legacy);
    expect(legacy).not.toContain("TUGRA_PREDEPLOY");
  });

  it("the size preflight trips with a large command", () => {
    const big = { ...app, preDeployCommand: "x".repeat(130_000) };
    expect(() => buildComposeGitUpScript(big, SHA, false, composeHookPlan(big, RENDERED))).toThrow();
  });
});

describe("hook step builders", () => {
  it("name the one-off container from the app id only", () => {
    expect(composeHookContainerName({ id: "cabc" })).toBe("tugra_cabc_hook");
  });

  it("emit nothing for a missing command", () => {
    const o = { proj: "p", files: "-f f ", envArg: "", prefix: "", noCache: false };
    expect(composeHookPreSteps(hooked, { service: "api", pre: null, post: "x", prepare: "pull" }, o)).toEqual([]);
    expect(composeHookPostSteps(hooked, { service: "api", pre: "x", post: null, prepare: "pull" }, o)).toEqual([]);
  });
});
