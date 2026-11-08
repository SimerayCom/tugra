import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PageTitle } from "./page-header";

afterEach(cleanup);

describe("PageTitle", () => {
  it("renders the title as an h1 with the subtitle", () => {
    render(<PageTitle title="Apps" subtitle="Deploy things" />);
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
    expect(screen.getByText("Deploy things")).toBeTruthy();
  });

  it("renders the right-hand actions slot", () => {
    render(<PageTitle title="Apps" actions={<button>New app</button>} />);
    expect(screen.getByRole("button", { name: "New app" })).toBeTruthy();
  });

  it("omits the subtitle and actions wrappers when not given", () => {
    const { container } = render(<PageTitle title="Apps" />);
    expect(container.querySelector("p")).toBeNull();
    expect(container.firstElementChild!.children).toHaveLength(1);
  });
});
