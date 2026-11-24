import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EntityBadge, EntityTile, entityVars } from "./entity-identity";

afterEach(cleanup);

describe("entityVars", () => {
  it("derives light and dark tone custom props from a valid colour", () => {
    const v = entityVars("#3e63dd") as Record<string, string>;
    expect(v["--ent-solid-l"]).toBe("#3e63dd");
    expect(v["--ent-solid-d"]).toBe("#3e63dd");
    expect(v["--ent-tint-l"]).not.toBe(v["--ent-tint-d"]);
    expect(v["--ent-text-l"]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("is undefined for no colour or garbage (falls back to the neutral look)", () => {
    expect(entityVars(null)).toBeUndefined();
    expect(entityVars("not-a-color")).toBeUndefined();
  });
});

describe("EntityBadge", () => {
  it("is tinted by the colour when set", () => {
    const { container } = render(<EntityBadge color="#e5484d">Acme</EntityBadge>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ent");
    expect(el.style.getPropertyValue("--ent-solid-d")).toBe("#e5484d");
    expect(el.textContent).toBe("Acme");
  });
  it("keeps the neutral lapis pill without a colour", () => {
    const { container } = render(<EntityBadge color={null}>Acme</EntityBadge>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).not.toContain("ent");
    expect(el.textContent).toBe("Acme");
  });
});

describe("EntityTile", () => {
  it("fills with the colour and shows the glyph when there is no icon", () => {
    const { container } = render(<EntityTile color="#12a594" size={32} iconUrl={null} fallback={<i data-testid="g" />} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ent");
    expect(el.style.background).toContain("--ent-solid");
    expect(container.querySelector("[data-testid=g]")).toBeTruthy();
  });
  it("shows the uploaded icon inside a coloured ring", () => {
    const { container } = render(<EntityTile color="#12a594" size={32} iconUrl="/x.png" fallback={<i />} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/x.png");
    expect((container.firstElementChild as HTMLElement).style.border).toContain("--ent-solid");
  });
  it("is the plain tile with no colour", () => {
    const { container } = render(<EntityTile color={null} size={32} iconUrl={null} fallback={<i data-testid="g" />} />);
    expect((container.firstElementChild as HTMLElement).className).toBe("");
  });
});
