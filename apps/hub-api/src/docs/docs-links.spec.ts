import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Repo-root artifacts (jest rootDir is src/, but __dirname resolves to the real source dir — same 4-hop
// as hub-install-script.spec.ts). This spec guards the committed docs, not runtime code.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const README = join(REPO_ROOT, "README.md");
const CLI_README = join(REPO_ROOT, "packages", "cli", "README.md");

/** Every committed markdown doc to lint — README + all docs/*.md (auto-covers new ones) + the CLI README. */
function docFiles(): string[] {
  const docs = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(DOCS_DIR, f));
  return [README, CLI_README, ...docs];
}

/** Extract link/asset targets from a markdown file, ignoring fenced code + external/anchor targets. */
function localTargets(content: string): string[] {
  const body = content.replace(/```[\s\S]*?```/g, ""); // drop fenced code (curl examples etc.)
  const targets: string[] = [];
  // Markdown links/images: [text](target) / ![alt](target); stops at whitespace (drops "title") or ).
  for (const m of body.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)) {
    targets.push(m[1].replace(/^<|>$/g, ""));
  }
  // Relative HTML assets/links (e.g. the README logo <img src="docs/assets/...">).
  for (const m of body.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    targets.push(m[1]);
  }
  return targets;
}

function isExternalOrAnchor(t: string): boolean {
  return /^(https?:|mailto:|tel:|#)/i.test(t);
}

describe("docs relative links resolve", () => {
  it("every relative markdown/asset link in README + docs/ + the CLI README points to a file that exists", () => {
    const broken: string[] = [];
    for (const file of docFiles()) {
      const dir = dirname(file);
      for (const target of localTargets(readFileSync(file, "utf8"))) {
        if (isExternalOrAnchor(target)) continue;
        const clean = target.split("#")[0].split("?")[0]; // strip #fragment / ?query
        if (!clean) continue; // was a pure fragment
        if (!existsSync(resolve(dir, clean))) {
          broken.push(`${file.replace(REPO_ROOT + "/", "")} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("docs key facts stay accurate (guards against silent drift)", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("api.md documents the real API surface", () => {
    const api = read(join(DOCS_DIR, "api.md"));
    expect(api).toContain("/api/v1");
    expect(api).toContain("/api/docs");
    expect(api).toContain("tugra_pat_");
  });

  it("the CLI README documents the real config path + login command", () => {
    const cli = read(CLI_README);
    expect(cli).toContain("~/.config/tugra");
    expect(cli).toContain("tugra login");
  });

  it("the README quick start still points at the installer", () => {
    const readme = read(README);
    expect(readme).toContain("./scripts/install.sh");
    expect(readme).toContain("--domain");
  });

  it("the README [Docs] link is repointed in-repo (not the external placeholder)", () => {
    const readme = read(README);
    expect(readme).toContain("](docs/README.md)");
    expect(readme).not.toContain("https://tugra.io/docs");
  });

  it("the README roadmap marks Public API + CLI as shipped", () => {
    const readme = read(README);
    expect(readme).toMatch(/- \[x\] Public API/);
    expect(readme).not.toMatch(/- \[ \] Public API/);
  });
});
