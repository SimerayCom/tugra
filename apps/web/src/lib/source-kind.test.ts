import { describe, it, expect } from "vitest";
import { sourceKindLabel } from "./source-kind";

describe("sourceKindLabel", () => {
  const t = (k: string) => (k === "sources.githubApp" ? "GitHub App" : k);
  it("maps every provider kind to a display name", () => {
    expect(sourceKindLabel("github", t)).toBe("GitHub App");
    expect(sourceKindLabel("gitea", t)).toBe("Gitea");
    expect(sourceKindLabel("forgejo", t)).toBe("Forgejo");
    expect(sourceKindLabel("codeberg", t)).toBe("Codeberg");
  });
});
