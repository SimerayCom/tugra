import { describe, it, expect } from "vitest";
import { aliasRefPreview, CUID_SHAPE_RE, PUSH_NAME_RE, PUSH_TAG_RE, PUSH_TAG_TPL_RE, registryRefPreview, sanitizeBranchForTag, validatePushName, validateTagTemplate } from "./push-ref";

// The vectors below are the SAME as apps/hub-api/src/deploy/push-ref.spec.ts: the two implementations must agree.
describe("push-ref (mirror of the hub vectors)", () => {
  it("PUSH_NAME_RE accepts docker repository paths and rejects the rest", () => {
    for (const ok of ["a", "my-app", "org/app_1", "a__b", "a.b", "a--b", "a/b/c/d", "x9/y-z.w"]) expect(PUSH_NAME_RE.test(ok)).toBe(true);
    for (const bad of ["A", "My-App", "..", "a..b", ".a", "-a", "_a", "a-", "a/", "/a", "a//b", "a/b/c/d/e", "a b", "a;b", "a$b", "a/..", ""]) expect(PUSH_NAME_RE.test(bad)).toBe(false);
  });

  it("validatePushName reserves the tugra_ prefix on the first component and enforces the length", () => {
    expect(validatePushName("my-app")).toBeNull();
    expect(validatePushName("org/tugra_x")).toBeNull();
    expect(validatePushName("tugra_x")).toBe("reserved");
    expect(validatePushName("tugra_x/y")).toBe("reserved");
    expect(validatePushName("")).toBe("empty");
    expect(validatePushName("a".repeat(129))).toBe("too_long");
    expect(validatePushName("Bad")).toBe("bad_name");
  });

  it("PUSH_TAG_TPL_RE / PUSH_TAG_RE", () => {
    for (const ok of ["latest", "stable", "v1.2", "{branch}", "{sha}", "{branch}-{sha}", "rc_{sha}"]) expect(PUSH_TAG_TPL_RE.test(ok)).toBe(true);
    for (const bad of ["a b", "a/b", "{x}", "{sha", "a:b", "$(x)", "a;b", "{ sha }", ""]) expect(PUSH_TAG_TPL_RE.test(bad)).toBe(false);
    expect(PUSH_TAG_RE.test("-bad")).toBe(false);
    expect(PUSH_TAG_RE.test("_ok")).toBe(true);
  });

  it("validateTagTemplate: IMAGE cannot use tokens, COMPOSE cannot alias, bad tag, worst-case length, cuid shape", () => {
    expect(validateTagTemplate("latest", "IMAGE")).toBeNull();
    expect(validateTagTemplate("{sha}", "IMAGE")).toBe("needs_git");
    expect(validateTagTemplate("{branch}", "IMAGE")).toBe("needs_git");
    expect(validateTagTemplate("latest", "COMPOSE")).toBe("compose");
    expect(validateTagTemplate("{branch}-{sha}", "GIT")).toBeNull();
    expect(validateTagTemplate("-x", "IMAGE")).toBe("bad_tag");
    expect(validateTagTemplate("a b", "GIT")).toBe("invalid_char");
    expect(validateTagTemplate(`${"x".repeat(60)}{branch}{sha}`, "GIT")).toBe("bad_tag");
    const cuid = "c" + "a1b2c3d4e5".repeat(2) + "abcd";
    expect(CUID_SHAPE_RE.test(cuid)).toBe(true);
    expect(validateTagTemplate(cuid, "IMAGE")).toBe("reserved");
    expect(validateTagTemplate("c{sha}abcdefghijkl", "GIT")).toBe("reserved");
    expect(validateTagTemplate("Cabcdefghijabcdefghijabcd", "IMAGE")).toBeNull();
  });

  it("sanitizeBranchForTag", () => {
    expect(sanitizeBranchForTag("feat/x y")).toBe("feat-x-y");
    expect(sanitizeBranchForTag("--.x")).toBe("x");
    expect(sanitizeBranchForTag("/")).toBe("");
    expect(sanitizeBranchForTag("a".repeat(100))).toHaveLength(64);
    expect(sanitizeBranchForTag("x;$(rm)")).toBe("x---rm-");
  });

  it("registryRefPreview equals the hub's registryImageRef (custom name, nested, slashes, username fallback, default repo)", () => {
    expect(registryRefPreview({ url: "ghcr.io", imagePrefix: "myorg" }, "abc", "web", "v1")).toBe("ghcr.io/myorg/web:v1");
    expect(registryRefPreview({ url: "ghcr.io", imagePrefix: "myorg" }, "abc", "team/api", "v1")).toBe("ghcr.io/myorg/team/api:v1");
    expect(registryRefPreview({ url: "reg.example.com/", imagePrefix: "team/" }, "abc", "web", "v2")).toBe("reg.example.com/team/web:v2");
    expect(registryRefPreview({ url: null, imagePrefix: null, username: "me" }, "abc", "web", "v1")).toBe("me/web:v1");
    expect(registryRefPreview({ url: "ghcr.io", imagePrefix: "myorg" }, "abc", null, "v1")).toBe("ghcr.io/myorg/tugra_abc:v1");
    expect(registryRefPreview({ url: "ghcr.io", imagePrefix: "myorg" }, "abc", "", "v1")).toBe("ghcr.io/myorg/tugra_abc:v1");
  });

  it("aliasRefPreview fills the tokens with sample values", () => {
    expect(aliasRefPreview({ url: "ghcr.io", imagePrefix: "o" }, "abc", "web", "{branch}-{sha}", { branch: "feat/x" })).toBe("ghcr.io/o/web:feat-x-0123456789ab");
    expect(aliasRefPreview({ url: "ghcr.io", imagePrefix: "o" }, "abc", null, "latest", { branch: "main" })).toBe("ghcr.io/o/tugra_abc:latest");
  });
});
