import { createHash } from "node:crypto";
import {
  buildComposeGitRenderScript,
  buildComposeGitUpScript,
  parseRenderedCompose,
  composeGitCloneDir,
  composeGitDir,
  COMPOSE_RENDERED_MARKER,
  COMPOSE_SHA_MARKER,
} from "./compose-git";
import type { AppSpec } from "./deploy-script";

const base: AppSpec = {
  id: "abc",
  source: "COMPOSE",
  composePath: "docker-compose.yml",
  gitUrl: "https://github.com/u/r.git",
  gitBranch: "main",
  env: {},
  hostPort: null,
  containerPort: null,
};

const CLONE = "/etc/tugra/compose-git/abc/src";

describe("compose-git — paths", () => {
  it("clones under a per-app dir and keeps .env OUTSIDE the clone root", () => {
    expect(composeGitDir(base)).toBe("/etc/tugra/compose-git/abc");
    expect(composeGitCloneDir(base)).toBe(CLONE);
    // the env file sibling is NOT under the clone (a bind inside the clone can never read it)
    expect(`${composeGitDir(base)}/.env`.startsWith(`${CLONE}/`)).toBe(false);
  });
});

describe("buildComposeGitRenderScript", () => {
  const s = buildComposeGitRenderScript(base);

  it("clones the repo, runs the symlink guard, and renders with `docker compose config`", () => {
    expect(s).toContain("set -e");
    expect(s).toContain(`CLONE=${CLONE}`);
    expect(s).toContain(`git clone --depth 1 --branch 'main' -- 'https://github.com/u/r.git' ${CLONE}`);
    expect(s).toContain("find \"$CLONE\" -type l"); // symlink-escape guard present
    expect(s).toContain("refusing to deploy a git compose stack");
    expect(s).toContain(`docker compose -p tugra_abc -f '${CLONE}/docker-compose.yml' config 2>/dev/null`);
  });

  it("emits the rendered-compose and sha markers", () => {
    expect(s).toContain(COMPOSE_RENDERED_MARKER);
    expect(s).toContain(COMPOSE_SHA_MARKER);
    expect(s).toContain("base64 | tr -d '\\n'");
    expect(s).toContain("sha256sum | cut -d' ' -f1");
  });

  it("renders from the repo-relative composePath (nested paths are joined + shell-quoted)", () => {
    const nested = buildComposeGitRenderScript({ ...base, composePath: "deploy/stack.yaml" });
    expect(nested).toContain(`-f '${CLONE}/deploy/stack.yaml' config`);
  });

  it("writes a resolved .env (outside the clone) and passes --env-file only when the app has env", () => {
    expect(s).not.toContain("--env-file"); // no env
    const withEnv = buildComposeGitRenderScript({ ...base, env: { API: "x" } });
    expect(withEnv).toContain("/etc/tugra/compose-git/abc/.env");
    expect(withEnv).toContain("--env-file /etc/tugra/compose-git/abc/.env config");
  });
});

describe("buildComposeGitUpScript", () => {
  const sha = "a".repeat(64);
  const s = buildComposeGitUpScript(base, sha);

  it("re-clones, re-renders and refuses to run unless the sha matches (TOCTOU lock)", () => {
    expect(s).toContain(`git clone --depth 1 --branch 'main'`);
    expect(s).toContain("TUGRA_SHA=$(printf %s \"$TUGRA_RENDERED\" | sha256sum | cut -d' ' -f1)");
    expect(s).toContain(`[ "$TUGRA_SHA" = '${sha}' ] ||`);
    expect(s).toContain("compose digest mismatch");
  });

  it("brings the stack up building from the clone, recreating, removing orphans", () => {
    expect(s).toContain(`docker compose --progress plain -p tugra_abc -f '${CLONE}/docker-compose.yml' up -d --build --force-recreate --remove-orphans`);
    expect(s).toContain(`docker compose -p tugra_abc -f '${CLONE}/docker-compose.yml'`);
    expect(s).toContain("ps");
  });

  it("force (noCache) adds --pull always --no-cache", () => {
    expect(buildComposeGitUpScript(base, sha, true)).toContain("up -d --build --pull always --no-cache --force-recreate --remove-orphans");
    expect(s).not.toContain("--no-cache");
  });

  it("writes NO routing override when there are no per-service domains", () => {
    expect(s).not.toContain("override.yml");
    expect(s).not.toContain("traefik");
  });

  it("layers a per-service routing override when the app has service domains", () => {
    const routed = buildComposeGitUpScript(
      { ...base, serviceDomains: [{ service: "web", hostname: "svc.example.com", port: 8080 }] },
      sha,
    );
    expect(routed).toContain("/etc/tugra/compose-git/abc/override.yml");
    expect(routed).toContain("-f /etc/tugra/compose-git/abc/override.yml up -d --build");
    // the override content is base64-encoded in the script; decode it and confirm it routes the service
    // (the raw script never contains the literal label text).
    const m = routed.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose-git\/abc\/override\.yml/);
    expect(m).toBeTruthy();
    const override = Buffer.from(m![1], "base64").toString();
    expect(override).toContain("web:");
    expect(override).toContain("svc.example.com");
    expect(override).toContain("traefik");
  });
});

describe("parseRenderedCompose", () => {
  const compose = "services:\n  web:\n    image: nginx\n";
  const sha = createHash("sha256").update(compose, "utf8").digest("hex");
  const good = `TUGRA_COMMIT=deadbeef\n${COMPOSE_RENDERED_MARKER}${Buffer.from(compose).toString("base64")}\n${COMPOSE_SHA_MARKER}${sha}\n`;

  it("decodes the rendered compose and its sha from the agent output", () => {
    expect(parseRenderedCompose(good)).toEqual({ compose, sha });
  });

  it("returns null when a marker is missing", () => {
    expect(parseRenderedCompose(`${COMPOSE_RENDERED_MARKER}${Buffer.from(compose).toString("base64")}\n`)).toBeNull();
    expect(parseRenderedCompose(`${COMPOSE_SHA_MARKER}${sha}\n`)).toBeNull();
    expect(parseRenderedCompose("no markers here")).toBeNull();
  });

  it("returns null when the sha is malformed or the base64 does not hash to it (tamper/truncation)", () => {
    expect(parseRenderedCompose(`${COMPOSE_RENDERED_MARKER}${Buffer.from(compose).toString("base64")}\n${COMPOSE_SHA_MARKER}not-a-sha\n`)).toBeNull();
    // right shape, wrong content → sha mismatch → rejected
    const tampered = `${COMPOSE_RENDERED_MARKER}${Buffer.from("services: {}\n").toString("base64")}\n${COMPOSE_SHA_MARKER}${sha}\n`;
    expect(parseRenderedCompose(tampered)).toBeNull();
  });
});
