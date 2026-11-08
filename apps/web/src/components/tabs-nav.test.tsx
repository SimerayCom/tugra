import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Tabs } from "./tabs-nav";
import { StatusPill } from "./ui";

afterEach(cleanup);

describe("Tabs", () => {
  it("renders tabs and reports clicks", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        active="a"
        onChange={onChange}
        tabs={[
          { key: "a", label: "Overview" },
          { key: "b", label: "Logs", badge: 3 },
        ]}
      />,
    );
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // badge
    fireEvent.click(screen.getByText("Logs"));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Tabs accessibility", () => {
  const defs = [
    { key: "a", label: "Overview" },
    { key: "b", label: "Logs" },
    { key: "c", label: "Settings" },
  ];

  it("exposes tablist/tab roles with aria-selected and a roving tabindex", () => {
    render(<Tabs active="b" onChange={() => {}} tabs={defs} label="Sections" />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs[0].className).toContain("tg-tab");
  });

  it("only wires aria-controls/ids when an idPrefix is given", () => {
    const { rerender } = render(<Tabs active="a" onChange={() => {}} tabs={defs} />);
    expect(screen.getAllByRole("tab")[0].hasAttribute("aria-controls")).toBe(false);
    rerender(<Tabs active="a" onChange={() => {}} tabs={defs} idPrefix="app" />);
    const first = screen.getAllByRole("tab")[0];
    expect(first.id).toBe("app-tab-a");
    expect(first.getAttribute("aria-controls")).toBe("app-panel-a");
  });

  it("ArrowRight/ArrowLeft move+activate with wraparound; Home/End jump", () => {
    const onChange = vi.fn();
    render(<Tabs active="a" onChange={onChange} tabs={defs} />);
    // Arrow navigation is derived from the FOCUSED tab (not the `active` prop, which is fixed at "a" here).
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? screen.getAllByRole("tab")[0], { key: k });
    screen.getAllByRole("tab")[0].focus();
    key("ArrowLeft"); // from "a" wraps to the last
    expect(onChange).toHaveBeenLastCalledWith("c");
    key("ArrowRight"); // focus is now on "c": wraps to "a"
    expect(onChange).toHaveBeenLastCalledWith("a");
    key("ArrowRight"); // a stale `active` prop must not repeat the move: now "b"
    expect(onChange).toHaveBeenLastCalledWith("b");
    key("End");
    expect(onChange).toHaveBeenLastCalledWith("c");
    key("Home");
    expect(onChange).toHaveBeenLastCalledWith("a");
    key("Enter"); // unrelated key: no navigation
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it("leaves modified arrows (Alt+Arrow history) alone", () => {
    const onChange = vi.fn();
    render(<Tabs active="a" onChange={onChange} tabs={defs} />);
    const tab = screen.getAllByRole("tab")[0];
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(tab, { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(tab, { key: "ArrowLeft", metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("when `active` matches no tab and nothing is focused, ArrowRight -> first, ArrowLeft -> last", () => {
    const onChange = vi.fn();
    render(<Tabs active="zzz" onChange={onChange} tabs={defs} />);
    const strip = screen.getByRole("tablist");
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
  });

  it("moves DOM focus to the newly activated tab", () => {
    const onChange = vi.fn();
    render(<Tabs active="a" onChange={onChange} tabs={defs} />);
    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);
  });
});

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill label="RUNNING" color="#2fbf71" />);
    expect(screen.getByText("RUNNING")).toBeTruthy();
  });
});
