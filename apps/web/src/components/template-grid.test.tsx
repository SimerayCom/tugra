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
});
