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

  it("falls back to a generic glyph when the image fails to load", () => {
    render(<TemplateLogo slug="does-not-exist" />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
  });
});
