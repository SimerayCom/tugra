import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
});
