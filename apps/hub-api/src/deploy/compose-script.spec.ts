import {
  buildComposeDownScript,
  buildComposeStopScript,
  buildComposeUpScript,
  buildLogsScript,
  composeProject,
} from "./compose-script";
import type { AppSpec } from "./deploy-script";

const base: AppSpec = {
  id: "abc",
  source: "COMPOSE",
  composeFile: "services:\n  web:\n    image: nginx",
  env: {},
  hostPort: null,
  containerPort: null,
};

describe("compose-script", () => {
  it("names the compose project deterministically", () => {
    expect(composeProject({ id: "abc" })).toBe("tugra_abc");
  });

  it("writes the compose file and brings the stack up under a project", () => {
    const s = buildComposeUpScript(base);
    expect(s).toContain("mkdir -p /etc/tugra/compose/abc");
    expect(s).toContain("base64 -d > /etc/tugra/compose/abc/docker-compose.yml");
    expect(s).toContain("docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml up -d --remove-orphans");
    expect(s).toContain("docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml ps");
    // the base64 decodes back to the compose YAML
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/docker-compose\.yml/);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1], "base64").toString()).toBe(base.composeFile);
    // no env-file when there are no env vars
    expect(s).not.toContain("--env-file");
  });

  it("force deploy (noCache) re-pulls images with --pull always", () => {
    expect(buildComposeUpScript(base, true)).toContain("up -d --pull always --remove-orphans");
    expect(buildComposeUpScript(base, false)).toContain("up -d --remove-orphans");
    expect(buildComposeUpScript(base, false)).not.toContain("--pull always");
  });

  it("writes a .env and passes --env-file when the app has env vars", () => {
    const s = buildComposeUpScript({ ...base, env: { FOO: "bar" } });
    expect(s).toContain("base64 -d > /etc/tugra/compose/abc/.env");
    expect(s).toContain("--env-file /etc/tugra/compose/abc/.env");
    expect(s).toContain("chmod 600 /etc/tugra/compose/abc/.env");
  });

  it("logs in to a private registry before up and out after (no raw token)", () => {
    const s = buildComposeUpScript({ ...base, registryAuth: { url: "reg.io", user: "u", token: "secret123" } });
    expect(s).toContain("--password-stdin");
    expect(s).toContain('docker --config "$sd" login');
    expect(s).toContain("logout");
    expect(s.indexOf("login")).toBeLessThan(s.indexOf("up -d"));
    expect(s).not.toContain("secret123");
  });

  it("no registry login when no auth is configured (regression)", () => {
    expect(buildComposeUpScript(base)).not.toContain("docker --config");
  });

  it("stop uses compose stop; down removes volumes + the dir", () => {
    expect(buildComposeStopScript(base)).toBe(
      "docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml stop",
    );
    const down = buildComposeDownScript(base, { volumes: true });
    expect(down).toContain("down -v");
    expect(down).toContain("rm -rf /etc/tugra/compose/abc");
  });

  it("buildLogsScript: compose stack vs single container, with tail clamp", () => {
    expect(buildLogsScript(base, 50)).toBe(
      "docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml logs --no-color --tail 50 2>&1",
    );
    const img: AppSpec = { ...base, source: "IMAGE", composeFile: undefined };
    expect(buildLogsScript(img, 50)).toBe("docker logs --tail 50 tugra_abc 2>&1");
    expect(buildLogsScript(img, 0)).toContain("--tail 1");
    expect(buildLogsScript(img, 99999)).toContain("--tail 2000");
  });
});
