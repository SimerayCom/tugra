import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";
import { emitToast } from "../lib/toast-bus";
import { I18nProvider } from "../i18n/provider";

const wrap = (node: React.ReactNode) =>
  render(
    <I18nProvider>
      <ToastProvider>{node}</ToastProvider>
    </I18nProvider>,
  );

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("Saved ✓", "success")}>go</button>;
}

describe("ToastProvider / useToast", () => {
  afterEach(cleanup);

  it("shows a toast pushed via useToast", () => {
    wrap(<Trigger />);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Saved ✓")).toBeTruthy();
  });

  it("shows a toast emitted from outside React (the bus) and dismisses it", () => {
    wrap(<div />);
    act(() => emitToast("API failed", "error"));
    expect(screen.getByText("API failed")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy(); // error → assertive
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("API failed")).toBeNull();
  });
});

describe("ToastProvider auto-dismiss, pause and actions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("auto-dismisses a success toast after its TTL", () => {
    wrap(<div />);
    act(() => emitToast("Saved", "success"));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("keeps an error toast on screen longer than a success toast", () => {
    wrap(<div />);
    act(() => emitToast("Boom", "error"));
    act(() => vi.advanceTimersByTime(4000)); // a success toast would be gone by now
    expect(screen.getByText("Boom")).toBeTruthy();
    act(() => vi.advanceTimersByTime(6000)); // 10s total
    expect(screen.queryByText("Boom")).toBeNull();
  });

  it("pauses auto-dismiss while the stack is hovered, then resumes", () => {
    wrap(<div />);
    act(() => emitToast("Hover me", "success"));
    fireEvent.mouseEnter(screen.getByTestId("toast-stack"));
    act(() => vi.advanceTimersByTime(8000)); // well past the 4s TTL — still there, paused
    expect(screen.getByText("Hover me")).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId("toast-stack"));
    act(() => vi.advanceTimersByTime(4000)); // banked remaining elapses
    expect(screen.queryByText("Hover me")).toBeNull();
  });

  it("renders an action that runs its handler and dismisses the toast", () => {
    const onClick = vi.fn();
    wrap(<div />);
    act(() => emitToast("Deleted", "info", { action: { label: "Undo", onClick } }));
    fireEvent.click(screen.getByText("Undo"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("de-duplicates an identical message+type within 2s and extends the one toast's lifetime", () => {
    wrap(<div />);
    act(() => emitToast("Boom", "error"));
    act(() => vi.advanceTimersByTime(1500));
    act(() => emitToast("Boom", "error")); // the local onError twin of the global MutationCache toast
    expect(screen.getAllByText("Boom")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(9000)); // past the original 10s expiry (1.5s + 9s) — the timer was extended
    expect(screen.getByText("Boom")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByText("Boom")).toBeNull();
  });

  it("does not de-duplicate after the 2s window, across types, or different messages", () => {
    wrap(<div />);
    act(() => emitToast("Same", "error"));
    act(() => emitToast("Same", "success")); // different type
    act(() => emitToast("Other", "error")); // different message
    expect(screen.getAllByText("Same")).toHaveLength(2);
    expect(screen.getAllByText("Other")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2500));
    act(() => emitToast("Same", "error")); // window elapsed → a fresh toast
    expect(screen.getAllByText("Same")).toHaveLength(3);
  });

  it("never merges toasts that carry an action (Undo)", () => {
    wrap(<div />);
    const action = { label: "Undo", onClick: () => {} };
    act(() => emitToast("Deleted", "info", { action }));
    act(() => emitToast("Deleted", "info", { action }));
    expect(screen.getAllByText("Deleted")).toHaveLength(2);
  });
});
