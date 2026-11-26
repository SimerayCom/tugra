import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "../i18n/provider";
import { subscribeToast } from "../lib/toast-bus";
import { TypedConfirmField, typedMatches } from "./typed-confirm-field";

afterEach(cleanup);

function Harness({ expected, onEnter }: { expected: string; onEnter?: () => void }) {
  const [v, setV] = useState("");
  return (
    <I18nProvider>
      <form>
        <TypedConfirmField expected={expected} value={v} onChange={setV} label={`Type ${expected} to confirm`} onEnter={onEnter} />
        <button type="submit" disabled={!typedMatches(v, expected)}>go</button>
      </form>
    </I18nProvider>
  );
}

describe("TypedConfirmField", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("shows the expected text as the placeholder and keeps the label name", () => {
    render(<Harness expected="coolify-hub" />);
    const input = screen.getByLabelText("Type coolify-hub to confirm") as HTMLInputElement;
    expect(input.placeholder).toBe("coolify-hub");
    expect(input.value).toBe("");
  });

  it("copies the expected text and toasts Copied", async () => {
    const seen: string[] = [];
    const off = subscribeToast((t) => seen.push(t.message));
    render(<Harness expected="coolify-hub" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("coolify-hub"));
    await waitFor(() => expect(seen).toContain("Copied"));
    off();
  });

  it("the copy button never submits the surrounding form", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const { container } = render(<Harness expected="x" />);
    container.querySelector("form")!.addEventListener("submit", onSubmit as never);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the confirm stays disabled until the text matches exactly", () => {
    render(<Harness expected="my-app" />);
    const go = screen.getByText("go") as HTMLButtonElement;
    const input = screen.getByLabelText("Type my-app to confirm");
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "my-ap" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "my-app" } });
    expect(go.disabled).toBe(false);
  });

  it("Enter calls onEnter", () => {
    const onEnter = vi.fn();
    render(<Harness expected="a" onEnter={onEnter} />);
    fireEvent.keyDown(screen.getByLabelText("Type a to confirm"), { key: "Enter" });
    expect(onEnter).toHaveBeenCalled();
  });
});

describe("typedMatches", () => {
  it("is exact and never matches an empty expectation", () => {
    expect(typedMatches("a", "a")).toBe(true);
    expect(typedMatches("a ", "a")).toBe(false);
    expect(typedMatches("", "")).toBe(false);
  });
});
