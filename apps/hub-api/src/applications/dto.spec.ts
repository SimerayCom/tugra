import { CreateAppSchema, SetAutoDeploySchema, SetExtraPortsSchema, SetBasicAuthSchema, SetBuildSchema, SetConfigMountContentSchema, SetContainerCommandSchema, SetDeployHooksSchema, SetDomainOptionsSchema, SetExtraDomainsSchema, SetHealthCheckSchema, SetLimitsSchema, SetRedirectsSchema, SetServiceDomainsSchema, SetSourceSchema, SetWatchPathsSchema } from "./dto";

describe("SetDomainOptionsSchema — ipAllowlist", () => {
  const ok = (ipAllowlist: unknown[]) => SetDomainOptionsSchema.safeParse({ ipAllowlist });
  it("accepts IPv4/IPv6 addresses + CIDRs and an empty array (clear)", () => {
    expect(ok(["1.2.3.4", "10.0.0.0/8", "2001:db8::/32", "::1"]).success).toBe(true);
    expect(ok([]).success).toBe(true);
  });
  it("rejects bad addresses, out-of-range prefixes, junk and over-cap", () => {
    expect(ok(["999.1.1.1"]).success).toBe(false);
    expect(ok(["10.0.0.0/33"]).success).toBe(false); // v4 prefix > 32
    expect(ok(["2001:db8::/129"]).success).toBe(false); // v6 prefix > 128
    expect(ok(["10.0.0.0/8/9"]).success).toBe(false); // double slash
    expect(ok(["not-an-ip"]).success).toBe(false);
    expect(ok(["10.0.0.0; rm -rf"]).success).toBe(false);
    expect(ok(Array.from({ length: 51 }, () => "1.2.3.4")).success).toBe(false); // > 50
  });
  it("still requires at least one option field", () => {
    expect(SetDomainOptionsSchema.safeParse({}).success).toBe(false);
  });
});

describe("SetHealthCheckSchema — tunable timings", () => {
  it("accepts timing knobs + expectedStatus (and null to reset)", () => {
    expect(SetHealthCheckSchema.safeParse({ type: "HTTP", interval: 15, timeout: 8, retries: 40, startPeriod: 120, expectedStatus: 200 }).success).toBe(true);
    expect(SetHealthCheckSchema.safeParse({ interval: null, retries: null, startPeriod: null, expectedStatus: null }).success).toBe(true);
  });
  it("rejects out-of-range timings and a non-HTTP status", () => {
    expect(SetHealthCheckSchema.safeParse({ interval: 0 }).success).toBe(false);
    expect(SetHealthCheckSchema.safeParse({ retries: 101 }).success).toBe(false);
    expect(SetHealthCheckSchema.safeParse({ startPeriod: 99999 }).success).toBe(false);
    expect(SetHealthCheckSchema.safeParse({ expectedStatus: 99 }).success).toBe(false);
    expect(SetHealthCheckSchema.safeParse({ expectedStatus: 600 }).success).toBe(false);
  });
});

describe("SetBasicAuthSchema — HTTP basic auth users", () => {
  const ok = (users: unknown[]) => SetBasicAuthSchema.safeParse({ users });
  it("accepts users and an empty array (clear)", () => {
    expect(ok([{ user: "admin", password: "s3cret!" }]).success).toBe(true);
    expect(ok([]).success).toBe(true);
  });
  it("rejects a username with : or , (htpasswd separators), bad chars, dup users, newline password, over-cap", () => {
    expect(ok([{ user: "a:b", password: "x" }]).success).toBe(false); // colon
    expect(ok([{ user: "a,b", password: "x" }]).success).toBe(false); // comma
    expect(ok([{ user: "a b", password: "x" }]).success).toBe(false); // space
    expect(ok([{ user: "u", password: "a\nb" }]).success).toBe(false); // newline password
    expect(ok([{ user: "u", password: "" }]).success).toBe(false); // empty password
    expect(ok([{ user: "u", password: "x" }, { user: "u", password: "y" }]).success).toBe(false); // dup
    expect(ok(Array.from({ length: 21 }, (_, i) => ({ user: `u${i}`, password: "x" }))).success).toBe(false); // > 20
    expect(SetBasicAuthSchema.safeParse({ users: [{ user: "u", password: "x", foo: 1 }] }).success).toBe(false); // strict row
  });
});

