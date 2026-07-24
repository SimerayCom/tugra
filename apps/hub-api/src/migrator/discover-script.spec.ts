import {
  assertValidContainerRef,
  buildDiscoverScript,
  buildInspectOneScript,
  buildRenameScript,
  parseDiscovered,
  CONTAINER_REF_RE,
  NO_DOCKER_MARKER,
} from "./discover-script";

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
});
