import { describe, it, expect } from "vitest";
import { SiGitea, SiNodered, SiWordpress } from "@icons-pack/react-simple-icons";
import { Boxes } from "lucide-react";
import { templateIcon } from "./template-icons";

describe("templateIcon", () => {
  it("returns the brand icon for a known template slug", () => {
    expect(templateIcon("wordpress")).toBe(SiWordpress);
  });

  it("returns brand icons for the expanded catalog slugs", () => {
    expect(templateIcon("gitea")).toBe(SiGitea);
    expect(templateIcon("node-red")).toBe(SiNodered);
    expect(templateIcon("gitea")).not.toBe(Boxes);
  });

  it("falls back to a generic glyph for unknown slugs", () => {
    expect(templateIcon("something-else")).toBe(Boxes);
  });
});
