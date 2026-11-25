import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TemplateLogo } from "./template-icons";

afterEach(cleanup);

describe("TemplateLogo", () => {
  it("renders the vendored svg for a slug", () => {
    render(<TemplateLogo slug="wordpress" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("/icons/wordpress.svg");
  });

  it("prefers an explicit logo name over the slug", () => {
    render(<TemplateLogo slug="some-app" logo="grafana" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("/icons/grafana.svg");
  });

  it("tries the svg, then a png, then falls back to the initials tile", () => {
    render(<TemplateLogo slug="does-not-exist" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("/icons/does-not-exist.svg");
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("img").getAttribute("src")).toBe("/icons/does-not-exist.png");
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws the initials tile without requesting an image when asked to (software with no vendored logo)", () => {
    const { container } = render(<TemplateLogo slug="coolify" name="Coolify" monogram />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByLabelText("Coolify").textContent).toBe("C");
  });
});
