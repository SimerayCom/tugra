import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { CopyBtn, CopyRow } from "./copy-row";

afterEach(cleanup);

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset();
  Object.assign(navigator, { clipboard: { writeText } });
});

const wrap = (node: React.ReactNode) =>
  render(<I18nProvider><ToastProvider>{node}</ToastProvider></I18nProvider>);

describe("CopyBtn", () => {
  it("copies the text and shows a confirmation toast", () => {
    wrap(<CopyBtn text="secret-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(screen.getByText("Copied ✓")).toBeTruthy();
  });
});

describe("CopyRow", () => {
  it("shows the value and copies it", () => {
    wrap(<CopyRow label="URL" value="https://x.test/hook" />);
    expect(screen.getByText("https://x.test/hook")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://x.test/hook");
  });

  it("masks a secret value but still copies the real one", () => {
    wrap(<CopyRow label="Password" value="hunter2" secret />);
    expect(screen.queryByText("hunter2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("hunter2");
  });

  it("reveals a secret via the eye toggle and re-masks after 30s", () => {
    vi.useFakeTimers();
    try {
      wrap(<CopyRow label="Password" value="hunter2" secret />);
      const eye = screen.getByRole("button", { name: "Show value" });
      expect(eye.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(eye);
      expect(screen.getByText("hunter2")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Hide value" }).getAttribute("aria-pressed")).toBe("true");
      act(() => { vi.advanceTimersByTime(30_001); });
      expect(screen.queryByText("hunter2")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-masks when the tab becomes hidden", () => {
    wrap(<CopyRow label="Password" value="hunter2" secret />);
    fireEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect(screen.getByText("hunter2")).toBeTruthy();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.queryByText("hunter2")).toBeNull();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("has no reveal toggle for non-secret rows", () => {
    wrap(<CopyRow label="URL" value="x" />);
    expect(screen.queryByRole("button", { name: "Show value" })).toBeNull();
  });
});
