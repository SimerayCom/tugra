import { expandBraces, globToRegExp, pushMatchesWatchPaths, parseChangedFiles } from "./watch-paths";

describe("expandBraces", () => {
  it("expands one and several brace groups, leaves plain/unbalanced patterns alone", () => {
    expect(expandBraces("apps/api/**")).toEqual(["apps/api/**"]);
    expect(expandBraces("**/*.{ts,tsx}")).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(expandBraces("{a,b}/{c,d}")).toEqual(["a/c", "a/d", "b/c", "b/d"]);
    expect(expandBraces("a{b")).toEqual(["a{b"]); // unbalanced → literal
  });
});

describe("globToRegExp", () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path);
  it("** crosses directories, * stays in a segment, ? is one non-slash char", () => {
    expect(m("apps/api/**", "apps/api/src/main.ts")).toBe(true);
    expect(m("apps/api/**", "apps/api/x")).toBe(true); // one level under also matches
    expect(m("a/**/b", "a/b")).toBe(true); // `**` between slashes matches zero intermediate dirs
    expect(m("a/**/b", "a/x/y/b")).toBe(true);
    expect(m("apps/*/main.ts", "apps/api/main.ts")).toBe(true);
    expect(m("apps/*/main.ts", "apps/api/src/main.ts")).toBe(false); // * does not cross /
    expect(m("file.?s", "file.ts")).toBe(true);
    expect(m("file.?s", "file.tsx")).toBe(false);
  });
  it("escapes regex metacharacters so dots are literal", () => {
    expect(m("a.txt", "aXtxt")).toBe(false); // the dot is literal, not any-char
    expect(m("a.txt", "a.txt")).toBe(true);
  });
});

describe("pushMatchesWatchPaths", () => {
  it("deploys when a changed file matches a positive glob, skips when none do", () => {
    const pats = ["apps/api/**", "packages/shared/**"];
    expect(pushMatchesWatchPaths(["apps/api/src/x.ts"], pats)).toBe(true);
    expect(pushMatchesWatchPaths(["apps/web/src/x.ts"], pats)).toBe(false);
    expect(pushMatchesWatchPaths(["README.md", "packages/shared/i.ts"], pats)).toBe(true); // any match wins
  });
  it("honours negation: a match excluded by a ! pattern does not count", () => {
    const pats = ["apps/api/**", "!apps/api/**/*.md"];
    expect(pushMatchesWatchPaths(["apps/api/src/x.ts"], pats)).toBe(true);
    expect(pushMatchesWatchPaths(["apps/api/docs/readme.md"], pats)).toBe(false); // only a doc changed → excluded
    expect(pushMatchesWatchPaths(["apps/api/docs/readme.md", "apps/api/src/x.ts"], pats)).toBe(true); // code also changed
  });
  it("with ONLY negations, everything-except applies", () => {
    expect(pushMatchesWatchPaths(["src/x.ts"], ["!**/*.md"])).toBe(true);
    expect(pushMatchesWatchPaths(["docs/x.md"], ["!**/*.md"])).toBe(false);
  });
  it("expands braces in patterns", () => {
    expect(pushMatchesWatchPaths(["src/a.tsx"], ["src/**/*.{ts,tsx}"])).toBe(true);
    expect(pushMatchesWatchPaths(["src/a.css"], ["src/**/*.{ts,tsx}"])).toBe(false);
  });
  it("normalizes leading slashes on both patterns and files", () => {
    expect(pushMatchesWatchPaths(["/apps/api/x.ts"], ["/apps/api/**"])).toBe(true);
  });
});

describe("parseChangedFiles", () => {
  it("unions added/modified/removed across all commits (GitHub/GitLab shape)", () => {
    const payload = {
      commits: [
        { added: ["a.ts"], modified: ["b.ts"], removed: [] },
        { added: [], modified: ["b.ts", "c.ts"], removed: ["d.ts"] },
      ],
    };
    expect(parseChangedFiles(payload)!.sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });
  it("returns null (fail-open) for no commits array, empty commits, or a fileless push", () => {
    expect(parseChangedFiles({})).toBeNull();
    expect(parseChangedFiles({ commits: [] })).toBeNull();
    expect(parseChangedFiles({ commits: [{ added: [], modified: [], removed: [] }] })).toBeNull();
    expect(parseChangedFiles("nope")).toBeNull();
  });
});
