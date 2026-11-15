import {
  CUID_SHAPE_RE,
  PUSH_NAME_RE,
  PUSH_TAG_RE,
  PUSH_TAG_TPL_RE,
  registryRepoOf,
  resolveAlias,
  sanitizeBranchForTag,
  validatePushName,
  validateTagTemplate,
} from "./push-ref";

describe("push-ref: custom pushed image name", () => {
  it("PUSH_NAME_RE accepts docker repository paths", () => {
    for (const ok of ["a", "my-app", "org/app_1", "a__b", "a.b", "a--b", "a/b/c/d", "x9/y-z.w"]) expect(PUSH_NAME_RE.test(ok)).toBe(true);
  });

  it("PUSH_NAME_RE rejects uppercase, dots-only, leading/trailing separators, empty components and >4 components", () => {
    for (const bad of ["A", "My-App", "..", "a..b", ".a", "-a", "_a", "a-", "a/", "/a", "a//b", "a/b/c/d/e", "a b", "a;b", "a$b", "a/..", ""]) {
      expect(PUSH_NAME_RE.test(bad)).toBe(false);
    }
  });

  it("validatePushName reserves the tugra_ prefix (first component) and enforces the length", () => {
    expect(validatePushName("my-app")).toBeNull();
    expect(validatePushName("org/tugra_x")).toBeNull(); // only the FIRST component is reserved
    expect(validatePushName("tugra_x")).toBe("reserved");
    expect(validatePushName("tugra_x/y")).toBe("reserved");
    expect(validatePushName("")).toBe("empty");
    expect(validatePushName("a".repeat(129))).toBe("too_long");
    expect(validatePushName("Bad")).toBe("bad_name");
  });
});

describe("push-ref: alias tag templates", () => {
  it("PUSH_TAG_TPL_RE accepts tag chars + the two tokens only", () => {
    for (const ok of ["latest", "stable", "v1.2", "{branch}", "{sha}", "{branch}-{sha}", "rc_{sha}"]) expect(PUSH_TAG_TPL_RE.test(ok)).toBe(true);
    for (const bad of ["a b", "a/b", "{x}", "{sha", "a:b", "$(x)", "a;b", "{ sha }", ""]) expect(PUSH_TAG_TPL_RE.test(bad)).toBe(false);
    expect(PUSH_TAG_RE.test("-bad")).toBe(false);
    expect(PUSH_TAG_RE.test("_ok")).toBe(true);
  });

  it("IMAGE apps cannot use {sha}/{branch}; COMPOSE cannot use an alias at all", () => {
    expect(validateTagTemplate("latest", "IMAGE")).toBeNull();
    expect(validateTagTemplate("{sha}", "IMAGE")).toBe("needs_git");
    expect(validateTagTemplate("{branch}", "IMAGE")).toBe("needs_git");
    expect(validateTagTemplate("latest", "COMPOSE")).toBe("compose");
    expect(validateTagTemplate("{branch}-{sha}", "GIT")).toBeNull();
  });

  it("rejects an invalid tag, and an over-long worst case after substitution", () => {
    expect(validateTagTemplate("-x", "IMAGE")).toBe("bad_tag");
    expect(validateTagTemplate("a b", "GIT")).toBe("invalid_char");
    // {branch} -> 64 + {sha} -> 12 + literal tail pushes past the 128 limit
    expect(validateTagTemplate(`${"x".repeat(60)}{branch}{sha}`, "GIT")).toBe("bad_tag");
    expect(validateTagTemplate("{branch}-{sha}", "GIT")).toBeNull(); // 64 + 1 + 12 fits
  });

  it("rejects a cuid-shaped literal (it could shadow an immutable :<deploymentId> tag)", () => {
    const cuid = "c" + "a1b2c3d4e5".repeat(2) + "abcd"; // c + 24
    expect(CUID_SHAPE_RE.test(cuid)).toBe(true);
    expect(validateTagTemplate(cuid, "IMAGE")).toBe("reserved");
    expect(validateTagTemplate(cuid, "GIT")).toBe("reserved");
    // a {sha} substitution is lower-case hex, i.e. shape-equivalent: also caught at validation time
    expect(validateTagTemplate("c{sha}abcdefghijkl", "GIT")).toBe("reserved");
    expect(validateTagTemplate("latest", "IMAGE")).toBeNull();
    expect(validateTagTemplate("Cabcdefghijabcdefghijabcd", "IMAGE")).toBeNull(); // uppercase C is not a cuid
  });

  it("sanitizeBranchForTag maps unsafe chars to '-', strips leading separators, caps at 64, may be empty", () => {
    expect(sanitizeBranchForTag("feat/x y")).toBe("feat-x-y");
    expect(sanitizeBranchForTag("main")).toBe("main");
    expect(sanitizeBranchForTag("--.x")).toBe("x");
    expect(sanitizeBranchForTag("/")).toBe("");
    expect(sanitizeBranchForTag("..")).toBe("");
    expect(sanitizeBranchForTag("a".repeat(100))).toHaveLength(64);
    expect(sanitizeBranchForTag("x;$(rm)")).toBe("x---rm-");
  });

  it("resolveAlias substitutes the branch and splits on {sha}", () => {
    expect(resolveAlias("latest", { branch: "main", source: "IMAGE" }, "cdep").parts).toEqual(["latest"]);
    expect(resolveAlias("{branch}", { branch: "feat/x", source: "GIT" }, "cdep").parts).toEqual(["feat-x"]);
    expect(resolveAlias("{branch}-{sha}", { branch: "main", source: "GIT" }, "cdep").parts).toEqual(["main-", ""]);
    expect(resolveAlias("a-{sha}-b", { branch: "main", source: "GIT" }, "cdep").parts).toEqual(["a-", "-b"]);
  });

  it("resolveAlias fails closed: empty result, cuid shape, equals the deployment id, invalid template", () => {
    expect(() => resolveAlias("{branch}", { branch: "///", source: "GIT" }, "cdep")).toThrow(/empty|invalid/);
    expect(() => resolveAlias("{branch}", { branch: "cabcdefghijklmnopqrstuvwx", source: "GIT" }, "cdep")).toThrow(/reserved/);
    expect(() => resolveAlias("same", { branch: "main", source: "IMAGE" }, "same")).toThrow(/immutable/);
    expect(() => resolveAlias("{sha}", { branch: "main", source: "IMAGE" }, "cdep")).toThrow(/not valid/);
    expect(() => resolveAlias("a b", { branch: "main", source: "GIT" }, "cdep")).toThrow(/not valid/);
  });

  it("registryRepoOf strips the trailing :<version> only (a registry port stays)", () => {
    expect(registryRepoOf("ghcr.io/org/app:v1")).toBe("ghcr.io/org/app");
    expect(registryRepoOf("localhost:5000/ns/app:v1")).toBe("localhost:5000/ns/app");
    expect(registryRepoOf("localhost:5000/ns/app")).toBe("localhost:5000/ns/app");
  });
});
