import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { PlanAppRows } from "./plan-app-rows";

afterEach(cleanup);
const app = (n: number, over: Record<string, unknown> = {}) => ({ itemRef: `app:s1:${n}`, name: `app-${n}`, proposed: { domain: `app${n}.example.com`, ...over } });
const wrap = (apps: ReturnType<typeof app>[]) => render(<I18nProvider><PlanAppRows apps={apps} /></I18nProvider>);

describe("PlanAppRows", () => {
  it("lists each app with its icon, name and domain in monospace; the icons come from the hub, never from the site itself", () => {
    wrap([app(1, { git: { url: "https://github.com/acme/site" } }), app(2)]);
    const rows = screen.getAllByTestId("plan-app-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("app1.example.com").className).toContain("mono");
    const srcs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs.every((s) => s?.startsWith("/api/v1/migration-campaigns/icon?"))).toBe(true);
    expect(srcs.some((s) => s?.includes("kind=github&name=acme"))).toBe(true);
    expect(srcs.some((s) => s?.includes("kind=site&name=app2.example.com"))).toBe(true);
  });

  it("shows the first five and folds the rest behind 'Show all N'", () => {
    wrap(Array.from({ length: 8 }, (_, i) => app(i + 1)));
    expect(screen.getAllByTestId("plan-app-row")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 8 apps" }));
    expect(screen.getAllByTestId("plan-app-row")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByTestId("plan-app-row")).toHaveLength(5);
  });

  it("shows no button for a few apps, and nothing at all for none", () => {
    wrap([app(1), app(2)]);
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    wrap([]);
    expect(screen.queryByTestId("plan-app-rows")).toBeNull();
  });
});
