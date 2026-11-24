import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { TeamGroups } from "./team-groups";

afterEach(cleanup);

const teams = [
  { id: "t1", name: "Acme" },
  { id: "t2", name: "Zed" },
];
const items = [
  { id: "a", teamId: "t2" },
  { id: "b", teamId: "t1" },
];
const list = (rows: typeof items) => <ul>{rows.map((r) => <li key={r.id}>{`item-${r.id}`}</li>)}</ul>;
const wrap = (grouped: boolean) => render(<I18nProvider><TeamGroups items={items} teams={teams} grouped={grouped} render={list} /></I18nProvider>);

describe("TeamGroups", () => {
  it("is a plain pass-through when not grouped", () => {
    wrap(false);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("makes one collapsible section per team, in team-name order, with the item count", () => {
    wrap(true);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Acme1", "Zed1"]);
    expect(buttons[0].getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses and re-expands a section", () => {
    wrap(true);
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    expect(screen.queryByText("item-b")).toBeNull();
    expect(screen.getByText("item-a")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Acme/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    expect(screen.getByText("item-b")).toBeTruthy();
  });
});
