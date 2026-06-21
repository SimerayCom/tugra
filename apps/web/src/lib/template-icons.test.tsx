import { describe, it, expect } from "vitest";
import { SiWordpress } from "@icons-pack/react-simple-icons";
import { Boxes } from "lucide-react";
import { templateIcon } from "./template-icons";

describe("templateIcon", () => {
  it("returns the brand icon for a known template slug", () => {
    expect(templateIcon("wordpress")).toBe(SiWordpress);
  });

  it("falls back to a generic glyph for unknown slugs", () => {
    expect(templateIcon("something-else")).toBe(Boxes);
  });
});
