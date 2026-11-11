import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Menu, type MenuItem } from "./menu";

afterEach(cleanup);

function items(spies?: Partial<Record<string, () => void>>): MenuItem[] {
  return [
    { key: "a", label: "Rebuild", onSelect: spies?.a ?? (() => {}) },
    { key: "b", label: "Rename", disabled: true, onSelect: spies?.b ?? (() => {}) },
    { key: "c", label: "Clone", onSelect: spies?.c ?? (() => {}) },
    { key: "d", label: "Delete", danger: true, onSelect: spies?.d ?? (() => {}) },
  ];
}

describe("Menu", () => {
  it("is closed initially and the trigger exposes the menu-button pattern", () => {
    render(<Menu items={items()} label="More actions" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click, focuses the first item and flags aria-expanded", () => {
    render(<Menu items={items()} label="More actions" />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rebuild" }));
  });

  it("trigger ArrowDown opens on the first item, ArrowUp opens on the last", () => {
    render(<Menu items={items()} label="More" />);
    const trigger = screen.getByRole("button", { name: "More" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rebuild" }));

    cleanup();
    render(<Menu items={items()} label="More" />);
    const t2 = screen.getByRole("button", { name: "More" });
    t2.focus();
    fireEvent.keyDown(t2, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
  });

  it("ArrowDown/Up roam every item (disabled included) with wraparound; Home/End jump", () => {
    render(<Menu items={items()} label="More" />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu");
    const at = (name: string) => screen.getByRole("menuitem", { name });
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // disabled "Rename" is still a focus stop
    expect(document.activeElement).toBe(at("Rename"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(at("Clone"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(at("Delete"));
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // wraps
    expect(document.activeElement).toBe(at("Rebuild"));
    fireEvent.keyDown(menu, { key: "ArrowUp" }); // wraps back
    expect(document.activeElement).toBe(at("Delete"));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(at("Rebuild"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(at("Delete"));
  });

  it("Escape closes and returns focus to the trigger", () => {
    render(<Menu items={items()} label="More" />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab closes and returns focus to the trigger", () => {
    render(<Menu items={items()} label="More" />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selecting an item fires onSelect, closes, and returns focus to the trigger", () => {
    const c = vi.fn();
    render(<Menu items={items({ c })} label="More" />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clone" }));
    expect(c).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a disabled item is aria-disabled, focusable, and activating it is a no-op (menu stays open)", () => {
    const b = vi.fn();
    render(<Menu items={items({ b })} label="More" />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(rename.hasAttribute("disabled")).toBe(false); // focusable, so its title/reason is reachable
    fireEvent.click(rename);
    expect(b).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("keeps focus on an item that becomes disabled from live state while open (no drop to <body>)", () => {
    const { rerender } = render(<Menu items={items()} label="More" />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rebuild" }));
    // The focused item's disabled flag flips (e.g. a deploy starts elsewhere) — menu + focus must survive.
    rerender(<Menu items={items().map((it) => (it.key === "a" ? { ...it, disabled: true } : it))} label="More" />);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rebuild" }));
  });

  it("renders nothing when there are no items (avoids an empty role=menu)", () => {
    render(<Menu items={[]} label="Empty" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
