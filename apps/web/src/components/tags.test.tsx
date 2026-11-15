import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { TagChips, TagFilter, TagsCard } from "./tags";

afterEach(cleanup);

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("TagFilter", () => {
  it("toggles a tag on and off via onChange", () => {
    const onChange = vi.fn();
    const { rerender } = wrap(<TagFilter all={["prod", "api"]} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText("prod"));
    expect(onChange).toHaveBeenCalledWith(["prod"]);

    rerender(<I18nProvider><TagFilter all={["prod", "api"]} selected={["prod"]} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByText("prod"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("renders nothing when there are no tags", () => {
    const { container } = wrap(<TagFilter all={[]} selected={[]} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TagsCard", () => {
  it("adds a normalized tag and saves the new set", () => {
    const onSave = vi.fn();
    wrap(<TagsCard tags={["prod"]} canWrite onSave={onSave} />);
    const input = screen.getByPlaceholderText(/add a tag/i);
    fireEvent.change(input, { target: { value: "New API" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith(["prod", "new-api"]);
  });

  it("hides the editor for read-only members", () => {
    wrap(<TagsCard tags={["prod"]} canWrite={false} onSave={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/add a tag/i)).toBeNull();
  });
});

describe("TagChips", () => {
  it("is read-only text without onSelect", () => {
    wrap(<TagChips tags={["prod", "api"]} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("prod")).toBeTruthy();
  });

  it("renders real buttons with onSelect: click selects, aria-pressed follows `selected`", () => {
    const onSelect = vi.fn();
    wrap(<TagChips tags={["prod", "api"]} selected={["api"]} onSelect={onSelect} />);
    const prod = screen.getByRole("button", { name: "Filter by tag prod" });
    fireEvent.click(prod);
    expect(onSelect).toHaveBeenCalledWith("prod");
    expect(prod.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Filter by tag api" }).getAttribute("aria-pressed")).toBe("true");
  });
});
