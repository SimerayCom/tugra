import { SetBuildSchema, SetConfigMountContentSchema, SetDeployHooksSchema, SetExtraDomainsSchema, SetLimitsSchema, SetSourceSchema } from "./dto";

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
