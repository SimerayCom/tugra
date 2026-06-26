import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Modal } from "./modal";

afterEach(cleanup);

function wrap(onClose: () => void) {
  return render(
    <Modal onClose={onClose}>
      <button>first</button>
      <button>last</button>
    </Modal>,
  );
}

describe("Modal", () => {
  it("focuses the first focusable element on open", () => {
    wrap(vi.fn());
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    wrap(onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop mousedown but not on card mousedown", () => {
    const onClose = vi.fn();
    wrap(onClose);
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog); // inside the card → no close
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!); // backdrop → close
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus within the dialog (wraps last → first)", () => {
    wrap(vi.fn());
    const first = screen.getByText("first");
    const last = screen.getByText("last");
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from first → last", () => {
    wrap(vi.fn());
    const first = screen.getByText("first");
    const last = screen.getByText("last");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
