import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Field, Select } from "./form";

afterEach(cleanup);

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