describe("SetRedirectsSchema — custom Traefik redirect rules", () => {
  const ok = (redirects: unknown[]) => SetRedirectsSchema.safeParse({ redirects });
  it("accepts rules (incl. $ anchors + capture refs) and an empty array (clear)", () => {
    expect(ok([{ regex: "^https://x\\.com/old$", replacement: "https://x.com/new/${1}", permanent: true }]).success).toBe(true);
    expect(ok([{ regex: "^/a", replacement: "/b", permanent: false }]).success).toBe(true);
    expect(ok([]).success).toBe(true);
  });
  it("rejects empty strings, CR/LF/NUL, over-length, missing permanent, over-cap, extra keys", () => {
    expect(ok([{ regex: "", replacement: "/b", permanent: true }]).success).toBe(false); // empty regex
    expect(ok([{ regex: "/a", replacement: "", permanent: true }]).success).toBe(false); // empty replacement
    expect(ok([{ regex: "a\nb", replacement: "/b", permanent: true }]).success).toBe(false); // newline regex
    expect(ok([{ regex: "/a", replacement: "b\r", permanent: true }]).success).toBe(false); // CR replacement
    expect(ok([{ regex: "/a", replacement: "b\0c", permanent: true }]).success).toBe(false); // NUL replacement
    expect(ok([{ regex: "a".repeat(1025), replacement: "/b", permanent: true }]).success).toBe(false); // > 1024
    expect(ok([{ regex: "/a", replacement: "/b" }]).success).toBe(false); // missing permanent
    expect(ok(Array.from({ length: 21 }, () => ({ regex: "/a", replacement: "/b", permanent: true }))).success).toBe(false); // > 20
    expect(SetRedirectsSchema.safeParse({ redirects: [{ regex: "/a", replacement: "/b", permanent: true, foo: 1 }] }).success).toBe(false); // strict row
    expect(SetRedirectsSchema.safeParse({ redirects: [], foo: 1 }).success).toBe(false); // strict outer
  });
});

describe("SetExtraPortsSchema", () => {
  const ok = (ports: unknown[]) => SetExtraPortsSchema.safeParse({ ports }).success;
  it("accepts tcp/udp maps (protocol defaults to tcp) and an empty array", () => {
    expect(ok([{ hostPort: 9090, containerPort: 9090 }])).toBe(true); // protocol defaulted
    expect(ok([{ hostPort: 5353, containerPort: 53, protocol: "udp" }])).toBe(true);
    expect(ok([])).toBe(true);
    // same host port on different protocols is allowed (tcp + udp)
    expect(ok([{ hostPort: 80, containerPort: 80, protocol: "tcp" }, { hostPort: 80, containerPort: 80, protocol: "udp" }])).toBe(true);
  });
  it("rejects out-of-range ports, bad protocol, duplicate host-port+protocol, over-cap, extra keys", () => {
    expect(ok([{ hostPort: 0, containerPort: 80 }])).toBe(false);
    expect(ok([{ hostPort: 80, containerPort: 70000 }])).toBe(false);
    expect(ok([{ hostPort: 80, containerPort: 80, protocol: "sctp" }])).toBe(false);
    expect(ok([{ hostPort: 80, containerPort: 80, protocol: "tcp" }, { hostPort: 80, containerPort: 81, protocol: "tcp" }])).toBe(false); // dup host:tcp
    expect(ok(Array.from({ length: 21 }, (_, i) => ({ hostPort: 2000 + i, containerPort: 80 })))).toBe(false);
    expect(SetExtraPortsSchema.safeParse({ ports: [{ hostPort: 80, containerPort: 80, foo: 1 }] }).success).toBe(false);
  });
});

