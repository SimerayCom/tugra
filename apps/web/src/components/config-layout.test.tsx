import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ConfigLayout, type ConfigLayoutGroup } from "./config-layout";

afterEach(cleanup);

const groups: ConfigLayoutGroup[] = [
  { key: "general", label: "General", content: <input data-testid="draft" defaultValue="" /> },
  { key: "build", label: "Build", content: <div>build body</div> },
  { key: "storage", label: "Storage", content: <div>storage body</div> },
];

/** Controlled harness mirroring how the page drives active group state. */
function Harness({ initial = "general" }: { initial?: string }) {
  const [active, setActive] = useState(initial);
  return <ConfigLayout groups={groups} active={active} onChange={setActive} navLabel="Configuration sections" />;
}

describe("ConfigLayout", () => {
  it("lists exactly the groups passed, in order", () => {
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Configuration sections" });
    const items = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(items).toEqual(["General", "Build", "Storage"]);
  });

  it("marks only the active item with aria-current=page", () => {
    render(<Harness initial="build" />);
    const nav = screen.getByRole("navigation", { name: "Configuration sections" });
    const current = within(nav).getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe("Build");
  });

  it("switches the visible panel when a nav item is clicked", () => {
    const { container } = render(<Harness />);
    const panel = (key: string) => container.querySelector<HTMLElement>(`#cfg-panel-${key}`);
    // general active at first
    expect(panel("general")!.hidden).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(panel("build")!.hidden).toBe(false);
    expect(panel("general")!.hidden).toBe(true);
  });

  it("keeps a visited panel mounted so an unsaved draft survives switching away and back", () => {
    const { container } = render(<Harness />);
    const input = screen.getByTestId<HTMLInputElement>("draft");
    fireEvent.change(input, { target: { value: "half-typed secret" } });
    // leave General for Build, then come back
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(container.querySelector<HTMLElement>("#cfg-panel-general")!.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    // same DOM node, value preserved (panel was hidden, not unmounted)
    expect(screen.getByTestId<HTMLInputElement>("draft").value).toBe("half-typed secret");
  });

  it("does not eagerly mount an unvisited panel", () => {
    const { container } = render(<Harness />);
    // storage never visited yet → its section is absent from the DOM
    expect(container.querySelector("#cfg-panel-storage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    expect(container.querySelector("#cfg-panel-storage")).not.toBeNull();
  });

  it("calls onChange with the clicked group key", () => {
    const onChange = vi.fn();
    render(<ConfigLayout groups={groups} active="general" onChange={onChange} navLabel="Configuration sections" />);
    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    expect(onChange).toHaveBeenCalledWith("storage");
  });
});
