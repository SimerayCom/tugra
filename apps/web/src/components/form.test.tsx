import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { Checkbox, ConfigCard, Field, FormActions, NumberInput, Select, Textarea } from "./form";

afterEach(cleanup);

// FormActions/ConfigCard call useT(); render them under the provider so labels read in English.
const wrapT = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("Select", () => {
  it("renders a disabled placeholder (not the first item's name)", () => {
    render(
      <Select value="" onChange={vi.fn()} placeholder="Pick one…"
        options={[{ value: "a", label: "Alpha" }]} />,
    );
    const ph = screen.getByText("Pick one…") as HTMLOptionElement;
    expect(ph.disabled).toBe(true);
  });

  it("autoSelectFirst preselects the only option via onChange", () => {
    const onChange = vi.fn();
    render(
      <Select value="" onChange={onChange} autoSelectFirst
        options={[{ value: "team1", label: "Team One" }]} />,
    );
    expect(onChange).toHaveBeenCalledWith("team1");
  });

  it("does not auto-select when autoSelectFirst is off", () => {
    const onChange = vi.fn();
    render(
      <Select value="" onChange={onChange}
        options={[{ value: "a", label: "Alpha" }]} />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits the chosen value on change", () => {
    const onChange = vi.fn();
    render(
      <Select value="a" onChange={onChange}
        options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Field", () => {
  it("links its label to the control via htmlFor", () => {
    render(
      <Field label="Server" htmlFor="srv">
        <input id="srv" />
      </Field>,
    );
    const label = screen.getByText("Server");
    expect(label).toHaveAttribute("for", "srv");
  });
});

describe("NumberInput / Textarea / Checkbox", () => {
  it("NumberInput is a numeric field", () => {
    render(<NumberInput aria-label="Port" value={8080} onChange={vi.fn()} />);
    const el = screen.getByLabelText("Port") as HTMLInputElement;
    expect(el.type).toBe("number");
    expect(el.getAttribute("inputmode")).toBe("numeric");
  });

  it("Textarea applies the monospace face only when mono is set", () => {
    const { rerender } = render(<Textarea aria-label="Body" value="x" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).style.fontFamily).not.toContain("mono");
    rerender(<Textarea aria-label="Body" mono value="x" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).style.fontFamily).toContain("mono");
  });

  it("Checkbox ties its label to the box and emits the next checked state", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Enabled" />);
    const box = screen.getByLabelText("Enabled") as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("FormActions", () => {
  it("disables Save when dirty is false and shows an unsaved cue when dirty", () => {
    const { rerender } = wrapT(<FormActions dirty={false} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    rerender(<I18nProvider><FormActions dirty onSave={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("shows a saving label and keeps Save disabled while saving", () => {
    wrapT(<FormActions dirty saving onSave={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Saving…" });
    expect(btn).toHaveProperty("disabled", true);
    expect(screen.queryByText("Unsaved changes")).toBeNull(); // cue hidden mid-save
  });

  it("fires onSave on click", () => {
    const onSave = vi.fn();
    wrapT(<FormActions dirty onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe("ConfigCard", () => {
  it("renders a heading, body, and a footer Save", () => {
    const onSave = vi.fn();
    wrapT(
      <ConfigCard title="Limits" desc="CPU and memory" dirty onSave={onSave}>
        <div>body</div>
      </ConfigCard>,
    );
    expect(screen.getByRole("heading", { name: "Limits" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
  });
});