describe("SetAutoDeploySchema", () => {
  it("accepts {enabled: boolean} and rejects junk/extra keys", () => {
    expect(SetAutoDeploySchema.safeParse({ enabled: true }).success).toBe(true);
    expect(SetAutoDeploySchema.safeParse({ enabled: false }).success).toBe(true);
    expect(SetAutoDeploySchema.safeParse({}).success).toBe(false);
    expect(SetAutoDeploySchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(SetAutoDeploySchema.safeParse({ enabled: true, foo: 1 }).success).toBe(false);
  });
});

describe("SetWatchPathsSchema — monorepo deploy-trigger globs", () => {
  const ok = (watchPaths: unknown[]) => SetWatchPathsSchema.safeParse({ watchPaths });
  it("accepts glob patterns incl. negation + braces, and an empty array (clear)", () => {
    expect(ok(["apps/api/**", "!**/*.md", "packages/*/src/**", "src/**/*.{ts,tsx}"]).success).toBe(true);
    expect(ok([]).success).toBe(true);
  });
  it("rejects whitespace / shell metachars / newlines / over-length / too many / unknown keys", () => {
    expect(ok(["apps api/**"]).success).toBe(false); // space
    expect(ok(["apps/$(evil)/**"]).success).toBe(false); // $()
    expect(ok(["apps/**;rm -rf"]).success).toBe(false); // ; and space
    expect(ok(["a\n b"]).success).toBe(false); // newline
    expect(ok([""]).success).toBe(false); // empty pattern
    expect(ok(["a".repeat(257)]).success).toBe(false); // too long
    expect(ok(Array.from({ length: 51 }, () => "a/**")).success).toBe(false); // > 50
    expect(SetWatchPathsSchema.safeParse({ watchPaths: ["a/**"], foo: 1 }).success).toBe(false); // strict
  });
});

describe("CreateAppSchema — COMPOSE source (pasted vs git)", () => {
  const compose = (over: Record<string, unknown>) =>
    CreateAppSchema.safeParse({ name: "x", serverId: "s1", source: "COMPOSE", ...over });

  it("accepts a pasted compose (composeFile) and a git compose (gitUrl [+ composePath])", () => {
    expect(compose({ composeFile: "services: {}" }).success).toBe(true);
    expect(compose({ gitUrl: "https://github.com/u/r.git" }).success).toBe(true); // composePath defaulted server-side
    expect(compose({ gitUrl: "https://github.com/u/r.git", composePath: "deploy/docker-compose.yml" }).success).toBe(true);
    expect(compose({ gitUrl: "git@github.com:u/r.git", composePath: "stack.yaml" }).success).toBe(true);
  });

  it("requires exactly one of composeFile / gitUrl for a COMPOSE app", () => {
    expect(compose({}).success).toBe(false); // neither
    expect(compose({ composeFile: "services: {}", gitUrl: "https://github.com/u/r.git" }).success).toBe(false); // both
  });

  it("rejects a non-YAML or traversing composePath, and composePath without git", () => {
    expect(compose({ gitUrl: "https://github.com/u/r.git", composePath: "Dockerfile" }).success).toBe(false); // not .yml/.yaml
    expect(compose({ gitUrl: "https://github.com/u/r.git", composePath: "../escape.yml" }).success).toBe(false); // traversal
    expect(compose({ gitUrl: "https://github.com/u/r.git", composePath: "/abs/docker-compose.yml" }).success).toBe(false); // absolute
    // composePath only valid for a COMPOSE app sourced from git
    expect(CreateAppSchema.safeParse({ name: "x", serverId: "s1", source: "GIT", gitUrl: "https://github.com/u/r.git", composePath: "docker-compose.yml" }).success).toBe(false);
    expect(compose({ composeFile: "services: {}", composePath: "docker-compose.yml" }).success).toBe(false); // pasted + path
  });
});

describe("SetServiceDomainsSchema — per-service compose domains", () => {
  const ok = (domains: unknown[]) => SetServiceDomainsSchema.safeParse({ domains });
  it("accepts {service,hostname,port} rows and normalizes the host", () => {
    const r = ok([{ service: "api", hostname: "API.example.com.", port: 4000 }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.domains[0].hostname).toBe("api.example.com");
    expect(ok([]).success).toBe(true);
  });
  it("rejects bad service names, ports, IP hosts, dup hosts, over-cap, unknown keys", () => {
    expect(ok([{ service: "a b", hostname: "x.com", port: 80 }]).success).toBe(false); // space in service
    expect(ok([{ service: "api", hostname: "x.com", port: 0 }]).success).toBe(false); // port range
    expect(ok([{ service: "api", hostname: "1.2.3.4", port: 80 }]).success).toBe(false); // IP literal
    expect(ok([{ service: "a", hostname: "x.com", port: 80 }, { service: "b", hostname: "x.com", port: 81 }]).success).toBe(false); // dup host
    expect(ok(Array.from({ length: 21 }, (_, i) => ({ service: "s", hostname: `h${i}.com`, port: 80 }))).success).toBe(false); // >20
    expect(SetServiceDomainsSchema.safeParse({ domains: [{ service: "api", hostname: "x.com", port: 80, foo: 1 }] }).success).toBe(false); // strict row
  });
});

describe("SetExtraDomainsSchema — multi-domain aliases", () => {
  const ok = (domains: string[]) => SetExtraDomainsSchema.safeParse({ domains });
  it("accepts valid hostnames and normalizes case + trailing dot", () => {
    const r = ok(["Www.Example.com.", "app.example.net"]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.domains).toEqual(["www.example.com", "app.example.net"]);
    expect(ok([]).success).toBe(true); // clearing is valid
  });
  it("rejects IP literals, duplicates, over-cap, over-long labels, and injection shapes", () => {
    expect(ok(["1.2.3.4"]).success).toBe(false); // all-digit TLD → not a hostname
    expect(ok(["a.com", "A.COM"]).success).toBe(false); // duplicate after normalization
    expect(ok(Array.from({ length: 11 }, (_, i) => `a${i}.com`)).success).toBe(false); // > 10
    expect(ok([`${"a".repeat(64)}.com`]).success).toBe(false); // label > 63
    expect(ok(["a b.com"]).success).toBe(false);
    expect(ok(["a`.com"]).success).toBe(false); // backtick (Traefik rule injection)
    expect(ok(["*.example.com"]).success).toBe(false); // wildcard
    expect(SetExtraDomainsSchema.safeParse({ domains: ["a.com"], foo: 1 }).success).toBe(false); // strict
  });
});

describe("SetLimitsSchema — resource reservations", () => {
  it("accepts a reservation at or below the limit", () => {
    expect(() => SetLimitsSchema.parse({ memoryMb: 512, reserveMemoryMb: 256 })).not.toThrow();
    expect(() => SetLimitsSchema.parse({ cpus: 2, reserveCpus: 1 })).not.toThrow();
  });

  it("rejects a reservation above the limit when both are sent together", () => {
    expect(() => SetLimitsSchema.parse({ memoryMb: 256, reserveMemoryMb: 512 })).toThrow();
    expect(() => SetLimitsSchema.parse({ cpus: 1, reserveCpus: 2 })).toThrow();
  });

  it("accepts a reservation alone (no limit to cross-check against)", () => {
    expect(() => SetLimitsSchema.parse({ reserveMemoryMb: 512 })).not.toThrow();
    expect(() => SetLimitsSchema.parse({ reserveCpus: 4 })).not.toThrow();
  });
});

describe("SetSourceSchema — edit source after create", () => {
  it("accepts a git URL / branch / image and rejects bad shapes", () => {
    expect(SetSourceSchema.safeParse({ gitUrl: "https://github.com/acme/app.git", gitBranch: "main" }).success).toBe(true);
    expect(SetSourceSchema.safeParse({ gitUrl: "git@github.com:acme/app.git" }).success).toBe(true);
    expect(SetSourceSchema.safeParse({ gitSourceId: null }).success).toBe(true); // unlink
    expect(SetSourceSchema.safeParse({ image: "nginx:1.27-alpine" }).success).toBe(true);
    expect(SetSourceSchema.safeParse({}).success).toBe(false); // at least one field
    expect(SetSourceSchema.safeParse({ gitUrl: "http://github.com/x/y" }).success).toBe(false); // http not allowed
    expect(SetSourceSchema.safeParse({ gitUrl: "file:///etc/passwd" }).success).toBe(false);
    expect(SetSourceSchema.safeParse({ gitBranch: "../../evil" }).success).toBe(false); // no ..
    expect(SetSourceSchema.safeParse({ gitBranch: "-x" }).success).toBe(false); // no leading -
    expect(SetSourceSchema.safeParse({ image: "-rm nginx" }).success).toBe(false); // option injection
    expect(SetSourceSchema.safeParse({ gitUrl: "https://github.com/x/y.git", foo: 1 }).success).toBe(false); // strict
  });
  it("accepts a YAML composePath and rejects a non-YAML / traversing one", () => {
    expect(SetSourceSchema.safeParse({ composePath: "deploy/docker-compose.yml" }).success).toBe(true);
    expect(SetSourceSchema.safeParse({ composePath: "stack.yaml" }).success).toBe(true);
    expect(SetSourceSchema.safeParse({ composePath: "Dockerfile" }).success).toBe(false); // not .yml/.yaml
    expect(SetSourceSchema.safeParse({ composePath: "../x.yml" }).success).toBe(false); // traversal
  });
});

describe("BASE_DIR / baseDirectory — monorepo build root", () => {
  it("accepts clean relative subdirectories", () => {
    for (const ok of ["apps/api", "packages/web-app", "a", "a.b/c-d"]) {
      expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", baseDirectory: ok }).success).toBe(true);
    }
  });
  it("rejects absolute, traversal and non-canonical forms", () => {
    for (const bad of ["/abs", "../x", "a/../b", ".", "./a", "a/", "a//b", "x/.git", "a b", "a;b", "$(x)", "a".repeat(513)]) {
      expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", baseDirectory: bad }).success).toBe(false);
    }
  });
  it("is valid for every build type and clearable with null", () => {
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerfilePath: "Dockerfile", baseDirectory: "apps/api" }).success).toBe(true);
    expect(SetBuildSchema.safeParse({ buildType: "STATIC", buildCommand: "npm run build", outputDir: "dist", baseDirectory: "web" }).success).toBe(true);
    expect(SetBuildSchema.safeParse({ buildType: "HEROKU", baseDirectory: null }).success).toBe(true);
  });
});

