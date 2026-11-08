import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ListCard, ListRow } from "./list";
import { SkeletonTable } from "./skeleton";
import { statusLabel } from "../lib/status";

afterEach(cleanup);

const row = (testid: string) => screen.getByTestId(testid);

describe("ListRow", () => {
  it("draws a top border only for index > 0 (no doubled first-row border)", () => {
    render(
      <ListCard>
        <ListRow index={0}><span data-testid="r0">a</span></ListRow>
        <ListRow index={1}><span data-testid="r1">b</span></ListRow>
      </ListCard>,
    );
    expect(row("r0").parentElement!.getAttribute("style")).not.toMatch(/border-top:[^;]*solid/);
    expect(row("r1").parentElement!.getAttribute("style")).toMatch(/border-top:[^;]*solid/);
  });

  it("is a static row without tg-row/pointer/focus when it does not navigate", () => {
    render(<ListRow><span data-testid="c">x</span></ListRow>);
    const el = row("c").parentElement!;
    expect(el.className).not.toContain("tg-row");
    expect(el.getAttribute("tabindex")).toBeNull();
    expect(el.style.cursor).toBe("");
  });

  it("renders a real link carrying tg-row when given href", () => {
    render(<ListRow href="/apps/1"><span>app one</span></ListRow>);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/apps/1");
    expect(link.className).toContain("tg-row");
  });

  it("navigates on click and on Enter/Space when given onClick", () => {
    const onClick = vi.fn();
    render(<ListRow onClick={onClick}><span data-testid="c">x</span></ListRow>);
    const el = screen.getByRole("link");
    expect(el.className).toContain("tg-row");
    expect(el.getAttribute("tabindex")).toBe("0");
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    fireEvent.keyDown(el, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("leaves nested controls alone (click and Enter on a button do not navigate the row)", () => {
    const onClick = vi.fn();
    const inner = vi.fn();
    render(
      <ListRow onClick={onClick}>
        <button onClick={inner}>act</button>
      </ListRow>,
    );
    const btn = screen.getByRole("button", { name: "act" });
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("tabbable={false} keeps the hover state but adds no tab stop or key handling", () => {
    const onClick = vi.fn();
    const { container } = render(<ListRow onClick={onClick} tabbable={false}><span>x</span></ListRow>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("tg-row");
    expect(el.getAttribute("tabindex")).toBeNull();
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("SkeletonTable", () => {
  it("renders the requested number of rows inside a loading status region", () => {
    render(<I18nProvider><SkeletonTable rows={3} detailed /></I18nProvider>);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.children).toHaveLength(3);
  });
});

describe("statusLabel", () => {
  const t = (k: string) => ({ "common.status.RUNNING": "Running" } as Record<string, string>)[k] ?? k;
  it("maps a known enum through t()", () => expect(statusLabel(t, "RUNNING")).toBe("Running"));
  it("falls back to the raw value for an unknown enum", () => expect(statusLabel(t, "WEIRD")).toBe("WEIRD"));
});
