import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { SortBar } from "./sort-bar";

afterEach(cleanup);
const opts = [{ key: "name" as const, label: "Name" }, { key: "status" as const, label: "Status" }];
const show = (sort: { key: "name" | "status"; dir: "asc" | "desc" } | null, onSort = vi.fn()) =>
  render(<I18nProvider><SortBar options={opts} sort={sort} onSort={onSort} /></I18nProvider>);

describe("SortBar", () => {
  it("renders one keyboard-reachable toggle per column and reports the clicked key", () => {
    const onSort = vi.fn();
    show(null, onSort);
    const btn = screen.getByRole("button", { name: /Status/ });
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onSort).toHaveBeenCalledWith("status");
  });
  it("marks only the active column pressed and announces its direction", () => {
    show({ key: "name", dir: "desc" });
    expect(screen.getByRole("button", { name: /Name/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Status/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/sorted descending/)).toBeTruthy();
  });
});
