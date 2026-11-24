import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InfoTip } from "./info-tip";

afterEach(cleanup);

describe("InfoTip", () => {
  it("names the button and describes it with the tooltip text", () => {
    render(<InfoTip label="About Seal" text="One line of explanation." />);
    const btn = screen.getByRole("button", { name: "About Seal" });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("One line of explanation.");
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
  });
  it("is keyboard reachable and Escape drops focus (hides the tip)", () => {
    render(<InfoTip label="About Seal" text="x" />);
    const btn = screen.getByRole("button", { name: "About Seal" });
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(document.activeElement).not.toBe(btn);
  });
});
