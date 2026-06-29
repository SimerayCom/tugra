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
    fireEvent.click(screen.getByText("Automation")); // resources.cat_automation
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
});
