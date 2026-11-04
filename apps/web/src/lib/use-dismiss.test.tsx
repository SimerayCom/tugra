import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useDismiss } from "./use-dismiss";

afterEach(cleanup);

function Harness({ active, onClose }: { active: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(active, ref, onClose);
  return (
    <div>
      <div ref={ref} data-testid="wrap"><button data-testid="trigger">menu</button></div>
      <button data-testid="outside">outside</button>
    </div>
  );
}

describe("useDismiss", () => {
  it("closes on an outside pointer-down but not an inside one", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness active onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("trigger")); // inside the wrap → kept open
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(getByTestId("outside")); // outside → closed
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness active onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive (no listeners)", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness active={false} onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("outside"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