describe("SetBuildSchema — edit build pack after create", () => {
  it("gates each build type's fields", () => {
    expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS" }).success).toBe(true);
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile" }).success).toBe(true);
    expect(SetBuildSchema.safeParse({ buildType: "STATIC", buildCommand: "npm run build", outputDir: "dist" }).success).toBe(true);
    // wrong-type fields are rejected
    expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", dockerfilePath: "Dockerfile" }).success).toBe(false);
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", buildCommand: "x" }).success).toBe(false);
    expect(SetBuildSchema.safeParse({ buildType: "STATIC", dockerfilePath: "Dockerfile" }).success).toBe(false);
    // path/command hardening
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerfilePath: "/etc/passwd" }).success).toBe(false); // absolute
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerfilePath: "../x/Dockerfile" }).success).toBe(false); // ..
    expect(SetBuildSchema.safeParse({ buildType: "STATIC", buildCommand: "a\nRUN evil", outputDir: "dist" }).success).toBe(false); // newline
    // dockerBuildTarget: DOCKERFILE-only, safe charset
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerBuildTarget: "production" }).success).toBe(true);
    expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", dockerBuildTarget: "production" }).success).toBe(false); // wrong type
    expect(SetBuildSchema.safeParse({ buildType: "DOCKERFILE", dockerBuildTarget: "prod stage; rm" }).success).toBe(false); // metachars
    expect(SetBuildSchema.safeParse({ buildType: "WAT" }).success).toBe(false);
    expect(SetBuildSchema.safeParse({ buildType: "NIXPACKS", foo: 1 }).success).toBe(false); // strict
  });
});

