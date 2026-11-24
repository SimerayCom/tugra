import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EntityColorPicker } from "./entity-color-picker";
import { I18nProvider } from "../i18n/provider";

afterEach(cleanup);

function draw(props: Partial<React.ComponentProps<typeof EntityColorPicker>> = {}) {
  const onChange = vi.fn();
  const onDismissSuggestion = vi.fn();
  render(
    <I18nProvider>
      <EntityColorPicker value={null} onChange={onChange} onDismissSuggestion={onDismissSuggestion} previewLabel="Acme" {...props} />
    </I18nProvider>,
  );
  return { onChange, onDismissSuggestion };
}

describe("EntityColorPicker", () => {
  it("offers named presets as a radiogroup and reports the chosen one", () => {
    const { onChange } = draw();
    fireEvent.click(screen.getByRole("radio", { name: "Use Blue" }));
    expect(onChange).toHaveBeenCalledWith("#0091ff");
  });

  it("marks the current value selected (and Default when none)", () => {
    draw({ value: "#46a758" });
    expect(screen.getByRole("radio", { name: "Use Green" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Use Blue" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "Default" }).getAttribute("aria-checked")).toBe("false");
  });

  it("clears back to the default accent", () => {
    const { onChange } = draw({ value: "#46a758" });
    fireEvent.click(screen.getByRole("radio", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("commits a custom hex on blur, normalised", () => {
    const { onChange } = draw();
    const input = screen.getByLabelText("Custom color (hex)");
    fireEvent.change(input, { target: { value: "ABC" } });
    expect(onChange).not.toHaveBeenCalled(); // typing alone never saves
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("#aabbcc");
  });

  it("rejects an invalid hex with an alert and does not save", () => {
    const { onChange } = draw();
    const input = screen.getByLabelText("Custom color (hex)");
    fireEvent.change(input, { target: { value: "#zzz" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("#3e63dd");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("shows an icon suggestion that is one click to accept, or skippable", () => {
    const { onChange, onDismissSuggestion } = draw({ suggestion: "#336699" });
    fireEvent.click(screen.getByRole("button", { name: "Use #336699" }));
    expect(onChange).toHaveBeenCalledWith("#336699");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismissSuggestion).toHaveBeenCalled();
  });

  it("hides the suggestion when it equals the current colour", () => {
    draw({ value: "#336699", suggestion: "#336699" });
    expect(screen.queryByRole("button", { name: "Use #336699" })).toBeNull();
  });

  it("disables every control while a save is in flight", () => {
    draw({ disabled: true });
    expect((screen.getByRole("radio", { name: "Use Blue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
