import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { IconKeyPicker, filterIconKeys } from "./icon-key-picker";

afterEach(cleanup);
const wrap = (ui: React.ReactNode, open = true) => {
  const out = render(<I18nProvider>{ui}</I18nProvider>);
  if (open) fireEvent.click(screen.getByRole("button", { name: "Choose from the icon set" }));
  return out;
};

describe("filterIconKeys", () => {
  it("returns every key for an empty query", () => {
    expect(filterIconKeys("").length).toBeGreaterThan(200);
  });
  it("matches every word as a substring, ignoring case, dashes and underscores", () => {
    expect(filterIconKeys("POSTGRES")).toContain("postgresql");
    expect(filterIconKeys("uptime kuma")).toEqual(expect.arrayContaining(["uptime-kuma"]));
    expect(filterIconKeys("uptime_kuma").every((k) => k.includes("uptime") && k.includes("kuma"))).toBe(true);
    expect(filterIconKeys("zzzz-nothing")).toEqual([]);
  });
  it("works on a given key list", () => {
    expect(filterIconKeys("ra", ["redis", "mysql", "grafana"])).toEqual(["grafana"]);
  });
});

describe("IconKeyPicker", () => {
  it("mounts no icon until it is opened, then can be closed again", () => {
    const { container } = wrap(<IconKeyPicker value="redis" onChange={() => undefined} />, false);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Choose from the icon set" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Choose from the icon set" }));
    expect(container.querySelectorAll("img").length).toBeGreaterThan(100);
    fireEvent.click(screen.getByRole("button", { name: "Hide the icon set" }));
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("lists Automatic first, marked as the current choice when nothing is picked", () => {
    wrap(<IconKeyPicker value={null} onChange={() => undefined} />);
    const auto = screen.getByRole("button", { name: "Automatic" });
    expect(auto).toHaveAttribute("aria-pressed", "true");
    const all = screen.getAllByRole("button");
    expect(all[0]).toBe(auto);
    expect(screen.getAllByRole("button", { name: /^Use / }).length).toBeGreaterThan(100);
  });

  it("calls onChange with the key of the clicked icon and marks the current pick", () => {
    const onChange = vi.fn();
    wrap(<IconKeyPicker value="redis" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Use redis" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Use postgresql" }));
    expect(onChange).toHaveBeenCalledWith("postgresql");
  });

  it("clears the pick through Automatic", () => {
    const onChange = vi.fn();
    wrap(<IconKeyPicker value="redis" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("narrows the grid with the search box and says when nothing matches", () => {
    wrap(<IconKeyPicker value={null} onChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Search icons"), { target: { value: "maria" } });
    expect(screen.getByRole("button", { name: "Use mariadb" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use redis" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search icons"), { target: { value: "qqqqq" } });
    expect(screen.getByText("No icon matches.")).toBeInTheDocument();
  });

  it("loads icons lazily at a fixed size", () => {
    const { container } = wrap(<IconKeyPicker value={null} onChange={() => undefined} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.length).toBeGreaterThan(100);
    expect(imgs.every((i) => i.getAttribute("loading") === "lazy" && i.getAttribute("width") === "24")).toBe(true);
  });

  it("does not fire while disabled and warns that a pick replaces an upload", () => {
    const onChange = vi.fn();
    wrap(<IconKeyPicker value={null} onChange={onChange} disabled hasUpload />);
    fireEvent.click(screen.getByRole("button", { name: "Use redis" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/replaces an uploaded one/)).toBeInTheDocument();
  });
});
