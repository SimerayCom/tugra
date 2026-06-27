import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";
import { emitToast } from "../lib/toast-bus";

afterEach(cleanup);

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("Saved ✓", "success")}>go</button>;
}

describe("ToastProvider / useToast", () => {
  it("shows a toast pushed via useToast", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Saved ✓")).toBeTruthy();
  });

  it("shows a toast emitted from outside React (the bus) and dismisses it", () => {
    render(<ToastProvider><div /></ToastProvider>);
    act(() => emitToast("API failed", "error"));
    const node = screen.getByText("API failed");
    expect(node).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy(); // error → assertive
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("API failed")).toBeNull();
  });
});
