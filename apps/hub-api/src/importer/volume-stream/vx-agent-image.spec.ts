import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKERFILE = join(__dirname, "../../../../../deploy/Dockerfile.agent");
const CI = join(__dirname, "../../../../../.github/workflows/ci.yml");

describe("agent image as the migrator's tar helper (static guards; the real `tar --sort` check runs in CI)", () => {
  const df = readFileSync(DOCKERFILE, "utf8");

  it("the runtime stage is Debian (GNU tar is Priority: required there; Alpine/busybox would not do)", () => {
    const stages = df.split(/^FROM /m).slice(1);
    const last = stages[stages.length - 1];
    expect(last.split("\n")[0]).toMatch(/^debian:/);
  });

  it("nothing in the image build removes tar", () => {
    expect(df).not.toMatch(/apt-get\s+(remove|purge)[^\n]*\btar\b/);
    expect(df).not.toMatch(/rm\s+[^\n]*\/bin\/tar/);
  });

  it("the CI docker job asserts the --sort flag against the built image and runs the migrate dockerit tests", () => {
    const ci = readFileSync(CI, "utf8");
    expect(ci).toContain("--entrypoint tar tugra-agent:it --sort=name --version");
    expect(ci).toContain("./internal/migrate/...");
  });
});