describe("SetConfigMountContentSchema — content-only mount edit", () => {
  it("accepts {target, content}, including empty content", () => {
    expect(SetConfigMountContentSchema.safeParse({ target: "/etc/redis.conf", content: "" }).success).toBe(true);
    expect(SetConfigMountContentSchema.safeParse({ target: "/etc/redis.conf", content: "appendonly yes\n" }).success).toBe(true);
  });

  it("rejects a NUL byte, oversize content, a missing target, and extra keys (selectors are immutable)", () => {
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a\0b" }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a".repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ content: "a" }).success).toBe(false);
    // .strict() blocks any attempt to change the server-controlled selectors through this endpoint
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a", serviceName: "redis" }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a", mode: "0600" }).success).toBe(false);
  });
});

describe("SetDeployHooksSchema — pre/post-deploy commands", () => {
  it("accepts commands, null (to clear), and multi-line shell", () => {
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: "npm run migrate", postDeployCommand: null }).success).toBe(true);
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: null, postDeployCommand: null }).success).toBe(true);
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: "set -e\n./migrate.sh", postDeployCommand: "curl x" }).success).toBe(true);
  });

  it("rejects a NUL byte, oversize commands, missing fields, and extra keys", () => {
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: "a\0b", postDeployCommand: null }).success).toBe(false);
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: "a".repeat(4001), postDeployCommand: null }).success).toBe(false);
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: "a" }).success).toBe(false); // postDeployCommand required (nullable)
    expect(SetDeployHooksSchema.safeParse({ preDeployCommand: null, postDeployCommand: null, foo: 1 }).success).toBe(false);
  });
});

describe("SetContainerCommandSchema — container ENTRYPOINT/CMD override", () => {
  it("accepts exec-form argv, [] (clear entrypoint) and null (image default)", () => {
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: ["sh", "-c"], containerCommand: ["node a.js"] }).success).toBe(true);
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: [], containerCommand: null }).success).toBe(true);
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: null }).success).toBe(true);
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: ["--port", "80"] }).success).toBe(true);
  });

  it("rejects a NUL/empty token, too many tokens, a non-array, missing fields and extra keys", () => {
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: ["a\0b"] }).success).toBe(false);
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: [""] }).success).toBe(false); // min(1) per token
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: Array.from({ length: 65 }, () => "x") }).success).toBe(false);
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: "sh", containerCommand: null }).success).toBe(false); // not an array
    expect(SetContainerCommandSchema.safeParse({ containerCommand: null }).success).toBe(false); // containerEntrypoint required (nullable)
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: null, foo: 1 }).success).toBe(false); // strict
  });

  it("rejects a command that is too long overall", () => {
    expect(SetContainerCommandSchema.safeParse({ containerEntrypoint: null, containerCommand: ["a".repeat(4096), "b".repeat(4096), "c".repeat(4096), "d".repeat(4096)] }).success).toBe(false);
  });
});
