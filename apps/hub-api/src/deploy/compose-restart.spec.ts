import { parse as parseYaml } from "yaml";
import { composeRestartServices, DEFAULT_COMPOSE_RESTART } from "./compose-restart";
import { buildComposeUpScript, composeOverride } from "./compose-script";
import { buildComposeGitUpScript } from "./compose-git";
import type { AppSpec } from "./deploy-script";

const app = (composeFile: string, extra: Partial<AppSpec> = {}): AppSpec =>
  ({ id: "abc", source: "COMPOSE", composeFile, env: {}, hostPort: null, containerPort: null, ...extra }) as AppSpec;

const overrideOf = (script: string, file = "docker-compose.tugra.yml"): string => {
  const m = script.match(new RegExp(`printf %s '([A-Za-z0-9+/=]+)' \\| base64 -d > \\S*${file.replace(".", "\\.")}`));
  return m ? Buffer.from(m[1], "base64").toString() : "";
};

describe("composeRestartServices", () => {
  it("returns every member that sets no restart policy (a template that forgot `restart:`)", () => {
    expect(composeRestartServices("services:\n  meilisearch:\n    image: getmeili/meilisearch\n  web:\n    image: nginx\n")).toEqual(["meilisearch", "web"]);
  });

  it("respects an explicit value, including \"no\" and on-failure, and a bare `restart` on one member only", () => {
    const y = [
      "services:",
      "  a:",
      "    image: x",
      "    restart: unless-stopped",
      "  b:",
      "    image: x",
      '    restart: "no"',
      "  c:",
      "    image: x",
      "    restart: on-failure:3",
      "  d:",
      "    image: x",
      "  e:",
      "    image: x",
      "    restart: ${RESTART_POLICY:-no}",
    ].join("\n");
    expect(composeRestartServices(y)).toEqual(["d"]);
  });

  it("an unquoted `restart: no` (YAML 1.1 boolean) is still an explicit choice", () => {
    expect(composeRestartServices("services:\n  a:\n    image: x\n    restart: no\n  b:\n    image: x\n")).toEqual(["b"]);
  });

  it("treats deploy.restart_policy as a stated policy (compose honours it when `restart` is absent)", () => {
    expect(composeRestartServices("services:\n  a:\n    image: x\n    deploy:\n      restart_policy:\n        condition: on-failure\n  b:\n    image: x\n")).toEqual(["b"]);
  });

  it("does not give an init member a policy: a dependent waits for it with service_completed_successfully", () => {
    const y = [
      "services:",
      "  init-db:",
      "    image: x",
      "  migrate:",
      "    image: x",
      "  app:",
      "    image: x",
      "    depends_on:",
      "      init-db:",
      "        condition: service_completed_successfully",
      "      migrate:",
      "        condition: service_completed_successfully",
      "      db:",
      "        condition: service_healthy",
      "  db:",
      "    image: x",
    ].join("\n");
    expect(composeRestartServices(y)).toEqual(["app", "db"]);
  });

  it("a list-form depends_on (service_started) does not make its target an init member", () => {
    expect(composeRestartServices("services:\n  db:\n    image: x\n  app:\n    image: x\n    depends_on:\n      - db\n")).toEqual(["db", "app"]);
  });

  it("leaves compose jobs alone", () => {
    expect(composeRestartServices("services:\n  job:\n    image: x\n    deploy:\n      mode: replicated-job\n  a:\n    image: x\n")).toEqual(["a"]);
  });

  it("follows an in-file `extends` chain and anchors/merge keys for an inherited restart", () => {
    const y = [
      "x-base: &base",
      "  image: x",
      "  restart: always",
      "services:",
      "  parent:",
      "    image: x",
      "    restart: unless-stopped",
      "  child:",
      "    extends: parent",
      "  grandchild:",
      "    extends:",
      "      service: child",
      "  anchored:",
      "    <<: *base",
      "  other:",
      "    image: x",
      "  foreign:",
      "    extends:",
      "      file: other.yml",
      "      service: z",
    ].join("\n");
    expect(composeRestartServices(y)).toEqual(["other"]);
  });

  it("is empty for an empty / invalid / service-less file and never throws", () => {
    expect(composeRestartServices(null)).toEqual([]);
    expect(composeRestartServices("")).toEqual([]);
    expect(composeRestartServices("services: [unclosed")).toEqual([]);
    expect(composeRestartServices("name: x\n")).toEqual([]);
    expect(composeRestartServices("services:\n  a: null\n")).toEqual([]);
  });

  it("never emits a service key that is not a plain compose name", () => {
    expect(composeRestartServices('services:\n  "a: b":\n    image: x\n  ok:\n    image: x\n')).toEqual(["ok"]);
  });
});

