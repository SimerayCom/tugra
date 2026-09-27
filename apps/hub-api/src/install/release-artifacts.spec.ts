import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// Repo-root artifacts (jest rootDir is src/, but __dirname resolves to the real source dir).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const COMPOSE = join(REPO_ROOT, "deploy", "docker-compose.yml");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");

type ComposeService = { image?: string; build?: { context?: string; dockerfile?: string } };

function loadCompose(): Record<string, ComposeService> {
  return parseYaml(readFileSync(COMPOSE, "utf8")).services as Record<string, ComposeService>;
}

// Drift guard for the release pipeline: every image the pipeline builds must have a COMMITTED Dockerfile
// (the four originals live only in the gitignored local/), and the published image names must stay in
// lockstep with what install.sh pulls + what the install controller pins for the agent.
describe("release build artifacts", () => {
  const services = loadCompose();

  it("every compose build.dockerfile is committed under deploy/ and exists on disk", () => {
    const built = Object.entries(services).filter(([, s]) => s.build?.dockerfile);
    expect(built.length).toBeGreaterThanOrEqual(3); // hub, web, updater

    for (const [name, svc] of built) {
      const df = svc.build!.dockerfile!;
      // Must be committed (deploy/), never the gitignored local/ copy the pipeline can't see.
      expect(df.startsWith("deploy/")).toBe(true);
      const abs = join(REPO_ROOT, df);
      expect(existsSync(abs)).toBe(true);
      // context is repo root so `COPY . .` / `COPY agent/ ./` resolve regardless of Dockerfile location.
      expect(svc.build!.context).toBe("..");
      expect(name).toBeTruthy();
    }
  });

  it("all four release Dockerfiles are committed under deploy/", () => {
    for (const f of ["Dockerfile.hub", "Dockerfile.web", "Dockerfile.agent", "Dockerfile.updater"]) {
      expect(existsSync(join(REPO_ROOT, "deploy", f))).toBe(true);
    }
  });

  it("published image names stay in the ghcr.io/simeraycom/tugra-* namespace", () => {
    const expected: Record<string, string> = {
      "hub-api": "ghcr.io/simeraycom/tugra-hub",
      web: "ghcr.io/simeraycom/tugra-web",
      "tugra-updater": "ghcr.io/simeraycom/tugra-updater",
    };
    for (const [svc, repo] of Object.entries(expected)) {
      expect(services[svc]?.image).toContain(repo);
    }
  });

  it("the agent Dockerfile cross-compiles with a version ldflag (multi-arch + real version)", () => {
    const agent = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile.agent"), "utf8");
    expect(agent).toContain("$BUILDPLATFORM");
    expect(agent).toContain("GOARCH=${TARGETARCH");
    expect(agent).toMatch(/-X main\.Version=\$\{TUGRA_VERSION/);
  });

  it("install.sh's source-build fallback points at a committed Dockerfile (not the gitignored local/)", () => {
    const sh = readFileSync(INSTALL_SH, "utf8");
    expect(sh).toContain("deploy/Dockerfile.hub");
    expect(sh).not.toContain("local/Dockerfile.hub");
  });

  it("no committed compose/install artifact still references local/Dockerfile", () => {
    expect(readFileSync(COMPOSE, "utf8")).not.toContain("local/Dockerfile");
    expect(readFileSync(INSTALL_SH, "utf8")).not.toContain("local/Dockerfile");
  });
});
