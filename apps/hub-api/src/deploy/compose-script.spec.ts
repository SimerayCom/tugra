import {
  buildComposeDownScript,
  buildComposeRestartScript,
  buildComposeStartScript,
  buildComposeStopScript,
  buildComposeUpScript,
  buildContainersScript,
  buildLogsScript,
  composeProject,
  composeVolumes,
  interpolateMountContent,
  parseContainers,
} from "./compose-script";
import { parse as parseYaml } from "yaml";
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

  it("writes NO Traefik override when the app has no domain/web service (regression)", () => {
    const s = buildComposeUpScript(base);
    expect(s).not.toContain("docker-compose.tugra.yml");
    expect(s).not.toContain("traefik");
  });

  it("layers a label-only override joining the web service to the proxy when magic-exposed", () => {
    const magic: AppSpec = {
      ...base,
      domain: "web-abc123.1-2-3-4.sslip.io",
      composeWebService: "web",
      containerPort: 3000,
      certType: "http",
    };
    const s = buildComposeUpScript(magic);
    // override file is written and layered with a second -f, before the user file's -f
    expect(s).toContain("base64 -d > /etc/tugra/compose/abc/docker-compose.tugra.yml");
    expect(s).toContain(
      "docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml -f /etc/tugra/compose/abc/docker-compose.tugra.yml up -d --remove-orphans",
    );
    // the override YAML targets the web service with the proxy network + Traefik labels
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/docker-compose\.tugra\.yml/);
    expect(m).toBeTruthy();
    const yaml = Buffer.from(m![1], "base64").toString();
    expect(yaml).toContain("services:\n  web:");
    // keeps the default network (DB reach) AND joins the proxy
    expect(yaml).toContain("- default");
    expect(yaml).toContain("- tugra-proxy");
    expect(yaml).toContain("traefik.enable=true");
    expect(yaml).toContain("Host(`web-abc123.1-2-3-4.sslip.io`)");
    expect(yaml).toContain("loadbalancer.server.port=3000");
    expect(yaml).toContain("tugra-proxy:\n    external: true");
    // magic is plain HTTP (certType http) → no TLS/LE on the compose label set
    expect(yaml).not.toContain("certresolver");
  });

  it("materializes config mounts (interpolated) + a read-only bind override without a domain", () => {
    const spec: AppSpec = {
      ...base,
      env: { REDIS_PASSWORD: "s3cret" },
      configMounts: [
        { serviceName: "redis", target: "/usr/local/etc/redis/redis.conf", content: "requirepass ${REDIS_PASSWORD}\n", mode: "0644" },
      ],
    };
    const s = buildComposeUpScript(spec);
    expect(s).toContain("mkdir -p /etc/tugra/compose/abc/mounts");
    expect(s).toContain("chmod 0644 /etc/tugra/compose/abc/mounts/0");
    // the written file decodes to the INTERPOLATED content (secret resolved, not the ${KEY} placeholder)
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/mounts\/0/);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1], "base64").toString()).toBe("requirepass s3cret\n");
    // override written + layered even without a domain, targeting the mount's service with a :ro bind
    expect(s).toContain("base64 -d > /etc/tugra/compose/abc/docker-compose.tugra.yml");
    expect(s).toContain("-f /etc/tugra/compose/abc/docker-compose.tugra.yml");
    const o = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/docker-compose\.tugra\.yml/);
    const yaml = Buffer.from(o![1], "base64").toString();
    expect(yaml).toContain("services:\n  redis:");
    expect(yaml).toContain('"/etc/tugra/compose/abc/mounts/0:/usr/local/etc/redis/redis.conf:ro"');
    expect(yaml).not.toContain("tugra-proxy"); // no proxy block without magic
  });

  it("combines proxy labels/networks and a config bind on the same web service (magic + mount)", () => {
    const spec: AppSpec = {
      ...base,
      domain: "web-x.1-2-3-4.sslip.io",
      composeWebService: "web",
      containerPort: 3000,
      certType: "http",
      configMounts: [{ serviceName: "web", target: "/etc/app.conf", content: "a=1\n" }],
    };
    const s = buildComposeUpScript(spec);
    const o = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/docker-compose\.tugra\.yml/);
    const yaml = Buffer.from(o![1], "base64").toString();
    expect(yaml).toContain("services:\n  web:");
    expect(yaml).toContain("- tugra-proxy"); // networks
    expect(yaml).toContain("traefik.enable=true"); // labels
    expect(yaml).toContain('"/etc/tugra/compose/abc/mounts/0:/etc/app.conf:ro"'); // bind
    expect(yaml).toContain("tugra-proxy:\n    external: true"); // top-level networks (magic)
  });

  it("merges multiple mounts on one service into a SINGLE volumes: block (valid YAML)", () => {
    const spec: AppSpec = {
      ...base,
      configMounts: [
        { serviceName: "web", target: "/etc/a.conf", content: "a\n" },
        { serviceName: "web", target: "/etc/b.conf", content: "b\n" },
      ],
    };
    const s = buildComposeUpScript(spec);
    const o = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/compose\/abc\/docker-compose\.tugra\.yml/);
    const yaml = Buffer.from(o![1], "base64").toString();
    // exactly one `volumes:` key under the service (duplicate mapping keys are invalid YAML)
    expect((yaml.match(/volumes:/g) ?? []).length).toBe(1);
    // the override parses (yaml throws on duplicate keys) and carries BOTH binds
    const doc = parseYaml(yaml) as { services: { web: { volumes: string[] } } };
    expect(doc.services.web.volumes).toEqual([
      "/etc/tugra/compose/abc/mounts/0:/etc/a.conf:ro",
      "/etc/tugra/compose/abc/mounts/1:/etc/b.conf:ro",
    ]);
  });

  it("writes no mounts dir/override when there are no config mounts (regression)", () => {
    expect(buildComposeUpScript(base)).not.toContain("/mounts");
    expect(buildComposeUpScript(base)).not.toContain("docker-compose.tugra.yml");
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

  it("start/restart manage the whole compose stack", () => {
    expect(buildComposeStartScript(base)).toBe(
      "docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml start",
    );
    expect(buildComposeRestartScript(base)).toBe(
      "docker compose -p tugra_abc -f /etc/tugra/compose/abc/docker-compose.yml restart",
    );
  });

  it("buildContainersScript: compose by project label, single by exact name", () => {
    expect(buildContainersScript(base)).toContain("--filter label=com.docker.compose.project=tugra_abc");
    const img: AppSpec = { ...base, source: "IMAGE", composeFile: undefined };
    expect(buildContainersScript(img)).toContain("--filter name=^tugra_abc$");
  });

  it("parseContainers parses name\\tstate lines and drops blanks", () => {
    expect(parseContainers("tugra_abc-web-1\trunning\ntugra_abc-db-1\texited\n\n")).toEqual([
      { name: "tugra_abc-web-1", state: "running" },
      { name: "tugra_abc-db-1", state: "exited" },
    ]);
    expect(parseContainers("")).toEqual([]);
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

describe("composeVolumes", () => {
  const WP = `services:
  wordpress:
    image: wordpress:6
    volumes:
      - wp_data:/var/www/html
  db:
    image: mariadb:11
    volumes:
      - db_data:/var/lib/mysql
volumes:
  wp_data:
  db_data:
`;

  it("parses WordPress named volumes with the tugra project docker name and mount points (browsable)", () => {
    const vols = composeVolumes({ id: "app1", composeFile: WP });
    const wp = vols.find((v) => v.key === "wp_data")!;
    expect(wp.dockerName).toBe("tugra_app1_wp_data");
    expect(wp.browsable).toBe(true);
    expect(wp.mounts).toEqual([{ service: "wordpress", path: "/var/www/html" }]);
    expect(vols.find((v) => v.key === "db_data")?.mounts).toEqual([{ service: "db", path: "/var/lib/mysql" }]);
  });

  it("marks external and custom-named volumes NOT browsable (never read an arbitrary host volume)", () => {
    const vols = composeVolumes({
      id: "app1",
      composeFile: "services:\n  x:\n    image: nginx\nvolumes:\n  ext:\n    external: true\n  named:\n    name: shared_vol\n",
    });
    expect(vols.find((v) => v.key === "ext")).toMatchObject({ dockerName: "ext", external: true, browsable: false });
    expect(vols.find((v) => v.key === "named")).toMatchObject({ dockerName: "shared_vol", browsable: false });
  });

  it("ignores bind mounts and returns [] for no compose file / invalid YAML", () => {
    const vols = composeVolumes({ id: "a", composeFile: "services:\n  x:\n    image: nginx\n    volumes:\n      - ./data:/x\n      - /host:/y\n" });
    expect(vols).toEqual([]);
    expect(composeVolumes({ id: "a", composeFile: null })).toEqual([]);
    expect(composeVolumes({ id: "a", composeFile: "::: not yaml :::" })).toEqual([]);
  });
});

describe("interpolateMountContent", () => {
  const env = { REDIS_PASSWORD: "s3cret", PORT: "80" };

  it("substitutes known env keys and leaves $uri / ${UNKNOWN} / literal $$ untouched", () => {
    expect(interpolateMountContent("requirepass ${REDIS_PASSWORD}\nport ${PORT}\n", env)).toBe(
      "requirepass s3cret\nport 80\n",
    );
    expect(interpolateMountContent("a $uri b", env)).toBe("a $uri b"); // no braces → untouched
    expect(interpolateMountContent("x ${UNKNOWN} y", env)).toBe("x ${UNKNOWN} y"); // not in env → untouched
    expect(interpolateMountContent("cost $$5", env)).toBe("cost $$5"); // literal $$
  });

  it("does not substitute a partial key match", () => {
    expect(interpolateMountContent("${PASS}", { PASSWORD: "x" })).toBe("${PASS}"); // PASS ≠ PASSWORD
  });
});