describe("compose override default restart", () => {
  const bare = "services:\n  meilisearch:\n    image: getmeili/meilisearch\n  web:\n    image: nginx\n";

  it("renders restart: unless-stopped for each member without a policy, as one key per service", () => {
    const y = composeOverride(app(bare));
    const doc = parseYaml(y) as { services: Record<string, { restart: string }> };
    expect(Object.keys(doc.services)).toEqual(["meilisearch", "web"]);
    expect(doc.services.meilisearch.restart).toBe(DEFAULT_COMPOSE_RESTART);
    expect(doc.services.web.restart).toBe("unless-stopped");
  });

  it("leaves an explicit restart (and an init member) out of the override", () => {
    const y = composeOverride(
      app("services:\n  a:\n    image: x\n    restart: \"no\"\n  init:\n    image: x\n  b:\n    image: x\n    depends_on:\n      init:\n        condition: service_completed_successfully\n  c:\n    image: x\n"),
    );
    expect(Object.keys((parseYaml(y) as { services: object }).services)).toEqual(["b", "c"]);
  });

  it("merges with routing / mount / network blocks of the same service without a duplicate key", () => {
    const y = composeOverride(
      app(bare, {
        domain: "w.example.test",
        composeWebService: "web",
        containerPort: 80,
        configMounts: [{ serviceName: "web", target: "/etc/x.conf", content: "a", mode: "0644" }],
      } as Partial<AppSpec>),
    );
    const doc = parseYaml(y) as { services: Record<string, { restart: string; labels: string[]; networks: string[]; volumes: string[] }> }; // throws on a duplicate mapping key
    expect(doc.services.web.restart).toBe("unless-stopped");
    expect(doc.services.web.labels.length).toBeGreaterThan(0);
    expect(doc.services.web.networks).toContain("default");
    expect(doc.services.web.volumes).toHaveLength(1);
    expect(doc.services.meilisearch.restart).toBe("unless-stopped");
  });

  it("the up script writes + layers the override for a plain app (no domain, no mounts) whose template sets no restart", () => {
    const s = buildComposeUpScript(app(bare));
    expect(s).toContain("base64 -d > /etc/tugra/compose/abc/docker-compose.tugra.yml");
    expect(s).toContain("-f /etc/tugra/compose/abc/docker-compose.yml -f /etc/tugra/compose/abc/docker-compose.tugra.yml up -d --remove-orphans");
    expect(overrideOf(s)).toContain("restart: unless-stopped");
  });

  it("the up script layers NO override when every member states its own policy (byte-identical)", () => {
    const s = buildComposeUpScript(app("services:\n  a:\n    image: x\n    restart: \"no\"\n"));
    expect(s).not.toContain("docker-compose.tugra.yml");
  });

  it("an explicit restart: \"no\" survives: the override never names that service", () => {
    const s = buildComposeUpScript(app("services:\n  a:\n    image: x\n    restart: \"no\"\n  b:\n    image: x\n"));
    const doc = parseYaml(overrideOf(s)) as { services: Record<string, unknown> };
    expect(Object.keys(doc.services)).toEqual(["b"]);
  });
});

describe("git-compose default restart (decided from the validated rendered stack)", () => {
  const git = app("", { gitUrl: "https://example.test/r.git", composePath: "docker-compose.yml", gitBranch: "main" } as Partial<AppSpec>);
  const rendered = "services:\n  api:\n    image: x\n  keep:\n    image: x\n    restart: \"no\"\n  seed:\n    image: x\n  web:\n    image: x\n    depends_on:\n      seed:\n        condition: service_completed_successfully\n";
  const sha = "a".repeat(64);

  it("writes override.yml with restart for the rendered members that set none, layered on up and ps", () => {
    const s = buildComposeGitUpScript(git, sha, false, null, rendered);
    const doc = parseYaml(overrideOf(s, "override.yml")) as { services: Record<string, { restart: string }> };
    expect(Object.keys(doc.services)).toEqual(["api", "web"]);
    expect(doc.services.api.restart).toBe("unless-stopped");
    expect(s).toContain("-f '/etc/tugra/compose-git/abc/src/docker-compose.yml' -f /etc/tugra/compose-git/abc/override.yml up -d --build --force-recreate");
    expect(s).toContain("-f /etc/tugra/compose-git/abc/override.yml ps");
  });

  it("without a rendered stack (or one where everything is explicit) no override is written", () => {
    expect(buildComposeGitUpScript(git, sha)).not.toContain("override.yml");
    expect(buildComposeGitUpScript(git, sha, false, null, "services:\n  a:\n    image: x\n    restart: always\n")).not.toContain("override.yml");
  });
});
