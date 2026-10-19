import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { TemplateGrid } from "./template-grid";
import type { Template } from "../lib/types";

afterEach(cleanup);

const tpls: Template[] = [
  { slug: "wordpress", name: "WordPress", description: "WordPress CMS", category: "cms" },
  { slug: "ghost", name: "Ghost", description: "Publishing platform", category: "cms" },
  { slug: "n8n", name: "n8n", description: "Workflow automation", category: "automation" },
];

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("TemplateGrid", () => {
  it("renders a card per template", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    expect(screen.getByText("WordPress")).toBeTruthy();
    expect(screen.getByText("Ghost")).toBeTruthy();
    expect(screen.getByText("n8n")).toBeTruthy();
  });

  it("filters by the search query", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search the app store…"), { target: { value: "ghost" } });
    expect(screen.getByText("Ghost")).toBeTruthy();
    expect(screen.queryByText("WordPress")).toBeNull();
    expect(screen.queryByText("n8n")).toBeNull();
  });

  it("filters by a category chip", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Automation" })); // chip, not the section heading
    expect(screen.getByText("n8n")).toBeTruthy();
    expect(screen.queryByText("WordPress")).toBeNull();
  });

  it("calls onPick with the clicked template", () => {
    const onPick = vi.fn();
    wrap(<TemplateGrid templates={tpls} onPick={onPick} />);
    fireEvent.click(screen.getByText("WordPress"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ slug: "wordpress" }));
  });

  it("groups into category sections when browsing all with no search", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    // one <h2> section header per present category (cms + automation), not the chips
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    // every template still shows across the sections
    expect(screen.getByText("WordPress")).toBeTruthy();
    expect(screen.getByText("n8n")).toBeTruthy();
  });

  it("shows a flat grid (no section headings) when a category chip is active", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByText("n8n")).toBeTruthy();
    expect(screen.queryByText("WordPress")).toBeNull();
  });

  it("shows a flat grid (no section headings) when searching", () => {
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search the app store…"), { target: { value: "ghost" } });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByText("Ghost")).toBeTruthy();
    expect(screen.queryByText("WordPress")).toBeNull();
  });

  it("shows a Running badge + an Open link for a running install, and no badge for an uninstalled template", () => {
    const installed = new Map([["ghost", { count: 1, running: true, firstId: "g1", url: "https://g.example.com" }]]);
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} installed={installed} />);
    expect(screen.getByText("Running")).toBeTruthy();
    const open = screen.getByRole("link", { name: /Open/ });
    expect(open.getAttribute("href")).toBe("https://g.example.com");
    // an uninstalled template has no Installed/Running badge
    expect(screen.queryByText("Installed")).toBeNull();
  });

  it("shows an Installed badge with a count and NO Open link for a stopped install", () => {
    const installed = new Map([["n8n", { count: 2, running: false, firstId: "n1", url: null }]]);
    wrap(<TemplateGrid templates={tpls} onPick={vi.fn()} installed={installed} />);
    expect(screen.getByText("Installed ×2")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open/ })).toBeNull();
  });

  it("the Open link does not trigger the card's onPick", () => {
    const onPick = vi.fn();
    const installed = new Map([["ghost", { count: 1, running: true, firstId: "g1", url: "https://g.example.com" }]]);
    wrap(<TemplateGrid templates={tpls} onPick={onPick} installed={installed} />);
    fireEvent.click(screen.getByRole("link", { name: /Open/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  // ── CASA-UX-4: featured shelf, richer cards, detail handoff ──

  const rich: Template[] = [
    { slug: "immich", name: "Immich", description: "Long description of Immich.", category: "productivity", featured: true, tagline: "Google Photos alternative", badges: ["db"] },
    { slug: "ghost", name: "Ghost", description: "Publishing platform", category: "cms" },
  ];

  it("renders a Featured shelf (with a count) for featured templates on the unfiltered view", () => {
    wrap(<TemplateGrid templates={rich} onPick={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Featured/ })).toBeTruthy();
    // Immich (featured) appears in the Featured shelf AND its category section
    expect(screen.getAllByText("Immich").length).toBeGreaterThanOrEqual(2);
    // a non-featured template is not in the shelf (appears once, in its category)
    expect(screen.getAllByText("Ghost")).toHaveLength(1);
  });

  it("shows the tagline (not the long description) and capability badges on a card", () => {
    wrap(<TemplateGrid templates={rich} onPick={vi.fn()} />);
    expect(screen.getAllByText("Google Photos alternative").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Long description of Immich.")).toBeNull(); // long description replaced by tagline
    expect(screen.getAllByText("Database").length).toBeGreaterThanOrEqual(1); // badge_db
  });

  it("opens details (not pick) on card click when onDetails is wired; picks directly otherwise", () => {
    const onPick = vi.fn();
    const onDetails = vi.fn();
    wrap(<TemplateGrid templates={[rich[1]]} onPick={onPick} onDetails={onDetails} />); // ghost only (no shelf dup)
    fireEvent.click(screen.getByText("Ghost"));
    expect(onDetails).toHaveBeenCalledWith(expect.objectContaining({ slug: "ghost" }));
    expect(onPick).not.toHaveBeenCalled();

    cleanup();
    const onPick2 = vi.fn();
    wrap(<TemplateGrid templates={[rich[1]]} onPick={onPick2} />); // no onDetails → direct pick
    fireEvent.click(screen.getByText("Ghost"));
    expect(onPick2).toHaveBeenCalledWith(expect.objectContaining({ slug: "ghost" }));
  });
});
