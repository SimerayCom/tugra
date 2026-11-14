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

describe("Menu — link items and labelled trigger", () => {
  const linkItems = (): MenuItem[] => [
    { key: "p", label: "app.example.com", href: "https://app.example.com", title: "Primary" },
    { key: "a", label: "alias.example.com", href: "https://alias.example.com" },
    { key: "bad", label: "evil", href: "javascript:alert(1)", onSelect: () => {} },
  ];

  it("an item with an http(s) href is a real new-tab anchor", () => {
    render(<Menu items={linkItems()} label="Links" />);
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    const a = screen.getByRole("menuitem", { name: "app.example.com" }) as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("https://app.example.com");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("title")).toBe("Primary");
  });

  it("a non-http href falls back to a plain button and is never linked", () => {
    const onSelect = vi.fn();
    render(<Menu items={[{ key: "bad", label: "evil", href: "javascript:alert(1)", onSelect }]} label="Links" />);
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    const el = screen.getByRole("menuitem", { name: "evil" });
    expect(el.tagName).toBe("BUTTON");
    expect(el.getAttribute("href")).toBeNull();
    fireEvent.click(el);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("arrow keys traverse anchors and Home/End jump", () => {
    render(<Menu items={linkItems()} label="Links" />);
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "app.example.com" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "alias.example.com" }));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "evil" }));
  });

  it("Space activates a focused anchor, and clicking it closes the menu", () => {
    render(<Menu items={linkItems()} label="Links" />);
    const trigger = screen.getByRole("button", { name: "Links" });
    fireEvent.click(trigger);
    const a = screen.getByRole("menuitem", { name: "app.example.com" }) as HTMLAnchorElement;
    const click = vi.spyOn(a, "click").mockImplementation(() => {});
    fireEvent.keyDown(a, { key: " " });
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.click(a);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape from an anchor returns focus to the trigger", () => {
    render(<Menu items={linkItems()} label="Links" />);
    const trigger = screen.getByRole("button", { name: "Links" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a labelled trigger shows its text, keeps the menu-button ARIA, and the default trigger is unchanged", () => {
    render(<Menu items={linkItems()} label="Links" trigger={{ label: "Links (3)" }} />);
    const t = screen.getByRole("button", { name: "Links (3)" });
    expect(t.className).toContain("tg-btn");
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    cleanup();
    render(<Menu items={items()} label="More actions" />);
    const d = screen.getByRole("button", { name: "More actions" });
    expect(d.className).toBe("tg-iconbtn");
    expect(d.textContent).toBe("");
  });
});
