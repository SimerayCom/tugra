import {
  assertValidContainerRef,
  buildDiscoverScript,
  buildInspectOneScript,
  buildRenameScript,
  buildUnadoptScript,
  parseDiscovered,
  CONTAINER_REF_RE,
  CONTAINER_GONE_MARKER,
  NO_DOCKER_MARKER,
  isTugraImage,
  parseSelfHostname,
  toPublicContainer,
} from "./discover-script";
import { STACK, CUSTOM_STACK, OTHER_TUGRA, FOREIGN, inspectLine } from "./testing/demo-containers";

/** Minimal but realistic `docker inspect --format '{{json .}}'` object. */
function inspectJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Id: "id_" + (over.Name ?? "x"),
    Name: "/x",
    State: { Status: "running" },
    Config: { Image: "img:1", Env: [], Labels: {} },
    HostConfig: { PortBindings: {}, RestartPolicy: { Name: "no" } },
    Mounts: [],
    ...over,
  });
}

describe("discover-script", () => {
  describe("assertValidContainerRef / CONTAINER_REF_RE", () => {
    it("accepts docker-legal names and ids", () => {
      for (const ok of ["web", "my-app_1", "tugra_clx123", "a".repeat(64), "nginx.proxy-2"]) {
        expect(CONTAINER_REF_RE.test(ok)).toBe(true);
        expect(() => assertValidContainerRef(ok)).not.toThrow();
      }
    });
    it("rejects shell metacharacters, spaces and leading flags", () => {
      for (const bad of ["evil; rm -rf /", "a b", "$(whoami)", "a|b", "a&b", "`id`", "--force", "-x", "", "a".repeat(129)]) {
        expect(() => assertValidContainerRef(bad)).toThrow(/invalid/);
      }
    });
  });

  describe("script builders", () => {
    it("buildDiscoverScript inspects all containers as NDJSON + guards a docker-less host", () => {
      const s = buildDiscoverScript();
      expect(s).toContain("command -v docker");
      expect(s).toContain(NO_DOCKER_MARKER);
      expect(s).toContain("docker ps -aq");
      expect(s).toContain("docker inspect --format '{{json .}}' $ids");
    });
    it("buildInspectOneScript validates the ref and inspects just it", () => {
      expect(buildInspectOneScript("web")).toBe("docker inspect --format '{{json .}}' web 2>/dev/null");
      expect(() => buildInspectOneScript("a; rm -rf /")).toThrow(/invalid/);
    });
    it("buildRenameScript validates BOTH refs", () => {
      expect(buildRenameScript("web", "tugra_clx1")).toBe("docker rename web tugra_clx1");
      expect(() => buildRenameScript("ok", "bad name")).toThrow(/invalid/);
      expect(() => buildRenameScript("bad;name", "ok")).toThrow(/invalid/);
    });
    it("buildUnadoptScript renames only if the container exists, else marks it gone (both validated)", () => {
      const s = buildUnadoptScript("tugra_clx1", "web");
      expect(s).toContain("docker container inspect tugra_clx1");
      expect(s).toContain("docker rename tugra_clx1 web");
      expect(s).toContain(`echo ${CONTAINER_GONE_MARKER}`);
      expect(() => buildUnadoptScript("ok", "bad name")).toThrow(/invalid/);
      expect(() => buildUnadoptScript("a; rm -rf /", "ok")).toThrow(/invalid/);
    });
  });

  describe("parseDiscovered", () => {
    it("returns [] for empty / marker-only / whitespace output", () => {
      expect(parseDiscovered("")).toEqual([]);
      expect(parseDiscovered(`${NO_DOCKER_MARKER}\n`)).toEqual([]);
      expect(parseDiscovered("   \n  \n")).toEqual([]);
    });

    it("parses name (strips leading slash), image, state, restart policy", () => {
      const out = inspectJson({
        Name: "/web",
        State: { Status: "running" },
        Config: { Image: "nginx:1.25", Env: [], Labels: {} },
        HostConfig: { PortBindings: {}, RestartPolicy: { Name: "unless-stopped" } },
      });
      const [c] = parseDiscovered(out);
      expect(c.name).toBe("web");
      expect(c.image).toBe("nginx:1.25");
      expect(c.state).toBe("running");
      expect(c.restartPolicy).toBe("unless-stopped");
      expect(c.isTugra).toBe(false);
      expect(c.composeProject).toBeNull();
    });

    it("parses published port bindings (multi) with protocol", () => {
      const out = inspectJson({
        Name: "/multi",
        HostConfig: {
          PortBindings: { "80/tcp": [{ HostPort: "8081" }], "53/udp": [{ HostPort: "5353" }] },
          RestartPolicy: { Name: "no" },
        },
      });
      const [c] = parseDiscovered(out);
      expect(c.ports).toEqual([
        { host: 8081, container: 80, protocol: "tcp" },
        { host: 5353, container: 53, protocol: "udp" },
      ]);
    });

    it("falls back to exposed-only ports (host: null) when nothing is published", () => {
      const out = inspectJson({
        Name: "/api",
        State: { Status: "exited" },
        Config: { Image: "myapi:latest", Env: [], Labels: {}, ExposedPorts: { "3000/tcp": {}, "9090/tcp": {} } },
        HostConfig: { PortBindings: {}, RestartPolicy: { Name: "no" } },
      });
      const [c] = parseDiscovered(out);
      expect(c.state).toBe("exited");
      expect(c.ports).toEqual([
        { host: null, container: 3000, protocol: "tcp" },
        { host: null, container: 9090, protocol: "tcp" },
      ]);
    });

    it("keeps env values verbatim (incl. '=' in value) but drops PATH/HOSTNAME noise", () => {
      const out = inspectJson({
        Name: "/web",
        Config: { Image: "x:1", Labels: {}, Env: ["PATH=/usr/bin", "HOSTNAME=abc123", "APP_ENV=prod", "DB_PASSWORD=s3cr3t=x"] },
      });
      const [c] = parseDiscovered(out);
      expect(c.env).toEqual([
        { key: "APP_ENV", value: "prod" },
        { key: "DB_PASSWORD", value: "s3cr3t=x" },
      ]);
    });

    it("resolves mount source: named volume → Name, bind → Source", () => {
      const out = inspectJson({
        Name: "/web",
        Mounts: [
          { Type: "volume", Name: "webdata", Source: "/var/lib/docker/volumes/webdata/_data", Destination: "/data" },
          { Type: "bind", Source: "/srv/conf", Destination: "/etc/nginx/conf.d" },
        ],
      });
      const [c] = parseDiscovered(out);
      expect(c.mounts).toEqual([
        { type: "volume", source: "webdata", target: "/data" },
        { type: "bind", source: "/srv/conf", target: "/etc/nginx/conf.d" },
      ]);
    });

    it("flags Tugra app (tugra_) and infra (tugra-proxy/tugra-cfd/tugra-agent) as isTugra", () => {
      const names = ["/tugra_clx123", "/tugra-proxy", "/tugra-cfd", "/tugra-agent"];
      for (const Name of names) {
        const [c] = parseDiscovered(inspectJson({ Name }));
        expect(c.isTugra).toBe(true);
      }
    });

    it("does NOT over-match a user container merely containing 'tugra'", () => {
      const [c] = parseDiscovered(inspectJson({ Name: "/my-tugra-blog" }));
      expect(c.isTugra).toBe(false);
    });

    it("captures the compose project label", () => {
      const out = inspectJson({
        Name: "/myproj-db-1",
        Config: { Image: "postgres:16", Env: [], Labels: { "com.docker.compose.project": "myproj" } },
      });
      const [c] = parseDiscovered(out);
      expect(c.composeProject).toBe("myproj");
    });

    it("is line-tolerant: skips a malformed JSON line, keeps the good ones", () => {
      const out = [inspectJson({ Name: "/a" }), "{not json", "", inspectJson({ Name: "/b" })].join("\n");
      const parsed = parseDiscovered(out);
      expect(parsed.map((c) => c.name)).toEqual(["a", "b"]);
    });
  });

  describe("Tugra-owned classification (real demo labels)", () => {
    const reasonOf = (line: string) => parseDiscovered(line)[0].tugraReason;

    it("flags every container of Tugra's own install stack", () => {
      for (const [k, line] of Object.entries(STACK)) {
        const [c] = parseDiscovered(line);
        expect([k, c.isTugra]).toEqual([k, true]);
        expect([k, c.tugraReason]).toEqual([k, "stack"]);
      }
    });

    it("catches the bundled postgres/redis through the compose project even with no Tugra marker of their own", () => {
      const out = [CUSTOM_STACK.hub, CUSTOM_STACK.pg].join("\n");
      const parsed = parseDiscovered(out);
      expect(parsed.map((c) => [c.name, c.tugraReason])).toEqual([["panel-hub-api-1", "stack"], ["panel-postgres-1", "stack"]]);
      // the postgres alone (no first-party sibling in the scan) is NOT guessed to be Tugra's
      expect(reasonOf(CUSTOM_STACK.pg)).toBeNull();
    });

    it("finds the project Tugra itself runs in via the agent container's own id (TUGRA_SELF hostname)", () => {
      const agent = inspectLine({ id: "abcdef0123456789aaaa", name: "svc-1", image: "busybox", labels: { "com.docker.compose.project": "weird" } });
      const sibling = inspectLine({ name: "weird-db-1", image: "postgres:16", labels: { "com.docker.compose.project": "weird" } });
      const other = inspectLine({ name: "shop-db-1", image: "postgres:16", labels: { "com.docker.compose.project": "shop" } });
      const out = ["TUGRA_SELF=abcdef012345", agent, sibling, other].join("\n");
      expect(parseDiscovered(out).map((c) => [c.name, c.isTugra])).toEqual([["svc-1", true], ["weird-db-1", true], ["shop-db-1", false]]);
      expect(parseSelfHostname(out)).toBe("abcdef012345");
      // a host name (script run outside a container) never matches an id
      expect(parseDiscovered(["TUGRA_SELF=my-host", agent].join("\n"))[0].isTugra).toBe(false);
      expect(parseSelfHostname("nothing")).toBeNull();
    });

    it("flags the proxy, the tunnel, every helper family and Tugra-managed apps/dbs/compose services", () => {
      const want: Record<string, string> = {
        proxy: "proxy", swarmProxy: "proxy", tunnel: "tunnel",
        vx: "helper", patch: "helper", reboot: "helper", migrator: "helper", objmig: "helper", backup: "helper", labelled: "helper",
        app: "managed", db: "managed", composeSvc: "managed",
      };
      for (const [k, line] of Object.entries(OTHER_TUGRA)) {
        const [c] = parseDiscovered(line);
        expect([k, c.isTugra]).toEqual([k, true]);
        expect([k, c.tugraReason]).toEqual([k, want[k]]);
      }
    });

    it("keeps ordinary foreign containers (including compose ones and look-alikes) unflagged", () => {
      for (const [k, line] of Object.entries(FOREIGN)) {
        const [c] = parseDiscovered(line);
        expect([k, c.isTugra]).toEqual([k, false]);
        expect([k, c.tugraReason]).toEqual([k, null]);
      }
    });

    it("identifies Tugra images (registry mirror, digest, local build) but not look-alikes", () => {
      for (const ok of ["ghcr.io/simeraycom/tugra-hub:1@sha256:abc", "mirror.example/simeraycom/tugra-web:2", "tugra-hub-api", "tugra_clx1:clx2"]) expect(isTugraImage(ok)).toBe(true);
      for (const no of ["nginx:1.25", "myorg/tugra:1", "ghcr.io/acme/web:1", "registry:5000/tugraphy/x"]) expect(isTugraImage(no)).toBe(false);
    });

    it("toPublicContainer drops the classifier-internal fields", () => {
      const pub = toPublicContainer(parseDiscovered(FOREIGN.web)[0]) as unknown as Record<string, unknown>;
      expect(Object.keys(pub).sort()).toEqual(["composeProject", "env", "id", "image", "isTugra", "mounts", "name", "ports", "restartPolicy", "state"]);
    });

    it("the discover script asks the host for its own hostname", () => {
      expect(buildDiscoverScript()).toContain("TUGRA_SELF=$(hostname");
    });
  });
});
