import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { TeamPicker } from "./team-picker";

afterEach(cleanup);

const teams = [
  { id: "t1", name: "Acme" },
  { id: "t2", name: "Zed" },
];
const show = (props: Partial<React.ComponentProps<typeof TeamPicker>> = {}) => {
  const onChange = vi.fn();
  render(<I18nProvider><TeamPicker value="" teams={teams} onChange={onChange} ariaLabel="Team" {...props} /></I18nProvider>);
  return onChange;
};

describe("TeamPicker", () => {
  it("offers a disabled placeholder until a team is chosen, then the teams", () => {
    show();
    const select = screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement;
    expect(select.options[0].textContent).toBe("Choose a team");
    expect(select.options[0].disabled).toBe(true);
    expect([...select.options].slice(1).map((o) => o.textContent)).toEqual(["Acme", "Zed"]);
  });

  it("reports the chosen team id", () => {
    const onChange = show({ value: "t1" });
    fireEvent.change(screen.getByRole("combobox", { name: "Team" }), { target: { value: "t2" } });
    expect(onChange).toHaveBeenCalledWith("t2");
  });

  it("can pick the first team by itself and be marked required", () => {
    const onChange = show({ autoSelectFirst: true, required: true });
    expect(onChange).toHaveBeenCalledWith("t1");
    expect((screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement).required).toBe(true);
  });

  it("does not override an existing choice", () => {
    const onChange = show({ value: "t2", autoSelectFirst: true });
    expect(onChange).not.toHaveBeenCalled();
  });
});
