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
});
